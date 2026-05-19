import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { CliBackendConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { MAX_IMAGE_BYTES } from "../../media/constants.js";
import { extensionForMime } from "../../media/mime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../shared/string-coerce.js";
import { buildTtsSystemPromptHint } from "../../tts/tts.js";
import { buildModelAliasLines } from "../model-alias-lines.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import { resolveOwnerDisplaySetting } from "../owner-display.js";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";
import { detectImageReferences, loadImageFromRef } from "../pi-embedded-runner/run/images.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";
import { detectRuntimeShell } from "../shell-utils.js";
import { stripSystemPromptCacheBoundary } from "../system-prompt-cache-boundary.js";
import { buildSystemPromptParams } from "../system-prompt-params.js";
import * as systemPromptModule from "../system-prompt.js";
import { sanitizeImageBlocks } from "../tool-images.js";
import { formatTomlConfigOverride } from "./toml-inline.js";
export { buildCliSupervisorScopeKey, resolveCliNoOutputTimeoutMs } from "./reliability.js";

const CLI_RUN_QUEUE = new KeyedAsyncQueue();
const SYSTEM_PROMPT_CACHE_BUCKET_MS = 60_000;
const MAX_SYSTEM_PROMPT_CACHE_ENTRIES = 64;
const SYSTEM_PROMPT_CACHE = new Map<string, string>();
let systemPromptCacheHitsForTest = 0;
let systemPromptCacheMissesForTest = 0;

function stableSerializePromptCacheValue(value: unknown, seen = new WeakSet<object>()): string {
  if (value == null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerializePromptCacheValue(entry, seen)).join(",")}]`;
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return '"[Circular]"';
    }
    seen.add(value);
    const entries = Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right));
    const serialized = `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableSerializePromptCacheValue(entryValue, seen)}`,
      )
      .join(",")}}`;
    seen.delete(value);
    return serialized;
  }
  if (typeof value === "symbol") {
    return JSON.stringify(value.description ?? "[Symbol]");
  }
  return JSON.stringify("[Function]");
}

function buildSystemPromptCacheKey(params: {
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  heartbeatPrompt?: string;
  docsPath?: string;
  tools: AgentTool[];
  contextFiles?: EmbeddedContextFile[];
  skillsPrompt?: string;
  runtimeInfo: ReturnType<typeof buildSystemPromptParams>["runtimeInfo"];
  userTimezone: string;
  userTimeFormat?: ReturnType<typeof buildSystemPromptParams>["userTimeFormat"];
  defaultModelLabel: string;
  ttsHint?: string;
  ownerDisplay: ReturnType<typeof resolveOwnerDisplaySetting>["ownerDisplay"];
  ownerDisplaySecret?: string;
  modelAliasLines: string[];
  memoryCitationsMode?: unknown;
  previousSessionId?: string;
  recentSessionHistory?: string;
  sessionCreatedAt?: number;
}): string {
  const minuteBucket = Math.floor(Date.now() / SYSTEM_PROMPT_CACHE_BUCKET_MS);
  const serialized = stableSerializePromptCacheValue({
    minuteBucket,
    workspaceDir: params.workspaceDir,
    defaultThinkLevel: params.defaultThinkLevel ?? null,
    reasoningLevel: params.reasoningLevel ?? null,
    extraSystemPrompt: params.extraSystemPrompt ?? null,
    ownerNumbers: params.ownerNumbers ?? [],
    heartbeatPrompt: params.heartbeatPrompt ?? null,
    docsPath: params.docsPath ?? null,
    runtimeInfo: params.runtimeInfo,
    userTimezone: params.userTimezone,
    userTimeFormat: params.userTimeFormat ?? null,
    defaultModelLabel: params.defaultModelLabel,
    ttsHint: params.ttsHint ?? null,
    ownerDisplay: params.ownerDisplay,
    ownerDisplaySecret: params.ownerDisplaySecret ?? null,
    modelAliasLines: params.modelAliasLines,
    memoryCitationsMode: params.memoryCitationsMode ?? null,
    tools: params.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? null,
      label: tool.label ?? null,
      parameters: tool.parameters ?? null,
    })),
    contextFiles: (params.contextFiles ?? []).map((file) => ({
      path: file.path,
      content: file.content,
    })),
    skillsPrompt: params.skillsPrompt ?? null,
    previousSessionId: params.previousSessionId ?? null,
    recentSessionHistory: params.recentSessionHistory ?? null,
    sessionCreatedAt: params.sessionCreatedAt ?? null,
  });
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function getCachedSystemPrompt(cacheKey: string): string | undefined {
  const cached = SYSTEM_PROMPT_CACHE.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  SYSTEM_PROMPT_CACHE.delete(cacheKey);
  SYSTEM_PROMPT_CACHE.set(cacheKey, cached);
  return cached;
}

