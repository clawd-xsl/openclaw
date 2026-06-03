import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { buildCliColdStartPromptPrefix } from "../../agents/cli-session-context.js";
import {
  clearCliCompactionOverlay,
  clearCliSession,
  getCliCompactionOverlay,
  getCliSessionBinding,
  setCliCompactionOverlay,
} from "../../agents/cli-session.js";
import { estimateMessagesTokens } from "../../agents/compaction.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isCliProvider, normalizeProviderId } from "../../agents/model-selection.js";
import { resolveSandboxConfigForAgent, resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import {
  derivePromptTokens,
  hasNonzeroUsage,
  normalizeUsage,
  type UsageLike,
} from "../../agents/usage.js";
import {
  resolveAgentIdFromSessionKey,
  resolveFreshSessionTotalTokens,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  readClaudeCliSessionMessages,
  resolveClaudeCliSessionFilePath,
} from "../../gateway/cli-session-history.js";
import { readSessionMessages } from "../../gateway/session-utils.fs.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { resolveMemoryFlushPlan } from "../../plugins/memory-state.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { GetReplyOptions } from "../types.js";
import {
  buildEmbeddedRunExecutionParams,
  resolveModelFallbackOptions,
} from "./agent-runner-utils.js";
import {
  hasAlreadyFlushedForCurrentCompaction,
  resolveMemoryFlushContextWindowTokens,
  shouldRunMemoryFlush,
  shouldRunPreflightCompaction,
} from "./memory-flush.js";
import { readPostCompactionContext } from "./post-compaction-context.js";
import { refreshQueuedFollowupSession, type FollowupRun } from "./queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { incrementCompactionCount } from "./session-updates.js";

async function compactEmbeddedPiSessionDefault(
  ...args: Parameters<typeof import("../../agents/pi-embedded.js").compactEmbeddedPiSession>
): Promise<
  Awaited<ReturnType<typeof import("../../agents/pi-embedded.js").compactEmbeddedPiSession>>
> {
  const { compactEmbeddedPiSession } = await import("../../agents/pi-embedded.js");
  return await compactEmbeddedPiSession(...args);
}

async function runCliAgentDefault(
  ...args: Parameters<typeof import("../../agents/cli-runner.js").runCliAgent>
): Promise<Awaited<ReturnType<typeof import("../../agents/cli-runner.js").runCliAgent>>> {
  const { runCliAgent } = await import("../../agents/cli-runner.js");
  return await runCliAgent(...args);
}

async function runEmbeddedPiAgentDefault(
  ...args: Parameters<typeof import("../../agents/pi-embedded.js").runEmbeddedPiAgent>
): Promise<Awaited<ReturnType<typeof import("../../agents/pi-embedded.js").runEmbeddedPiAgent>>> {
  const { runEmbeddedPiAgent } = await import("../../agents/pi-embedded.js");
  return await runEmbeddedPiAgent(...args);
}

const memoryDeps = {
  compactEmbeddedPiSession: compactEmbeddedPiSessionDefault,
  runCliAgent: runCliAgentDefault,
  runWithModelFallback,
  runEmbeddedPiAgent: runEmbeddedPiAgentDefault,
  registerAgentRunContext,
  refreshQueuedFollowupSession,
  incrementCompactionCount,
  updateSessionStoreEntry,
  randomUUID: () => crypto.randomUUID(),
  now: () => Date.now(),
};

export function setAgentRunnerMemoryTestDeps(overrides?: Partial<typeof memoryDeps>): void {
  Object.assign(memoryDeps, {
    runWithModelFallback,
    compactEmbeddedPiSession: compactEmbeddedPiSessionDefault,
    runCliAgent: runCliAgentDefault,
    runEmbeddedPiAgent: runEmbeddedPiAgentDefault,
    registerAgentRunContext,
    refreshQueuedFollowupSession,
    incrementCompactionCount,
    updateSessionStoreEntry,
    randomUUID: () => crypto.randomUUID(),
    now: () => Date.now(),
    ...overrides,
  });
}

export function estimatePromptTokensForMemoryFlush(prompt?: string): number | undefined {
  const trimmed = normalizeOptionalString(prompt);
  if (!trimmed) {
    return undefined;
  }
  const message: AgentMessage = { role: "user", content: trimmed, timestamp: Date.now() };
  const tokens = estimateMessagesTokens([message]);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return undefined;
  }
  return Math.ceil(tokens);
}

export function resolveEffectivePromptTokens(
  basePromptTokens?: number,
  lastOutputTokens?: number,
  promptTokenEstimate?: number,
): number {
  const base = Math.max(0, basePromptTokens ?? 0);
  const output = Math.max(0, lastOutputTokens ?? 0);
  const estimate = Math.max(0, promptTokenEstimate ?? 0);
  // Flush gating projects the next input context by adding the previous
  // completion and the current user prompt estimate.
  return base + output + estimate;
}

export type SessionTranscriptUsageSnapshot = {
  promptTokens?: number;
  outputTokens?: number;
};

// Keep a generous near-threshold window so large assistant outputs still trigger
// transcript reads in time to flip memory-flush gating when needed.
const TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS = 8192;
const TRANSCRIPT_TAIL_CHUNK_BYTES = 64 * 1024;
const CLI_MEMORY_FLUSH_RETRIGGER_TOKENS = 20_000;
const CLI_PREFLIGHT_COMPACTION_RETRIGGER_TOKENS = 20_000;
const CLI_HIDDEN_USAGE_CONTEXT_RATIO = 0.8;
const CLAUDE_CLI_USAGE_PROVIDERS = new Set(["claude-cli", "claude-cli-streaming"]);

type CliNativePromptUsageSnapshot = {
  promptTokens?: number;
  cliSessionId?: string;
  source: string;
};

function parseUsageFromTranscriptLine(line: string): ReturnType<typeof normalizeUsage> | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      message?: { usage?: UsageLike };
      usage?: UsageLike;
    };
    const usageRaw = parsed.message?.usage ?? parsed.usage;
    const usage = normalizeUsage(usageRaw);
    if (usage && hasNonzeroUsage(usage)) {
      return usage;
    }
  } catch {
    // ignore bad lines
  }
  return undefined;
}