function setCachedSystemPrompt(cacheKey: string, prompt: string): void {
  if (SYSTEM_PROMPT_CACHE.has(cacheKey)) {
    SYSTEM_PROMPT_CACHE.delete(cacheKey);
  }
  SYSTEM_PROMPT_CACHE.set(cacheKey, prompt);
  while (SYSTEM_PROMPT_CACHE.size > MAX_SYSTEM_PROMPT_CACHE_ENTRIES) {
    const oldestKey = SYSTEM_PROMPT_CACHE.keys().next().value;
    if (!oldestKey) {
      break;
    }
    SYSTEM_PROMPT_CACHE.delete(oldestKey);
  }
}

export function clearSystemPromptCacheForTest(): void {
  SYSTEM_PROMPT_CACHE.clear();
  systemPromptCacheHitsForTest = 0;
  systemPromptCacheMissesForTest = 0;
}

export function getSystemPromptCacheStats(): {
  size: number;
  hits: number;
  misses: number;
} {
  return {
    size: SYSTEM_PROMPT_CACHE.size,
    hits: systemPromptCacheHitsForTest,
    misses: systemPromptCacheMissesForTest,
  };
}

export const getSystemPromptCacheStatsForTest = getSystemPromptCacheStats;

function isClaudeCliProvider(providerId: string): boolean {
  return normalizeOptionalLowercaseString(providerId)?.startsWith("claude-cli") === true;
}

const CLAUDE_CLI_MAX_THINKING_TOKENS_ENV = "MAX_THINKING_TOKENS";
const CLAUDE_CLI_EFFORT_LEVEL_ENV = "CLAUDE_CODE_EFFORT_LEVEL";
const CLAUDE_CLI_DISABLE_ADAPTIVE_THINKING_ENV = "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING";
const CLAUDE_CLI_SETTINGS_ARG = "--settings";

type ClaudeCliEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

function resolveClaudeCliEffortLevel(thinkLevel?: ThinkLevel): ClaudeCliEffortLevel | undefined {
  switch (thinkLevel as ThinkLevel | "max") {
    case "off":
      return undefined;
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    case "adaptive":
    case undefined:
      return undefined;
  }
  return undefined;
}

function hasCliOption(args: string[], option: string): boolean {
  return args.some((arg) => arg === option || arg.startsWith(`${option}=`));
}

function mergeClaudeCliFastModeSetting(value: string | undefined, fastMode: boolean): string {
  if (!value || value.trim().length === 0) {
    return JSON.stringify({ fastMode });
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return JSON.stringify({ fastMode });
    }
    return JSON.stringify({
      ...parsed,
      fastMode,
    });
  } catch {
    return JSON.stringify({ fastMode });
  }
}