function resolveSessionLogPath(
  sessionId?: string,
  sessionEntry?: SessionEntry,
  sessionKey?: string,
  opts?: { storePath?: string },
): string | undefined {
  if (!sessionId) {
    return undefined;
  }

  try {
    const transcriptPath = normalizeOptionalString(
      (sessionEntry as (SessionEntry & { transcriptPath?: string }) | undefined)?.transcriptPath,
    );
    const sessionFile = normalizeOptionalString(sessionEntry?.sessionFile) || transcriptPath;
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const pathOpts = resolveSessionFilePathOptions({
      agentId,
      storePath: opts?.storePath,
    });
    // Normalize sessionFile through resolveSessionFilePath so relative entries
    // are resolved against the sessions dir/store layout, not process.cwd().
    return resolveSessionFilePath(
      sessionId,
      sessionFile ? { sessionFile } : sessionEntry,
      pathOpts,
    );
  } catch {
    return undefined;
  }
}

function deriveTranscriptUsageSnapshot(
  usage: ReturnType<typeof normalizeUsage> | undefined,
): SessionTranscriptUsageSnapshot | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokens = derivePromptTokens(usage);
  const outputRaw = usage.output;
  const outputTokens =
    typeof outputRaw === "number" && Number.isFinite(outputRaw) && outputRaw > 0
      ? outputRaw
      : undefined;
  if (!(typeof promptTokens === "number") && !(typeof outputTokens === "number")) {
    return undefined;
  }
  return {
    promptTokens,
    outputTokens,
  };
}

type SessionLogSnapshot = {
  byteSize?: number;
  usage?: SessionTranscriptUsageSnapshot;
};

async function appendPostCompactionRefreshPrompt(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
}): Promise<void> {
  const refreshPrompt = await readPostCompactionContext(
    params.followupRun.run.workspaceDir,
    params.cfg,
  );
  if (!refreshPrompt) {
    return;
  }

  const existingPrompt = normalizeOptionalString(params.followupRun.run.extraSystemPrompt);
  if (existingPrompt?.includes(refreshPrompt)) {
    return;
  }

  params.followupRun.run.extraSystemPrompt = [existingPrompt, refreshPrompt]
    .filter(Boolean)
    .join("\n\n");
}

async function readSessionLogSnapshot(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  opts?: { storePath?: string };
  includeByteSize: boolean;
  includeUsage: boolean;
}): Promise<SessionLogSnapshot> {
  const logPath = resolveSessionLogPath(
    params.sessionId,
    params.sessionEntry,
    params.sessionKey,
    params.opts,
  );
  if (!logPath) {
    return {};
  }

  const snapshot: SessionLogSnapshot = {};

  if (params.includeByteSize) {
    try {
      const stat = await fs.promises.stat(logPath);
      const size = Math.floor(stat.size);
      snapshot.byteSize = Number.isFinite(size) && size >= 0 ? size : undefined;
    } catch {
      snapshot.byteSize = undefined;
    }
  }

  if (params.includeUsage) {
    try {
      const lastUsage = await readLastNonzeroUsageFromSessionLog(logPath);
      snapshot.usage = deriveTranscriptUsageSnapshot(lastUsage);
    } catch {
      snapshot.usage = undefined;
    }
  }

  return snapshot;
}

async function readLastNonzeroUsageFromSessionLog(logPath: string) {
  const handle = await fs.promises.open(logPath, "r");
  try {
    const stat = await handle.stat();
    let position = stat.size;
    let leadingPartial = "";
    while (position > 0) {
      const chunkSize = Math.min(TRANSCRIPT_TAIL_CHUNK_BYTES, position);
      const start = position - chunkSize;
      const buffer = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, start);
      if (bytesRead <= 0) {
        break;
      }
      const chunk = buffer.toString("utf-8", 0, bytesRead);
      const combined = `${chunk}${leadingPartial}`;
      const lines = combined.split(/\n+/);
      leadingPartial = lines.shift() ?? "";
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const usage = parseUsageFromTranscriptLine(lines[i] ?? "");
        if (usage) {
          return usage;
        }
      }
      position = start;
    }
    return parseUsageFromTranscriptLine(leadingPartial);
  } finally {
    await handle.close();
  }
}

function estimatePromptTokensFromSessionTranscript(params: {
  sessionId?: string;
  storePath?: string;
  sessionFile?: string;
}): number | undefined {
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionId) {
    return undefined;
  }
  try {
    const messages = readSessionMessages(
      sessionId,
      params.storePath,
      params.sessionFile,
    ) as AgentMessage[];
    if (messages.length === 0) {
      return undefined;
    }
    const estimatedTokens = estimateMessagesTokens(messages);
    if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) {
      return undefined;
    }
    return Math.ceil(estimatedTokens);
  } catch {
    return undefined;
  }
}

export async function readPromptTokensFromSessionLog(
  sessionId?: string,
  sessionEntry?: SessionEntry,
  sessionKey?: string,
  opts?: { storePath?: string },
): Promise<SessionTranscriptUsageSnapshot | undefined> {
  const snapshot = await readSessionLogSnapshot({
    sessionId,
    sessionEntry,
    sessionKey,
    opts,
    includeByteSize: false,
    includeUsage: true,
  });
  return snapshot.usage;
}

function shouldRunCliPreflightCompaction(params: {
  tokenCount?: number;
  threshold: number;
  overlayPromptTokens?: number;
}): boolean {
  const tokenCount =
    typeof params.tokenCount === "number" &&
    Number.isFinite(params.tokenCount) &&
    params.tokenCount > 0
      ? Math.floor(params.tokenCount)
      : undefined;
  if (!tokenCount || tokenCount < params.threshold) {
    return false;
  }
  const overlayPromptTokens =
    typeof params.overlayPromptTokens === "number" &&
    Number.isFinite(params.overlayPromptTokens) &&
    params.overlayPromptTokens > 0
      ? Math.floor(params.overlayPromptTokens)
      : undefined;
  if (overlayPromptTokens === undefined) {
    return true;
  }
  return tokenCount >= overlayPromptTokens + CLI_PREFLIGHT_COMPACTION_RETRIGGER_TOKENS;
}

async function readCliNativePromptUsageSnapshot(params: {
  entry: SessionEntry;
  provider: string;
}): Promise<CliNativePromptUsageSnapshot> {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (!CLAUDE_CLI_USAGE_PROVIDERS.has(normalizedProvider)) {
    return { source: "native_usage_unsupported_provider" };
  }

  const cliSessionId = normalizeOptionalString(
    getCliSessionBinding(params.entry, normalizedProvider)?.sessionId,
  );
  if (!cliSessionId) {
    return { source: "claude_cli_session_missing" };
  }

  const transcriptPath = resolveClaudeCliSessionFilePath({ cliSessionId });
  if (!transcriptPath) {
    return { cliSessionId, source: "claude_cli_transcript_missing" };
  }

  try {
    const usage = await readLastNonzeroUsageFromSessionLog(transcriptPath);
    const promptTokens = derivePromptTokens(usage);
    if (typeof promptTokens !== "number" || !Number.isFinite(promptTokens) || promptTokens <= 0) {
      return { cliSessionId, source: "claude_cli_transcript_usage_missing" };
    }
    return {
      cliSessionId,
      promptTokens: Math.floor(promptTokens),
      source: "claude_cli_transcript",
    };
  } catch {
    return { cliSessionId, source: "claude_cli_transcript_unreadable" };
  }
}

type CliCompactionHistorySource =
  | { ok: true; messageCount: number; prompt: string }
  | { ok: false; reason: string };

const CLI_COMPACTION_SYSTEM_PROMPT = [
  "You summarize Claude Code session history for OpenClaw continuity.",
  "Use only the transcript provided in the user prompt.",
  "Do not call tools, inspect files, or infer unstated facts.",
  "Omit hidden reasoning and internal tool mechanics unless the result is needed for continuity.",
  "Output only the compaction summary.",
].join("\n");

function stringifyCompactionValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable value]";
  }
}

function formatCompactionContentBlock(block: unknown): string {
  if (!block || typeof block !== "object") {
    return stringifyCompactionValue(block).trim();
  }
  const record = block as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "thinking" || type === "reasoning") {
    return "";
  }
  if (type === "text") {
    return typeof record.text === "string" ? record.text.trim() : "";
  }
  if (type === "toolcall" || type === "toolCall" || type === "tool_use" || type === "toolUse") {
    const name =
      normalizeOptionalString(record.name) ??
      normalizeOptionalString(record.toolName) ??
      normalizeOptionalString(record.tool);
    const args =
      record.arguments !== undefined
        ? record.arguments
        : record.input !== undefined
          ? record.input
          : undefined;
    const argsText = stringifyCompactionValue(args).trim();
    return [`[tool call${name ? `: ${name}` : ""}]`, argsText].filter(Boolean).join("\n");
  }
  if (type === "tool_result" || type === "toolResult") {
    const name =
      normalizeOptionalString(record.name) ??
      normalizeOptionalString(record.toolName) ??
      normalizeOptionalString(record.tool);
    const resultText =
      typeof record.text === "string"
        ? record.text
        : record.content !== undefined
          ? stringifyCompactionValue(record.content)
          : stringifyCompactionValue(record);
    return [`[tool result${name ? `: ${name}` : ""}]`, resultText.trim()]
      .filter(Boolean)
      .join("\n");
  }
  const text =
    typeof record.text === "string"
      ? record.text
      : record.content !== undefined
        ? stringifyCompactionValue(record.content)
        : stringifyCompactionValue(record);
  return [`[${type || "block"}]`, text.trim()].filter(Boolean).join(" ");
}

function formatCompactionMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return stringifyCompactionValue(content).trim();
  }
  return content
    .map(formatCompactionContentBlock)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n\n");
}