function applyClaudeCliFastModeSettingsArgs(args: string[], fastMode: boolean | undefined) {
  if (fastMode === undefined) {
    return args;
  }
  const normalized: string[] = [];
  let hasSettings = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === CLAUDE_CLI_SETTINGS_ARG) {
      hasSettings = true;
      const maybeValue = args[i + 1];
      if (typeof maybeValue === "string" && !maybeValue.startsWith("-")) {
        normalized.push(arg, mergeClaudeCliFastModeSetting(maybeValue, fastMode));
        i += 1;
      } else {
        normalized.push(arg, mergeClaudeCliFastModeSetting(undefined, fastMode));
      }
      continue;
    }
    if (arg.startsWith(`${CLAUDE_CLI_SETTINGS_ARG}=`)) {
      hasSettings = true;
      normalized.push(
        `${CLAUDE_CLI_SETTINGS_ARG}=${mergeClaudeCliFastModeSetting(
          arg.slice(`${CLAUDE_CLI_SETTINGS_ARG}=`.length),
          fastMode,
        )}`,
      );
      continue;
    }
    normalized.push(arg);
  }
  if (!hasSettings) {
    normalized.push(CLAUDE_CLI_SETTINGS_ARG, mergeClaudeCliFastModeSetting(undefined, fastMode));
  }
  return normalized;
}

export function applyClaudeCliThinkingEnv(params: {
  env: Record<string, string>;
  backendId?: string;
  thinkLevel?: ThinkLevel;
}): void {
  if (!params.backendId || !isClaudeCliProvider(params.backendId)) {
    return;
  }

  // OpenClaw owns thinking semantics for managed Claude CLI runs. Do not let
  // inherited shell knobs silently override the configured level.
  delete params.env[CLAUDE_CLI_EFFORT_LEVEL_ENV];
  delete params.env[CLAUDE_CLI_DISABLE_ADAPTIVE_THINKING_ENV];

  if (params.thinkLevel === "off") {
    params.env[CLAUDE_CLI_MAX_THINKING_TOKENS_ENV] = "0";
    return;
  }

  delete params.env[CLAUDE_CLI_MAX_THINKING_TOKENS_ENV];
}

export function enqueueCliRun<T>(key: string, task: () => Promise<T>): Promise<T> {
  return CLI_RUN_QUEUE.enqueue(key, task);
}

export function resolveCliRunQueueKey(params: {
  backendId: string;
  serialize?: boolean;
  runId: string;
  workspaceDir: string;
  sessionScopeKey?: string;
  cliSessionId?: string;
}): string {
  if (params.serialize === false) {
    return `${params.backendId}:${params.runId}`;
  }
  if (isClaudeCliProvider(params.backendId)) {
    const sessionScopeKey = params.sessionScopeKey?.trim();
    if (sessionScopeKey) {
      return `${params.backendId}:scope:${sessionScopeKey}`;
    }
    const sessionId = params.cliSessionId?.trim();
    if (sessionId) {
      return `${params.backendId}:session:${sessionId}`;
    }
    const workspaceDir = params.workspaceDir.trim();
    if (workspaceDir) {
      return `${params.backendId}:workspace:${workspaceDir}`;
    }
  }
  return params.backendId;
}

export function buildSystemPrompt(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  defaultThinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  heartbeatPrompt?: string;
  docsPath?: string;
  tools: AgentTool[];
  contextFiles?: EmbeddedContextFile[];
  skillsPrompt?: string;
  modelDisplay: string;
  agentId?: string;
  messageProvider?: string;
  previousSessionId?: string;
  recentSessionHistory?: string;
  sessionCreatedAt?: number;
}) {
  const defaultModelRef = resolveDefaultModelForAgent({
    cfg: params.config ?? {},
    agentId: params.agentId,
  });
  const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
  const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
    config: params.config,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    cwd: process.cwd(),
    runtime: {
      host: "openclaw",
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node: process.version,
      model: params.modelDisplay,
      defaultModel: defaultModelLabel,
      shell: detectRuntimeShell(),
      channel: params.messageProvider,
    },
  });
  const ttsHint = params.config ? buildTtsSystemPromptHint(params.config) : undefined;
  const ownerDisplay = resolveOwnerDisplaySetting(params.config);
  const modelAliasLines = buildModelAliasLines(params.config);
  const cacheKey = buildSystemPromptCacheKey({
    workspaceDir: params.workspaceDir,
    defaultThinkLevel: params.defaultThinkLevel,
    reasoningLevel: params.reasoningLevel,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    heartbeatPrompt: params.heartbeatPrompt,
    docsPath: params.docsPath,
    tools: params.tools,
    contextFiles: params.contextFiles,
    skillsPrompt: params.skillsPrompt,
    runtimeInfo,
    userTimezone,
    userTimeFormat,
    defaultModelLabel,
    ttsHint,
    ownerDisplay: ownerDisplay.ownerDisplay,
    ownerDisplaySecret: ownerDisplay.ownerDisplaySecret,
    modelAliasLines,
    memoryCitationsMode: params.config?.memory?.citations,
    previousSessionId: params.previousSessionId,
    recentSessionHistory: params.recentSessionHistory,
    sessionCreatedAt: params.sessionCreatedAt,
  });
  const cached = getCachedSystemPrompt(cacheKey);
  if (cached) {
    systemPromptCacheHitsForTest += 1;
    return cached;
  }
  systemPromptCacheMissesForTest += 1;
  const prompt = systemPromptModule.buildAgentSystemPrompt({
    workspaceDir: params.workspaceDir,
    defaultThinkLevel: params.defaultThinkLevel,
    reasoningLevel: params.reasoningLevel,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    ownerDisplay: ownerDisplay.ownerDisplay,
    ownerDisplaySecret: ownerDisplay.ownerDisplaySecret,
    reasoningTagHint: false,
    heartbeatPrompt: params.heartbeatPrompt,
    docsPath: params.docsPath,
    acpEnabled: params.config?.acp?.enabled !== false,
    runtimeInfo,
    toolNames: params.tools.map((tool) => tool.name),
    modelAliasLines,
    skillsPrompt: params.skillsPrompt,
    userTimezone,
    userTime,
    userTimeFormat,
    contextFiles: params.contextFiles,
    ttsHint,
    memoryCitationsMode: params.config?.memory?.citations,
    previousSessionId: params.previousSessionId,
    recentSessionHistory: params.recentSessionHistory,
    sessionCreatedAt: params.sessionCreatedAt,
  });
  setCachedSystemPrompt(cacheKey, prompt);
  return prompt;
}

export function normalizeCliModel(modelId: string, backend: CliBackendConfig): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return trimmed;
  }
  const direct = backend.modelAliases?.[trimmed];
  if (direct) {
    return direct;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const mapped = backend.modelAliases?.[lower];
  if (mapped) {
    return mapped;
  }
  return trimmed;
}

export function resolveSystemPromptUsage(params: {
  backend: CliBackendConfig;
  isNewSession: boolean;
  systemPrompt?: string;
}): string | null {
  const systemPrompt = params.systemPrompt?.trim();
  if (!systemPrompt) {
    return null;
  }
  const when = params.backend.systemPromptWhen ?? "first";
  if (when === "never") {
    return null;
  }
  if (when === "first" && !params.isNewSession) {
    return null;
  }
  if (
    !params.backend.systemPromptArg?.trim() &&
    !params.backend.systemPromptFileConfigArg?.trim() &&
    !params.backend.systemPromptFileConfigKey?.trim()
  ) {
    return null;
  }
  return systemPrompt;
}

export function resolveSessionIdToSend(params: {
  backend: CliBackendConfig;
  cliSessionId?: string;
}): { sessionId?: string; isNew: boolean } {
  const mode = params.backend.sessionMode ?? "always";
  const existing = params.cliSessionId?.trim();
  if (mode === "none") {
    return { sessionId: undefined, isNew: !existing };
  }
  if (mode === "existing") {
    return { sessionId: existing, isNew: !existing };
  }
  if (existing) {
    return { sessionId: existing, isNew: false };
  }
  return { sessionId: crypto.randomUUID(), isNew: true };
}

export function resolvePromptInput(params: { backend: CliBackendConfig; prompt: string }): {
  argsPrompt?: string;
  stdin?: string;
} {
  const inputMode = params.backend.input ?? "arg";
  if (inputMode === "stdin") {
    return { stdin: params.prompt };
  }
  if (params.backend.maxPromptArgChars && params.prompt.length > params.backend.maxPromptArgChars) {
    return { stdin: params.prompt };
  }
  return { argsPrompt: params.prompt };
}