function formatClaudeCliCompactionMessage(message: unknown, index: number): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  const role = record.role === "user" || record.role === "assistant" ? record.role : undefined;
  if (!role) {
    return undefined;
  }
  const content = formatCompactionMessageContent(record.content);
  if (!content) {
    return undefined;
  }
  const timestamp =
    typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
      ? new Date(record.timestamp).toISOString()
      : undefined;
  const heading = [
    `### Message ${index + 1}`,
    `role: ${role}`,
    timestamp ? `timestamp: ${timestamp}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  return `${heading}\n${content}`;
}

function buildCliCompactionPrompt(params: {
  cliSessionId: string;
  formattedMessages: string[];
}): string {
  return [
    "Summarize the Claude Code session history below so OpenClaw can continue the same conversation in a fresh CLI session.",
    "",
    "Requirements:",
    "- Preserve concrete decisions, user preferences, durable constraints/rules, pending user asks, exact identifiers, file paths, commands, errors, and current debugging state.",
    "- Preserve recent unresolved context with enough detail for the next assistant turn.",
    "- Do not include hidden thinking/reasoning traces.",
    "- Do not include a preamble, apology, or explanation of the task.",
    "- If a section has no content, write `None`.",
    "",
    "Use this Markdown shape exactly:",
    "## Decisions",
    "## Open TODOs",
    "## Constraints/Rules",
    "## Pending user asks",
    "## Exact identifiers",
    "## Useful recent context",
    "",
    `[Claude Code session id: ${params.cliSessionId}]`,
    "",
    "[Claude Code session history]",
    params.formattedMessages.join("\n\n---\n\n"),
  ].join("\n");
}

function buildCliCompactionHistorySource(params: {
  cliSessionId: string;
}): CliCompactionHistorySource {
  const messages = readClaudeCliSessionMessages({ cliSessionId: params.cliSessionId });
  if (messages.length === 0) {
    return { ok: false, reason: "claude_cli_transcript_empty" };
  }

  const formattedMessages = messages
    .map(formatClaudeCliCompactionMessage)
    .filter((message): message is string => Boolean(message));
  if (formattedMessages.length === 0) {
    return { ok: false, reason: "claude_cli_transcript_no_messages" };
  }
  return {
    ok: true,
    messageCount: formattedMessages.length,
    prompt: buildCliCompactionPrompt({
      cliSessionId: params.cliSessionId,
      formattedMessages,
    }),
  };
}

function extractCliCompactionSummary(
  result: Awaited<ReturnType<typeof runCliAgentDefault>>,
): string | undefined {
  const payloadText =
    result.payloads
      ?.map((payload) => payload.text?.trim())
      .filter((text): text is string => Boolean(text))
      .join("\n\n")
      .trim() || undefined;
  const finalText =
    typeof result.meta?.finalAssistantVisibleText === "string"
      ? result.meta.finalAssistantVisibleText.trim()
      : undefined;
  const text = payloadText ?? finalText;
  if (!text) {
    return undefined;
  }
  return text
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

async function runStandaloneCliCompaction(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  provider: string;
  model?: string;
  cliSessionId: string;
  workspaceDir: string;
  abortSignal?: AbortSignal;
}): Promise<
  | {
      ok: true;
      summary: string;
      tokensAfter?: number;
      sourceMessageCount: number;
    }
  | { ok: false; reason: string }
> {
  const source = buildCliCompactionHistorySource({ cliSessionId: params.cliSessionId });
  if (!source.ok) {
    return source;
  }

  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "openclaw-cli-standalone-compaction-"),
  );
  const tempSessionId = memoryDeps.randomUUID();
  const tempSessionFile = path.join(tempDir, `${tempSessionId}.jsonl`);
  try {
    await fs.promises.writeFile(tempSessionFile, "", "utf8");
    const result = await memoryDeps.runCliAgent({
      sessionId: tempSessionId,
      agentId: params.followupRun.run.agentId,
      sessionFile: tempSessionFile,
      workspaceDir: params.workspaceDir,
      config: params.cfg,
      prompt: source.prompt,
      provider: params.provider,
      model: params.model,
      thinkLevel: params.followupRun.run.thinkLevel,
      fastMode: params.followupRun.run.fastMode,
      reasoningLevel: params.followupRun.run.reasoningLevel,
      timeoutMs: params.followupRun.run.timeoutMs,
      runId: `${tempSessionId}:cli-compaction`,
      extraSystemPrompt: CLI_COMPACTION_SYSTEM_PROMPT,
      authProfileId: params.followupRun.run.authProfileId,
      senderIsOwner: params.followupRun.run.senderIsOwner,
      abortSignal: params.abortSignal,
    });
    const summary = extractCliCompactionSummary(result);
    if (!summary) {
      return { ok: false, reason: "cli_compaction_empty_summary" };
    }
    const tokensAfter = estimatePromptTokensForMemoryFlush(summary);
    return {
      ok: true,
      summary,
      ...(typeof tokensAfter === "number" && tokensAfter > 0
        ? { tokensAfter: Math.floor(tokensAfter) }
        : {}),
      sourceMessageCount: source.messageCount,
    };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function resolveCliSessionUsageThreshold(params: {
  contextWindowTokens: number;
  transcriptThreshold: number;
}): number {
  const hiddenUsageThreshold = Math.floor(
    params.contextWindowTokens * CLI_HIDDEN_USAGE_CONTEXT_RATIO,
  );
  return Math.max(1, Math.min(params.transcriptThreshold, hiddenUsageThreshold));
}

async function persistCliCompactionOverlayUpdate(params: {
  entry: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  mutate: (entry: SessionEntry) => void;
}): Promise<SessionEntry> {
  const nextEntry = { ...params.entry };
  params.mutate(nextEntry);
  if (params.sessionStore && params.sessionKey) {
    params.sessionStore[params.sessionKey] = nextEntry;
  }
  if (params.storePath && params.sessionKey) {
    try {
      const updated = await memoryDeps.updateSessionStoreEntry({
        storePath: params.storePath,
        sessionKey: params.sessionKey,
        update: async (existing) => {
          const mutable = { ...existing };
          params.mutate(mutable);
          return mutable;
        },
      });
      if (updated) {
        if (params.sessionStore) {
          params.sessionStore[params.sessionKey] = updated;
        }
        return updated;
      }
    } catch (err) {
      logVerbose(`failed to persist CLI compaction overlay update: ${String(err)}`);
    }
  }
  return nextEntry;
}

async function runCliPreflightCompactionIfNeeded(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  promptForEstimate?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  replyOperation: ReplyOperation;
}): Promise<SessionEntry | undefined> {
  if (!params.sessionKey) {
    return params.sessionEntry;
  }

  let entry =
    params.sessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  if (!entry?.sessionId) {
    return entry ?? params.sessionEntry;
  }

  const provider = params.followupRun.run.provider;
  const promptText = params.promptForEstimate ?? params.followupRun.prompt;
  let overlay = getCliCompactionOverlay(entry, provider);
  const prefixResult = buildCliColdStartPromptPrefix({
    providerId: provider,
    sessionId: entry.sessionId,
    sessionFile: entry.sessionFile ?? params.followupRun.run.sessionFile,
    currentPrompt: promptText,
    overlay,
  });
  if (overlay && prefixResult.overlayInvalidReason) {
    entry = await persistCliCompactionOverlayUpdate({
      entry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      mutate: (mutable) => {
        clearCliCompactionOverlay(mutable, provider);
      },
    });
    overlay = undefined;
  }

  const promptPrefix = prefixResult.promptPrefix;
  if (!promptPrefix) {
    logVerbose(
      `preflightCompaction check: sessionKey=${params.sessionKey} tokenCount=undefined ` +
        `reason=no_cli_bootstrap provider=${provider}`,
    );
    return entry ?? params.sessionEntry;
  }

  const tokenCountForCompaction = estimatePromptTokensForMemoryFlush(
    `${promptPrefix}${promptText}`,
  );
  const contextWindowTokens = resolveMemoryFlushContextWindowTokens({
    cfg: params.cfg,
    provider,
    modelId: params.followupRun.run.model ?? params.defaultModel,
    agentCfgContextTokens: params.agentCfgContextTokens,
  });
  const memoryFlushPlan = resolveMemoryFlushPlan({ cfg: params.cfg });
  const reserveTokensFloor =
    memoryFlushPlan?.reserveTokensFloor ??
    params.cfg.agents?.defaults?.compaction?.reserveTokensFloor ??
    20_000;
  const softThresholdTokens = memoryFlushPlan?.softThresholdTokens ?? 4_000;
  const threshold = contextWindowTokens - reserveTokensFloor - softThresholdTokens;
  const overlayPromptTokens = overlay?.compactedAtPromptTokens;
  const cliNativeUsage = await readCliNativePromptUsageSnapshot({ entry, provider });
  const cliSessionUsageTokens = cliNativeUsage.promptTokens;
  const cliSessionUsageThreshold = resolveCliSessionUsageThreshold({
    contextWindowTokens,
    transcriptThreshold: threshold,
  });
  const compactionGateTokens = cliSessionUsageTokens;
  const compactionGateThreshold = cliSessionUsageThreshold;
  const compactionGateSource = cliNativeUsage.source;

  logVerbose(
    `preflightCompaction check: sessionKey=${params.sessionKey} ` +
      `tokenCount=${tokenCountForCompaction ?? "undefined"} contextWindow=${contextWindowTokens} ` +
      `threshold=${threshold} isHeartbeat=false isCli=true ` +
      `overlay=${overlay ? "yes" : "no"} overlayInvalidReason=${prefixResult.overlayInvalidReason ?? "none"} ` +
      `overlayPromptTokens=${overlayPromptTokens ?? "undefined"} ` +
      `cliSessionId=${cliNativeUsage.cliSessionId ?? "undefined"} ` +
      `cliSessionUsageTokens=${cliSessionUsageTokens ?? "undefined"} ` +
      `cliSessionUsageThreshold=${cliSessionUsageThreshold} ` +
      `gateSource=${compactionGateSource} gateTokens=${compactionGateTokens ?? "undefined"} ` +
      `gateThreshold=${compactionGateThreshold} promptPrefixChars=${promptPrefix.length}`,
  );

  const shouldCompact = shouldRunCliPreflightCompaction({
    tokenCount: compactionGateTokens,
    threshold: compactionGateThreshold,
    // CLI preflight compaction is gated by Claude Code's native transcript
    // usage, not OpenClaw-maintained session usage.
    overlayPromptTokens: undefined,
  });
  if (!shouldCompact) {
    return entry ?? params.sessionEntry;
  }

  const sessionFile = resolveSessionLogPath(
    entry.sessionId,
    entry.sessionFile ? entry : { ...entry, sessionFile: params.followupRun.run.sessionFile },
    params.sessionKey ?? params.followupRun.run.sessionKey,
    { storePath: params.storePath },
  );
  if (!sessionFile) {
    return entry ?? params.sessionEntry;
  }

  logVerbose(
    `preflightCompaction triggered: sessionKey=${params.sessionKey} ` +
      `tokenCount=${compactionGateTokens ?? "undefined"} threshold=${compactionGateThreshold} cli=true ` +
      `gateSource=${compactionGateSource} transcriptTokens=${tokenCountForCompaction ?? "undefined"} ` +
      `cliSessionUsageTokens=${cliSessionUsageTokens ?? "undefined"}`,
  );
  const effectiveTokenCountForCompaction = Math.max(
    tokenCountForCompaction ?? 0,
    cliSessionUsageTokens ?? 0,
  );

  params.replyOperation.setPhase("preflight_compacting");
  if (!cliNativeUsage.cliSessionId) {
    logVerbose(
      `preflightCompaction skipped: sessionKey=${params.sessionKey} reason=claude_cli_session_missing cli=true`,
    );
    return entry ?? params.sessionEntry;
  }
  const result = await runStandaloneCliCompaction({
    cfg: params.cfg,
    followupRun: params.followupRun,
    provider,
    model: params.followupRun.run.model,
    cliSessionId: cliNativeUsage.cliSessionId,
    workspaceDir: params.followupRun.run.workspaceDir,
    abortSignal: params.replyOperation.abortSignal,
  });

  if (!result.ok) {
    logVerbose(
      `preflightCompaction skipped: sessionKey=${params.sessionKey} reason=${result.reason} cli=true`,
    );
    return entry ?? params.sessionEntry;
  }
  if (!result.summary.trim()) {
    logVerbose(
      `preflightCompaction skipped: sessionKey=${params.sessionKey} reason=cli_compaction_empty_summary cli=true`,
    );
    return entry ?? params.sessionEntry;
  }
  logVerbose(
    `preflightCompaction summarized: sessionKey=${params.sessionKey} cli=true ` +
      `sourceMessages=${result.sourceMessageCount} summaryChars=${result.summary.length}`,
  );

  const updatedAt = memoryDeps.now();
  const nextOverlay = {
    provider,
    summary: result.summary.trim(),
    ...(effectiveTokenCountForCompaction > 0
      ? { tokensBefore: Math.floor(effectiveTokenCountForCompaction) }
      : {}),
    ...(typeof result.tokensAfter === "number" && result.tokensAfter > 0
      ? { tokensAfter: Math.floor(result.tokensAfter) }
      : {}),
    contextWindowTokens,
    thresholdTokens: compactionGateThreshold,
    createdAt: overlay?.createdAt ?? updatedAt,
    updatedAt,
  };
  const compactedPrefix = buildCliColdStartPromptPrefix({
    providerId: provider,
    sessionId: entry.sessionId,
    sessionFile: entry.sessionFile ?? params.followupRun.run.sessionFile,
    currentPrompt: promptText,
    overlay: nextOverlay,
  }).promptPrefix;
  const compactedAtPromptTokens = compactedPrefix
    ? estimatePromptTokensForMemoryFlush(`${compactedPrefix}${promptText}`)
    : undefined;

  entry = await persistCliCompactionOverlayUpdate({
    entry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    mutate: (mutable) => {
      clearCliSession(mutable, provider);
      setCliCompactionOverlay(mutable, provider, {
        ...nextOverlay,
        ...(typeof compactedAtPromptTokens === "number" && compactedAtPromptTokens > 0
          ? { compactedAtPromptTokens: Math.floor(compactedAtPromptTokens) }
          : {}),
      });
    },
  });

  return entry ?? params.sessionEntry;
}

export async function runPreflightCompactionIfNeeded(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  promptForEstimate?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isHeartbeat: boolean;
  replyOperation: ReplyOperation;
}): Promise<SessionEntry | undefined> {
  if (!params.sessionKey) {
    return params.sessionEntry;
  }

  let entry =
    params.sessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  if (!entry?.sessionId) {
    return entry ?? params.sessionEntry;
  }

  const isCli = isCliProvider(params.followupRun.run.provider, params.cfg);
  if (params.isHeartbeat) {
    return entry ?? params.sessionEntry;
  }
  if (isCli) {
    return runCliPreflightCompactionIfNeeded({
      ...params,
      sessionEntry: entry,
    });
  }

  const contextWindowTokens = resolveMemoryFlushContextWindowTokens({
    cfg: params.cfg,
    provider: params.followupRun.run.provider,
    modelId: params.followupRun.run.model ?? params.defaultModel,
    agentCfgContextTokens: params.agentCfgContextTokens,
  });
  const memoryFlushPlan = resolveMemoryFlushPlan({ cfg: params.cfg });
  const reserveTokensFloor =
    memoryFlushPlan?.reserveTokensFloor ??
    params.cfg.agents?.defaults?.compaction?.reserveTokensFloor ??
    20_000;
  const softThresholdTokens = memoryFlushPlan?.softThresholdTokens ?? 4_000;
  const freshPersistedTokens = resolveFreshSessionTotalTokens(entry);
  const persistedTotalTokens = entry.totalTokens;
  const hasPersistedTotalTokens =
    typeof persistedTotalTokens === "number" &&
    Number.isFinite(persistedTotalTokens) &&
    persistedTotalTokens > 0;
  const shouldUseTranscriptFallback = entry.totalTokensFresh === false || !hasPersistedTotalTokens;
  if (!shouldUseTranscriptFallback) {
    return entry ?? params.sessionEntry;
  }
  const promptTokenEstimate = estimatePromptTokensForMemoryFlush(
    params.promptForEstimate ?? params.followupRun.prompt,
  );
  const transcriptPromptTokens =
    typeof freshPersistedTokens === "number"
      ? undefined
      : estimatePromptTokensFromSessionTranscript({
          sessionId: entry.sessionId,
          storePath: params.storePath,
          sessionFile: entry.sessionFile ?? params.followupRun.run.sessionFile,
        });
  const projectedTokenCount =
    typeof transcriptPromptTokens === "number"
      ? resolveEffectivePromptTokens(transcriptPromptTokens, undefined, promptTokenEstimate)
      : undefined;
  const tokenCountForCompaction =
    typeof projectedTokenCount === "number" &&
    Number.isFinite(projectedTokenCount) &&
    projectedTokenCount > 0
      ? projectedTokenCount
      : undefined;

  const threshold = contextWindowTokens - reserveTokensFloor - softThresholdTokens;
  logVerbose(
    `preflightCompaction check: sessionKey=${params.sessionKey} ` +
      `tokenCount=${tokenCountForCompaction ?? freshPersistedTokens ?? "undefined"} ` +
      `contextWindow=${contextWindowTokens} threshold=${threshold} ` +
      `isHeartbeat=${params.isHeartbeat} isCli=${isCli} ` +
      `persistedFresh=${entry?.totalTokensFresh === true} ` +
      `transcriptPromptTokens=${transcriptPromptTokens ?? "undefined"} ` +
      `promptTokensEst=${promptTokenEstimate ?? "undefined"}`,
  );

  const shouldCompact = shouldRunPreflightCompaction({
    entry,
    tokenCount: tokenCountForCompaction,
    contextWindowTokens,
    reserveTokensFloor,
    softThresholdTokens,
  });
  if (!shouldCompact) {
    return entry ?? params.sessionEntry;
  }

  logVerbose(
    `preflightCompaction triggered: sessionKey=${params.sessionKey} ` +
      `tokenCount=${tokenCountForCompaction ?? freshPersistedTokens ?? "undefined"} ` +
      `threshold=${threshold}`,
  );

  params.replyOperation.setPhase("preflight_compacting");
  const sessionFile = resolveSessionLogPath(
    entry.sessionId,
    entry.sessionFile ? entry : { ...entry, sessionFile: params.followupRun.run.sessionFile },
    params.sessionKey ?? params.followupRun.run.sessionKey,
    { storePath: params.storePath },
  );
  const result = await memoryDeps.compactEmbeddedPiSession({
    sessionId: entry.sessionId,
    sessionKey: params.sessionKey,
    allowGatewaySubagentBinding: true,
    messageChannel: params.followupRun.run.messageProvider,
    groupId: entry.groupId ?? params.followupRun.run.groupId,
    groupChannel: entry.groupChannel ?? params.followupRun.run.groupChannel,
    groupSpace: entry.space ?? params.followupRun.run.groupSpace,
    senderId: params.followupRun.run.senderId,
    senderName: params.followupRun.run.senderName,
    senderUsername: params.followupRun.run.senderUsername,
    senderE164: params.followupRun.run.senderE164,
    sessionFile: sessionFile ?? params.followupRun.run.sessionFile,
    workspaceDir: params.followupRun.run.workspaceDir,
    agentDir: params.followupRun.run.agentDir,
    config: params.cfg,
    skillsSnapshot: entry.skillsSnapshot ?? params.followupRun.run.skillsSnapshot,
    provider: params.followupRun.run.provider,
    model: params.followupRun.run.model,
    thinkLevel: params.followupRun.run.thinkLevel,
    bashElevated: params.followupRun.run.bashElevated,
    trigger: "budget",
    currentTokenCount: tokenCountForCompaction,
    senderIsOwner: params.followupRun.run.senderIsOwner,
    ownerNumbers: params.followupRun.run.ownerNumbers,
    abortSignal: params.replyOperation.abortSignal,
  });

  if (!result?.ok || !result.compacted) {
    logVerbose(
      `preflightCompaction skipped: sessionKey=${params.sessionKey} reason=${result?.reason ?? "not_compacted"}`,
    );
    return entry ?? params.sessionEntry;
  }

  await incrementCompactionCount({
    cfg: params.cfg,
    sessionEntry: entry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    tokensAfter: result.result?.tokensAfter,
  });
  await appendPostCompactionRefreshPrompt({
    cfg: params.cfg,
    followupRun: params.followupRun,
  });
  entry = params.sessionStore?.[params.sessionKey] ?? entry;
  return entry ?? params.sessionEntry;
}

export async function runMemoryFlushIfNeeded(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  promptForEstimate?: string;
  sessionCtx: TemplateContext;
  opts?: GetReplyOptions;
  defaultModel: string;
  agentCfgContextTokens?: number;
  resolvedVerboseLevel: VerboseLevel;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isHeartbeat: boolean;
  replyOperation: ReplyOperation;
}): Promise<SessionEntry | undefined> {
  const memoryFlushPlan = resolveMemoryFlushPlan({ cfg: params.cfg });
  if (!memoryFlushPlan) {
    return params.sessionEntry;
  }

  const memoryFlushWritable = (() => {
    if (!params.sessionKey) {
      return true;
    }
    const runtime = resolveSandboxRuntimeStatus({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
    if (!runtime.sandboxed) {
      return true;
    }
    const sandboxCfg = resolveSandboxConfigForAgent(params.cfg, runtime.agentId);
    return sandboxCfg.workspaceAccess === "rw";
  })();

  const isCli = isCliProvider(params.followupRun.run.provider, params.cfg);
  const canAttemptFlush = memoryFlushWritable && !params.isHeartbeat;
  let entry =
    params.sessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  const contextWindowTokens = resolveMemoryFlushContextWindowTokens({
    cfg: params.cfg,
    provider: params.followupRun.run.provider,
    modelId: params.followupRun.run.model ?? params.defaultModel,
    agentCfgContextTokens: params.agentCfgContextTokens,
  });

  const promptTokenEstimate = estimatePromptTokensForMemoryFlush(
    params.promptForEstimate ?? params.followupRun.prompt,
  );
  const persistedPromptTokensRaw = entry?.totalTokens;
  const persistedPromptTokens =
    typeof persistedPromptTokensRaw === "number" &&
    Number.isFinite(persistedPromptTokensRaw) &&
    persistedPromptTokensRaw > 0
      ? persistedPromptTokensRaw
      : undefined;
  const hasFreshPersistedPromptTokens =
    typeof persistedPromptTokens === "number" && entry?.totalTokensFresh === true;

  const flushThreshold =
    contextWindowTokens - memoryFlushPlan.reserveTokensFloor - memoryFlushPlan.softThresholdTokens;
  const retriggerTokens = isCli ? CLI_MEMORY_FLUSH_RETRIGGER_TOKENS : undefined;

  // When totals are stale/unknown, derive prompt + last output from transcript so memory
  // flush can still be evaluated against projected next-input size.
  //
  // When totals are fresh, only read the transcript when we're close enough to the
  // threshold that missing the last output tokens could flip the decision.
  const shouldReadTranscriptForOutput =
    canAttemptFlush &&
    entry &&
    hasFreshPersistedPromptTokens &&
    typeof promptTokenEstimate === "number" &&
    Number.isFinite(promptTokenEstimate) &&
    flushThreshold > 0 &&
    (persistedPromptTokens ?? 0) + promptTokenEstimate >=
      flushThreshold - TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS;

  const shouldReadTranscript = Boolean(
    canAttemptFlush && entry && (!hasFreshPersistedPromptTokens || shouldReadTranscriptForOutput),
  );

  const forceFlushTranscriptBytes = memoryFlushPlan.forceFlushTranscriptBytes;
  const shouldCheckTranscriptSizeForForcedFlush = Boolean(
    canAttemptFlush &&
    entry &&
    Number.isFinite(forceFlushTranscriptBytes) &&
    forceFlushTranscriptBytes > 0,
  );
  const shouldReadSessionLog = shouldReadTranscript || shouldCheckTranscriptSizeForForcedFlush;
  const sessionLogSnapshot = shouldReadSessionLog
    ? await readSessionLogSnapshot({
        sessionId: params.followupRun.run.sessionId,
        sessionEntry: entry,
        sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
        opts: { storePath: params.storePath },
        includeByteSize: shouldCheckTranscriptSizeForForcedFlush,
        includeUsage: shouldReadTranscript,
      })
    : undefined;
  const transcriptByteSize = sessionLogSnapshot?.byteSize;
  const shouldForceFlushByTranscriptSize =
    typeof transcriptByteSize === "number" && transcriptByteSize >= forceFlushTranscriptBytes;

  const transcriptUsageSnapshot = sessionLogSnapshot?.usage;
  const transcriptPromptTokens = transcriptUsageSnapshot?.promptTokens;
  const transcriptOutputTokens = transcriptUsageSnapshot?.outputTokens;
  const hasReliableTranscriptPromptTokens =
    typeof transcriptPromptTokens === "number" &&
    Number.isFinite(transcriptPromptTokens) &&
    transcriptPromptTokens > 0;
  const shouldPersistTranscriptPromptTokens =
    hasReliableTranscriptPromptTokens &&
    (!hasFreshPersistedPromptTokens ||
      (transcriptPromptTokens ?? 0) > (persistedPromptTokens ?? 0));

  if (entry && shouldPersistTranscriptPromptTokens) {
    const nextEntry = {
      ...entry,
      totalTokens: transcriptPromptTokens,
      totalTokensFresh: true,
    };
    entry = nextEntry;
    if (params.sessionKey && params.sessionStore) {
      params.sessionStore[params.sessionKey] = nextEntry;
    }
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await updateSessionStoreEntry({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          update: async () => ({ totalTokens: transcriptPromptTokens, totalTokensFresh: true }),
        });
        if (updatedEntry) {
          entry = updatedEntry;
          if (params.sessionStore) {
            params.sessionStore[params.sessionKey] = updatedEntry;
          }
        }
      } catch (err) {
        logVerbose(`failed to persist derived prompt totalTokens: ${String(err)}`);
      }
    }
  }

  const promptTokensSnapshot = Math.max(
    hasFreshPersistedPromptTokens ? (persistedPromptTokens ?? 0) : 0,
    hasReliableTranscriptPromptTokens ? (transcriptPromptTokens ?? 0) : 0,
  );
  const hasFreshPromptTokensSnapshot =
    promptTokensSnapshot > 0 &&
    (hasFreshPersistedPromptTokens || hasReliableTranscriptPromptTokens);

  const projectedTokenCount = hasFreshPromptTokensSnapshot
    ? resolveEffectivePromptTokens(
        promptTokensSnapshot,
        transcriptOutputTokens,
        promptTokenEstimate,
      )
    : undefined;
  const tokenCountForFlush =
    typeof projectedTokenCount === "number" &&
    Number.isFinite(projectedTokenCount) &&
    projectedTokenCount > 0
      ? projectedTokenCount
      : undefined;

  // Diagnostic logging to understand why memory flush may not trigger.
  logVerbose(
    `memoryFlush check: sessionKey=${params.sessionKey} ` +
      `tokenCount=${tokenCountForFlush ?? "undefined"} ` +
      `contextWindow=${contextWindowTokens} threshold=${flushThreshold} ` +
      `isHeartbeat=${params.isHeartbeat} isCli=${isCli} memoryFlushWritable=${memoryFlushWritable} ` +
      `compactionCount=${entry?.compactionCount ?? 0} memoryFlushCompactionCount=${entry?.memoryFlushCompactionCount ?? "undefined"} ` +
      `memoryFlushPromptTokens=${entry?.memoryFlushPromptTokens ?? "undefined"} retriggerTokens=${retriggerTokens ?? "undefined"} ` +
      `persistedPromptTokens=${persistedPromptTokens ?? "undefined"} persistedFresh=${entry?.totalTokensFresh === true} ` +
      `promptTokensEst=${promptTokenEstimate ?? "undefined"} transcriptPromptTokens=${transcriptPromptTokens ?? "undefined"} transcriptOutputTokens=${transcriptOutputTokens ?? "undefined"} ` +
      `projectedTokenCount=${projectedTokenCount ?? "undefined"} transcriptBytes=${transcriptByteSize ?? "undefined"} ` +
      `forceFlushTranscriptBytes=${forceFlushTranscriptBytes} forceFlushByTranscriptSize=${shouldForceFlushByTranscriptSize}`,
  );

  const shouldFlushMemory =
    (memoryFlushWritable &&
      !params.isHeartbeat &&
      shouldRunMemoryFlush({
        entry,
        tokenCount: tokenCountForFlush,
        contextWindowTokens,
        reserveTokensFloor: memoryFlushPlan.reserveTokensFloor,
        softThresholdTokens: memoryFlushPlan.softThresholdTokens,
        retriggerTokens,
      })) ||
    (shouldForceFlushByTranscriptSize &&
      entry != null &&
      !hasAlreadyFlushedForCurrentCompaction(entry));

  if (!shouldFlushMemory) {
    return entry ?? params.sessionEntry;
  }

  logVerbose(
    `memoryFlush triggered: sessionKey=${params.sessionKey} tokenCount=${tokenCountForFlush ?? "undefined"} threshold=${flushThreshold}`,
  );

  params.replyOperation.setPhase("memory_flushing");
  let activeSessionEntry = entry ?? params.sessionEntry;
  const activeSessionStore = params.sessionStore;
  let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    activeSessionEntry?.systemPromptReport ??
      (params.sessionKey ? activeSessionStore?.[params.sessionKey]?.systemPromptReport : undefined),
  );
  const flushRunId = memoryDeps.randomUUID();
  if (params.sessionKey) {
    memoryDeps.registerAgentRunContext(flushRunId, {
      sessionKey: params.sessionKey,
      verboseLevel: params.resolvedVerboseLevel,
    });
  }
  let memoryCompactionCompleted = false;
  const memoryFlushNowMs = memoryDeps.now();
  const memoryFlushPromptTokens =
    typeof tokenCountForFlush === "number" &&
    Number.isFinite(tokenCountForFlush) &&
    tokenCountForFlush > 0
      ? Math.floor(tokenCountForFlush)
      : promptTokensSnapshot > 0
        ? Math.floor(promptTokensSnapshot)
        : undefined;
  const activeMemoryFlushPlan =
    resolveMemoryFlushPlan({
      cfg: params.cfg,
      nowMs: memoryFlushNowMs,
    }) ?? memoryFlushPlan;
  const memoryFlushWritePath = activeMemoryFlushPlan.relativePath;
  const flushSystemPrompt = [
    params.followupRun.run.extraSystemPrompt,
    activeMemoryFlushPlan.systemPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
  let postCompactionSessionId: string | undefined;
  try {
    await memoryDeps.runWithModelFallback({
      ...resolveModelFallbackOptions(params.followupRun.run),
      runId: flushRunId,
      run: async (provider, model, runOptions) => {
        const { embeddedContext, senderContext, runBaseParams } = buildEmbeddedRunExecutionParams({
          run: params.followupRun.run,
          sessionCtx: params.sessionCtx,
          hasRepliedRef: params.opts?.hasRepliedRef,
          provider,
          model,
          runId: flushRunId,
          allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
        });
        const result = await memoryDeps.runEmbeddedPiAgent({
          ...embeddedContext,
          ...senderContext,
          ...runBaseParams,
          allowGatewaySubagentBinding: true,
          silentExpected: true,
          trigger: "memory",
          memoryFlushWritePath,
          prompt: activeMemoryFlushPlan.prompt,
          extraSystemPrompt: flushSystemPrompt,
          bootstrapPromptWarningSignaturesSeen,
          bootstrapPromptWarningSignature:
            bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1],
          abortSignal: params.replyOperation.abortSignal,
          replyOperation: params.replyOperation,
          onAgentEvent: (evt) => {
            if (evt.stream === "compaction") {
              const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
              if (phase === "end") {
                memoryCompactionCompleted = true;
              }
            }
          },
        });
        if (result.meta?.agentMeta?.sessionId) {
          postCompactionSessionId = result.meta.agentMeta.sessionId;
        }
        bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
          result.meta?.systemPromptReport,
        );
        return result;
      },
    });
    let memoryFlushCompactionCount =
      activeSessionEntry?.compactionCount ??
      (params.sessionKey ? activeSessionStore?.[params.sessionKey]?.compactionCount : 0) ??
      0;
    if (memoryCompactionCompleted) {
      const previousSessionId = activeSessionEntry?.sessionId ?? params.followupRun.run.sessionId;
      const nextCount = await memoryDeps.incrementCompactionCount({
        cfg: params.cfg,
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        newSessionId: postCompactionSessionId,
      });
      const updatedEntry = params.sessionKey ? activeSessionStore?.[params.sessionKey] : undefined;
      if (updatedEntry) {
        activeSessionEntry = updatedEntry;
        params.followupRun.run.sessionId = updatedEntry.sessionId;
        params.replyOperation.updateSessionId(updatedEntry.sessionId);
        if (updatedEntry.sessionFile) {
          params.followupRun.run.sessionFile = updatedEntry.sessionFile;
        }
        const queueKey = params.followupRun.run.sessionKey ?? params.sessionKey;
        if (queueKey) {
          memoryDeps.refreshQueuedFollowupSession({
            key: queueKey,
            previousSessionId,
            nextSessionId: updatedEntry.sessionId,
            nextSessionFile: updatedEntry.sessionFile,
          });
        }
      }
      if (typeof nextCount === "number") {
        memoryFlushCompactionCount = nextCount;
      }
    }
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await memoryDeps.updateSessionStoreEntry({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          update: async () => ({
            memoryFlushAt: memoryDeps.now(),
            memoryFlushCompactionCount,
            memoryFlushPromptTokens,
          }),
        });
        if (updatedEntry) {
          activeSessionEntry = updatedEntry;
          params.followupRun.run.sessionId = updatedEntry.sessionId;
          params.replyOperation.updateSessionId(updatedEntry.sessionId);
          if (updatedEntry.sessionFile) {
            params.followupRun.run.sessionFile = updatedEntry.sessionFile;
          }
        }
      } catch (err) {
        logVerbose(`failed to persist memory flush metadata: ${String(err)}`);
      }
    }
  } catch (err) {
    logVerbose(`memory flush run failed: ${String(err)}`);
  }

  return activeSessionEntry;
}