function resolveCliImagePath(image: ImageContent): string {
  const ext = extensionForMime(image.mimeType) ?? ".bin";
  const digest = crypto
    .createHash("sha256")
    .update(image.mimeType)
    .update("\0")
    .update(image.data)
    .digest("hex");
  return path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-images", `${digest}${ext}`);
}

function resolveCliImageRoot(params: { backend: CliBackendConfig; workspaceDir: string }): string {
  if (params.backend.imagePathScope === "workspace") {
    return path.join(params.workspaceDir, ".openclaw-cli-images");
  }
  return path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-images");
}

export function appendImagePathsToPrompt(prompt: string, paths: string[], prefix = ""): string {
  if (!paths.length) {
    return prompt;
  }
  const trimmed = prompt.trimEnd();
  const separator = trimmed ? "\n\n" : "";
  return `${trimmed}${separator}${paths.map((entry) => `${prefix}${entry}`).join("\n")}`;
}

export async function loadPromptRefImages(params: {
  prompt: string;
  workspaceDir: string;
  maxBytes?: number;
  workspaceOnly?: boolean;
  sandbox?: { root: string; bridge: SandboxFsBridge };
}): Promise<ImageContent[]> {
  const refs = detectImageReferences(params.prompt);
  if (refs.length === 0) {
    return [];
  }

  const maxBytes = params.maxBytes ?? MAX_IMAGE_BYTES;
  const seen = new Set<string>();
  const images: ImageContent[] = [];
  for (const ref of refs) {
    const key = `${ref.type}:${ref.resolved}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const image = await loadImageFromRef(ref, params.workspaceDir, {
      maxBytes,
      workspaceOnly: params.workspaceOnly,
      sandbox: params.sandbox,
    });
    if (image) {
      images.push(image);
    }
  }

  const { images: sanitizedImages } = await sanitizeImageBlocks(images, "prompt:images", {
    maxBytes,
  });
  return sanitizedImages;
}

export async function writeCliImages(params: {
  backend: CliBackendConfig;
  workspaceDir: string;
  images: ImageContent[];
}): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  const imageRoot = resolveCliImageRoot({
    backend: params.backend,
    workspaceDir: params.workspaceDir,
  });
  await fs.mkdir(imageRoot, { recursive: true, mode: 0o700 });
  const paths: string[] = [];
  for (let i = 0; i < params.images.length; i += 1) {
    const image = params.images[i];
    const fileName = path.basename(resolveCliImagePath(image));
    const filePath = path.join(imageRoot, fileName);
    const buffer = Buffer.from(image.data, "base64");
    await fs.writeFile(filePath, buffer, { mode: 0o600 });
    paths.push(filePath);
  }
  // Keep content-addressed image paths stable across Claude CLI runs so prompt
  // text and argv don't churn on every turn with fresh temp-dir suffixes.
  const cleanup = async () => {};
  return { paths, cleanup };
}

export async function writeCliSystemPromptFile(params: {
  backend: CliBackendConfig;
  systemPrompt: string;
}): Promise<{ filePath?: string; cleanup: () => Promise<void> }> {
  if (
    !params.backend.systemPromptFileConfigArg?.trim() &&
    !params.backend.systemPromptFileConfigKey?.trim()
  ) {
    return { cleanup: async () => {} };
  }
  const tempDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-system-prompt-"),
  );
  const filePath = path.join(tempDir, "system-prompt.md");
  await fs.writeFile(filePath, stripSystemPromptCacheBoundary(params.systemPrompt), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return {
    filePath,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

export async function prepareCliPromptImagePayload(params: {
  backend: CliBackendConfig;
  prompt: string;
  workspaceDir: string;
  images?: ImageContent[];
}): Promise<{
  prompt: string;
  imagePaths?: string[];
  cleanupImages?: () => Promise<void>;
}> {
  let prompt = params.prompt;
  const resolvedImages =
    params.images && params.images.length > 0
      ? params.images
      : await loadPromptRefImages({ prompt, workspaceDir: params.workspaceDir });
  if (resolvedImages.length === 0) {
    return { prompt };
  }
  const imagePayload = await writeCliImages({
    backend: params.backend,
    workspaceDir: params.workspaceDir,
    images: resolvedImages,
  });
  const imagePaths = imagePayload.paths;
  if (
    !params.backend.imageArg ||
    params.backend.input === "stdin" ||
    params.backend.imageArg === "@"
  ) {
    prompt = appendImagePathsToPrompt(
      prompt,
      imagePaths,
      params.backend.imageArg === "@" ? "@" : "",
    );
  }
  return {
    prompt,
    imagePaths,
    cleanupImages: imagePayload.cleanup,
  };
}

export function buildCliArgs(params: {
  backend: CliBackendConfig;
  backendId?: string;
  baseArgs: string[];
  modelId: string;
  thinkLevel?: ThinkLevel;
  fastMode?: boolean;
  sessionId?: string;
  systemPrompt?: string | null;
  systemPromptFilePath?: string;
  imagePaths?: string[];
  promptArg?: string;
  useResume: boolean;
  includeSystemPromptOnResume?: boolean;
}): string[] {
  let args: string[] = [...params.baseArgs];
  const includeSystemPrompt = !params.useResume || params.includeSystemPromptOnResume === true;
  const isClaudeCliBackend = params.backendId ? isClaudeCliProvider(params.backendId) : false;
  if (params.backend.modelArg && params.modelId) {
    args.push(params.backend.modelArg, params.modelId);
  }
  const claudeCliEffort = resolveClaudeCliEffortLevel(params.thinkLevel);
  if (isClaudeCliBackend && claudeCliEffort && !hasCliOption(args, "--effort")) {
    args.push("--effort", claudeCliEffort);
  }
  if (
    includeSystemPrompt &&
    params.systemPrompt &&
    params.systemPromptFilePath &&
    params.backend.systemPromptFileConfigArg
  ) {
    if (params.backend.systemPromptFileConfigKey?.trim()) {
      args.push(
        params.backend.systemPromptFileConfigArg,
        formatTomlConfigOverride(
          params.backend.systemPromptFileConfigKey,
          params.systemPromptFilePath,
        ),
      );
    } else {
      args.push(params.backend.systemPromptFileConfigArg, params.systemPromptFilePath);
    }
  } else if (includeSystemPrompt && params.systemPrompt && params.backend.systemPromptArg) {
    args.push(params.backend.systemPromptArg, stripSystemPromptCacheBoundary(params.systemPrompt));
  }
  if (!params.useResume && params.sessionId) {
    if (params.backend.sessionArgs && params.backend.sessionArgs.length > 0) {
      for (const entry of params.backend.sessionArgs) {
        args.push(entry.replaceAll("{sessionId}", params.sessionId));
      }
    } else if (params.backend.sessionArg) {
      args.push(params.backend.sessionArg, params.sessionId);
    }
  }
  if (params.imagePaths && params.imagePaths.length > 0) {
    const mode = params.backend.imageMode ?? "repeat";
    const imageArg = params.backend.imageArg;
    if (imageArg && imageArg !== "@") {
      if (mode === "list") {
        args.push(imageArg, params.imagePaths.join(","));
      } else {
        for (const imagePath of params.imagePaths) {
          args.push(imageArg, imagePath);
        }
      }
    }
  }
  if (isClaudeCliBackend) {
    args = applyClaudeCliFastModeSettingsArgs(args, params.fastMode);
  }
  if (params.promptArg !== undefined) {
    let replacedPromptPlaceholder = false;
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "{prompt}") {
        args[i] = params.promptArg;
        replacedPromptPlaceholder = true;
      }
    }
    if (replacedPromptPlaceholder) {
      return args;
    }
    args.push(params.promptArg);
  }
  return args;
}
