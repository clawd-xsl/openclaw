import crypto from "node:crypto";
import type { CliBackendConfig } from "../../config/types.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { createTimingTrace, isTimingTraceEnabled } from "../../infra/timing-trace.js";
import type {
  ProcessSupervisor,
  RunExit,
  TerminationReason,
} from "../../process/supervisor/types.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { createCliJsonlStreamingParser, type CliStreamingDelta } from "../cli-output.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import { classifyFailoverReason } from "../pi-embedded-helpers.js";
import { materializeCliBundleMcpConfig } from "./bundle-mcp.js";
import {
  buildClaudeCliSkillsPluginSpec,
  materializeClaudeCliSkillsPlugin,
} from "./claude-skills-plugin.js";
import { buildCliArgs, resolveSystemPromptUsage, writeCliSystemPromptFile } from "./helpers.js";
import { cliBackendLog } from "./log.js";
import type { PreparedCliRunContext } from "./types.js";

export type PersistentCliTurnExit = RunExit & {
  sessionId?: string;
};

type PersistentTurnState = {
  startedAtMs: number;
  runId: string;
  promptChars: number;
  stdout: string;
  stderr: string;
  stdoutLineBuffer: string;
  sessionId?: string;
  settled: boolean;
  timeoutMs: number;
  noOutputTimeoutMs: number;
  writeRequestedAtMs: number | null;
  writeCompletedAtMs: number | null;
  firstStdoutAtMs: number | null;
  firstJsonRecordAtMs: number | null;
  firstDeltaAtMs: number | null;
  preDeltaRecordLogCount: number;
  timeoutTimer: NodeJS.Timeout | null;
  noOutputTimer: NodeJS.Timeout | null;
  streamingParser: ReturnType<typeof createCliJsonlStreamingParser>;
  resolve: (value: PersistentCliTurnExit) => void;
  reject: (error: Error) => void;
};

type PersistentRuntime = {
  key: string;
  signature: string;
  backend: CliBackendConfig;
  providerId: string;
  modelId: string;
  launchedAtMs: number;
  lastActivityAtMs: number;
  managedRun: Awaited<ReturnType<ProcessSupervisor["spawn"]>>;
  launchCleanup: () => Promise<void>;
  exitPromise: Promise<RunExit>;
  sessionId?: string;
  preTurnStdoutLineBuffer: string;
  activeTurn: PersistentTurnState | null;
  turnCount: number;
  logOutputText: boolean;
};

type ExecutePersistentCliTurnParams = {
  context: PreparedCliRunContext;
  backend: CliBackendConfig;
  env: Record<string, string>;
  supervisor: ProcessSupervisor;
  prompt: string;
  resumeSessionId?: string;
  resolvedSessionId?: string;
  timeoutMs: number;
  noOutputTimeoutMs: number;
  logOutputText: boolean;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
};

const RUNTIMES = new Map<string, PersistentRuntime>();
const PERSISTENT_RUNTIME_SESSION_IDS = new Map<string, string>();
// Keep main chat runtimes warm across normal gaps in a long-lived conversation.
// The shorter v1 values caused afternoon sessions to cold-start again too often.
const PERSISTENT_RUNTIME_IDLE_TTL_MS = 6 * 60 * 60_000;
const PERSISTENT_RUNTIME_MAX_AGE_MS = 24 * 60 * 60_000;
const PERSISTENT_RUNTIME_SWEEP_INTERVAL_MS = 60_000;
const PERSISTENT_PREDELTA_TRACE_ENV = "OPENCLAW_DEBUG_CLAUDE_PRETEXT_TRACE";
let persistentRuntimeReaper: NodeJS.Timeout | null = null;
let persistentRuntimeReaperPromise: Promise<void> | null = null;

function createPersistentCliAbortError(): Error {
  const error = new Error("CLI run aborted");
  error.name = "AbortError";
  return error;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
    .join(",")}}`;
}

function buildPersistentRuntimeKey(context: PreparedCliRunContext): string {
  // Scope by the stable OpenClaw session identity, not the Claude session id,
  // so fresh and resumed turns for the same parent session share one runtime.
  const scope = normalizeOptionalString(context.params.sessionKey) ?? context.params.sessionId;
  return `${context.backendResolved.id}:${scope}`;
}

function buildPersistentRuntimeSignature(params: {
  context: PreparedCliRunContext;
  backend: CliBackendConfig;
}): string {
  // preparedBackend.env contains launch-scoped Claude/MCP env. Values like
  // OPENCLAW_MCP_SENDER_IS_OWNER intentionally participate in the signature:
  // Claude snapshots them at process start and later MCP tool calls reuse that
  // process env, so identity changes must relaunch instead of silently using
  // stale request headers.
  const envEntries = Object.entries({
    ...params.backend.env,
    ...params.context.preparedBackend.env,
  })
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .toSorted(([left], [right]) => left.localeCompare(right));
  return crypto
    .createHash("sha256")
    .update(
      stableSerialize({
        openClawSessionId: params.context.params.sessionId,
        backendId: params.context.backendResolved.id,
        command: params.backend.command,
        args: params.backend.args ?? [],
        resumeArgs: params.backend.resumeArgs ?? [],
        executionMode: params.backend.executionMode ?? "spawn-per-turn",
        sessionMode: params.backend.sessionMode ?? "always",
        model: params.context.normalizedModel,
        thinkLevel: params.context.params.thinkLevel ?? null,
        fastMode: params.context.params.fastMode ?? null,
        systemPrompt: params.context.systemPrompt,
        mcpConfigHash: params.context.preparedBackend.mcpConfigHash ?? null,
        authProfileId: params.context.params.authProfileId ?? null,
        authEpoch: params.context.authEpoch ?? null,
        skillsSignature: params.context.preparedBackend.claudeSkillsPluginSpec?.signature ?? null,
        workspaceDir: params.context.workspaceDir,
        clearEnv: [...(params.backend.clearEnv ?? [])].toSorted(),
        env: envEntries,
      }),
    )
    .digest("hex");
}

function pickRuntimeSessionId(raw: Record<string, unknown>): string | undefined {
  const candidates = [
    raw.session_id,
    raw.sessionId,
    raw.conversation_id,
    raw.conversationId,
    raw.thread_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function buildCliLogArgs(params: {
  args: string[];
  systemPromptArg?: string;
  sessionArg?: string;
  modelArg?: string;
}): string[] {
  const logArgs: string[] = [];
  for (let i = 0; i < params.args.length; i += 1) {
    const arg = params.args[i] ?? "";
    if (arg === params.systemPromptArg) {
      const systemPromptValue = params.args[i + 1] ?? "";
      logArgs.push(arg, `<systemPrompt:${systemPromptValue.length} chars>`);
      i += 1;
      continue;
    }
    if (arg === params.sessionArg || arg === params.modelArg) {
      logArgs.push(arg, params.args[i + 1] ?? "");
      i += 1;
      continue;
    }
    logArgs.push(arg);
  }
  return logArgs;
}

function clearTurnTimers(turn: PersistentTurnState): void {
  if (turn.timeoutTimer) {
    clearTimeout(turn.timeoutTimer);
    turn.timeoutTimer = null;
  }
  if (turn.noOutputTimer) {
    clearTimeout(turn.noOutputTimer);
    turn.noOutputTimer = null;
  }
}

function mergeCapturedOutput(turnText: string, exitText: string): string {
  if (!turnText) {
    return exitText;
  }
  if (!exitText) {
    return turnText;
  }
  return `${turnText}${exitText}`;
}

function logPersistentTurnTiming(
  runtime: PersistentRuntime,
  turn: PersistentTurnState,
  phase: string,
  extra?: Record<string, unknown>,
): void {
  if (!isTimingTraceEnabled()) {
    return;
  }
  const trace = createTimingTrace({
    channel: "cli-persistent-trace",
    label: `${runtime.key}:run=${turn.runId}`,
    scope: "persistentTurn",
    sink: (line) => {
      cliBackendLog.info(line);
    },
    startedAtMs: turn.startedAtMs,
  });
  const summary = Object.entries({
    provider: runtime.providerId,
    model: runtime.modelId,
    completedTurns: runtime.turnCount,
    promptChars: turn.promptChars,
    claudeSessionId: turn.sessionId ?? runtime.sessionId ?? "unknown",
    ...extra,
  })
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  trace(phase, summary);
}

function createPersistentRuntimeTrace(params: {
  runtimeKey: string;
  providerId: string;
  modelId: string;
  runId: string;
  startedAtMs?: number;
}) {
  return createTimingTrace({
    channel: "cli-persistent-trace",
    label: `${params.runtimeKey}:run=${params.runId}`,
    scope: "persistentRuntime",
    sink: (line) => {
      cliBackendLog.info(line);
    },
    startedAtMs: params.startedAtMs,
  });
}

function noteRuntimeActivity(runtime: PersistentRuntime): void {
  runtime.lastActivityAtMs = Date.now();
}

function rememberPersistentRuntimeSessionId(runtimeKey: string, sessionId?: string): void {
  const normalized = normalizeOptionalString(sessionId);
  if (!normalized) {
    return;
  }
  PERSISTENT_RUNTIME_SESSION_IDS.set(runtimeKey, normalized);
}

function clearPersistentRuntimeSessionId(runtimeKey: string): void {
  PERSISTENT_RUNTIME_SESSION_IDS.delete(runtimeKey);
}

function isPersistentRuntimeStale(runtime: PersistentRuntime, nowMs: number): boolean {
  if (runtime.activeTurn) {
    return false;
  }
  const idleMs = nowMs - runtime.lastActivityAtMs;
  const ageMs = nowMs - runtime.launchedAtMs;
  return idleMs >= PERSISTENT_RUNTIME_IDLE_TTL_MS || ageMs >= PERSISTENT_RUNTIME_MAX_AGE_MS;
}

function collectPersistentRecordText(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectPersistentRecordText(entry)).join("");
  }
  if (typeof value !== "object") {
    return "";
  }
  const candidate = value as Record<string, unknown>;
  return (
    collectPersistentRecordText(candidate.message) ||
    collectPersistentRecordText(candidate.content) ||
    collectPersistentRecordText(candidate.result) ||
    collectPersistentRecordText(candidate.error) ||
    collectPersistentRecordText(candidate.text)
  );
}

function shouldLogAllPreDeltaRecords(): boolean {
  return isTruthyEnvValue(process.env[PERSISTENT_PREDELTA_TRACE_ENV]);
}

function parseRuntimeSessionIdLines(runtime: PersistentRuntime): void {
  while (true) {
    const newlineIndex = runtime.preTurnStdoutLineBuffer.indexOf("\n");
    if (newlineIndex < 0) {
      return;
    }
    const line = runtime.preTurnStdoutLineBuffer.slice(0, newlineIndex).trim();
    runtime.preTurnStdoutLineBuffer = runtime.preTurnStdoutLineBuffer.slice(newlineIndex + 1);
    if (!line) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const sessionId = pickRuntimeSessionId(parsed as Record<string, unknown>);
    if (sessionId) {
      runtime.sessionId = sessionId;
      rememberPersistentRuntimeSessionId(runtime.key, sessionId);
    }
  }
}

function resolvePersistentTurnFailure(
  runtime: PersistentRuntime,
  record: Record<string, unknown>,
): FailoverError | null {
  // Protocol-level stream-json errors are classified here; process-exit stdout/stderr
  // stays classified downstream in execute.ts so both paths share the same taxonomy.
  const subtype = typeof record.subtype === "string" ? record.subtype : "";
  const isExplicitError =
    record.type === "error" || record.is_error === true || subtype === "error";
  if (!isExplicitError) {
    return null;
  }
  const errorText = collectPersistentRecordText(record).trim() || "CLI returned an error result.";
  const reason = classifyFailoverReason(errorText, { provider: runtime.providerId }) ?? "unknown";
  return new FailoverError(errorText, {
    reason,
    provider: runtime.providerId,
    model: runtime.modelId,
    status: resolveFailoverStatus(reason),
  });
}

function evictPersistentRuntime(runtime: PersistentRuntime): void {
  if (RUNTIMES.get(runtime.key) === runtime) {
    RUNTIMES.delete(runtime.key);
  }
}

function maybeStopPersistentRuntimeReaper(): void {
  if (RUNTIMES.size > 0 || !persistentRuntimeReaper) {
    return;
  }
  clearInterval(persistentRuntimeReaper);
  persistentRuntimeReaper = null;
}

async function reapPersistentCliRuntimes(nowMs = Date.now()): Promise<void> {
  if (persistentRuntimeReaperPromise) {
    await persistentRuntimeReaperPromise;
    return;
  }
  persistentRuntimeReaperPromise = (async () => {
    const staleRuntimes = [...RUNTIMES.values()].filter((runtime) =>
      isPersistentRuntimeStale(runtime, nowMs),
    );
    for (const runtime of staleRuntimes) {
      if (!isPersistentRuntimeStale(runtime, nowMs)) {
        continue;
      }
      cliBackendLog.info(
        `cli persistent reap: provider=${runtime.providerId} session=${runtime.key} idleMs=${Math.max(
          0,
          nowMs - runtime.lastActivityAtMs,
        )} ageMs=${Math.max(0, nowMs - runtime.launchedAtMs)}`,
      );
      await closePersistentRuntime(runtime, "manual-cancel");
    }
  })();
  try {
    await persistentRuntimeReaperPromise;
  } finally {
    persistentRuntimeReaperPromise = null;
    maybeStopPersistentRuntimeReaper();
  }
}

function ensurePersistentRuntimeReaper(): void {
  if (persistentRuntimeReaper) {
    return;
  }
  persistentRuntimeReaper = setInterval(() => {
    void reapPersistentCliRuntimes();
  }, PERSISTENT_RUNTIME_SWEEP_INTERVAL_MS);
  persistentRuntimeReaper.unref?.();
}

function settleTurn(turn: PersistentTurnState, result: PersistentCliTurnExit): void {
  if (turn.settled) {
    return;
  }
  turn.settled = true;
  clearTurnTimers(turn);
  turn.streamingParser.finish();
  turn.resolve(result);
}

function rejectTurn(turn: PersistentTurnState, error: Error): void {
  if (turn.settled) {
    return;
  }
  turn.settled = true;
  clearTurnTimers(turn);
  turn.streamingParser.finish();
  turn.reject(error);
}

function rescheduleNoOutputTimer(runtime: PersistentRuntime, turn: PersistentTurnState): void {
  if (turn.noOutputTimeoutMs <= 0) {
    return;
  }
  if (turn.noOutputTimer) {
    clearTimeout(turn.noOutputTimer);
  }
  turn.noOutputTimer = setTimeout(() => {
    runtime.managedRun.cancel("no-output-timeout");
  }, turn.noOutputTimeoutMs);
  turn.noOutputTimer.unref?.();
}

function finalizeSuccessfulTurn(runtime: PersistentRuntime, turn: PersistentTurnState): void {
  runtime.activeTurn = null;
  runtime.turnCount += 1;
  noteRuntimeActivity(runtime);
  const sessionId = turn.sessionId ?? runtime.sessionId;
  if (sessionId) {
    runtime.sessionId = sessionId;
    rememberPersistentRuntimeSessionId(runtime.key, sessionId);
  }
  logPersistentTurnTiming(runtime, turn, "result", {
    writeCbMs:
      turn.writeCompletedAtMs == null
        ? "none"
        : Math.max(0, turn.writeCompletedAtMs - turn.startedAtMs),
    firstStdoutMs:
      turn.firstStdoutAtMs == null ? "none" : Math.max(0, turn.firstStdoutAtMs - turn.startedAtMs),
    firstJsonRecordMs:
      turn.firstJsonRecordAtMs == null
        ? "none"
        : Math.max(0, turn.firstJsonRecordAtMs - turn.startedAtMs),
    firstDeltaMs:
      turn.firstDeltaAtMs == null ? "none" : Math.max(0, turn.firstDeltaAtMs - turn.startedAtMs),
    totalMs: Math.max(0, Date.now() - turn.startedAtMs),
  });
  settleTurn(turn, {
    reason: "exit",
    exitCode: 0,
    exitSignal: null,
    durationMs: Date.now() - turn.startedAtMs,
    stdout: turn.stdout,
    stderr: turn.stderr,
    timedOut: false,
    noOutputTimedOut: false,
    sessionId,
  });
}

function parseTurnStdout(runtime: PersistentRuntime, turn: PersistentTurnState): void {
  while (true) {
    const newlineIndex = turn.stdoutLineBuffer.indexOf("\n");
    if (newlineIndex < 0) {
      return;
    }
    const line = turn.stdoutLineBuffer.slice(0, newlineIndex).trim();
    turn.stdoutLineBuffer = turn.stdoutLineBuffer.slice(newlineIndex + 1);
    if (!line) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (turn.firstJsonRecordAtMs == null) {
      turn.firstJsonRecordAtMs = Date.now();
      logPersistentTurnTiming(runtime, turn, "first-json-record", {
        recordType: typeof record.type === "string" ? record.type : "unknown",
        recordSubtype: typeof record.subtype === "string" ? record.subtype : "none",
        sinceFirstStdoutMs:
          turn.firstStdoutAtMs == null
            ? "none"
            : Math.max(0, turn.firstJsonRecordAtMs - turn.firstStdoutAtMs),
      });
    }
    if (
      turn.firstDeltaAtMs == null &&
      (shouldLogAllPreDeltaRecords() || turn.preDeltaRecordLogCount < 8)
    ) {
      turn.preDeltaRecordLogCount += 1;
      const event =
        typeof record.event === "object" && record.event && !Array.isArray(record.event)
          ? (record.event as Record<string, unknown>)
          : null;
      const delta =
        event && typeof event.delta === "object" && event.delta && !Array.isArray(event.delta)
          ? (event.delta as Record<string, unknown>)
          : null;
      const contentBlock =
        event &&
        typeof event.content_block === "object" &&
        event.content_block &&
        !Array.isArray(event.content_block)
          ? (event.content_block as Record<string, unknown>)
          : null;
      logPersistentTurnTiming(runtime, turn, "record-before-delta", {
        index: turn.preDeltaRecordLogCount,
        recordType: typeof record.type === "string" ? record.type : "unknown",
        recordSubtype: typeof record.subtype === "string" ? record.subtype : "none",
        eventType: typeof event?.type === "string" ? event.type : "none",
        deltaType: typeof delta?.type === "string" ? delta.type : "none",
        contentBlockType: typeof contentBlock?.type === "string" ? contentBlock.type : "none",
        textChars: collectPersistentRecordText(record).length,
        signatureChars:
          typeof delta?.signature === "string"
            ? delta.signature.length
            : typeof delta?.partial_json === "string"
              ? delta.partial_json.length
              : 0,
      });
    }
    const sessionId = pickRuntimeSessionId(record);
    if (sessionId) {
      turn.sessionId = sessionId;
      runtime.sessionId = sessionId;
      rememberPersistentRuntimeSessionId(runtime.key, sessionId);
    }
    if (record.type === "result") {
      const failure = resolvePersistentTurnFailure(runtime, record);
      if (failure) {
        runtime.activeTurn = null;
        rejectTurn(turn, failure);
        if (failure.reason === "session_expired") {
          runtime.sessionId = undefined;
          clearPersistentRuntimeSessionId(runtime.key);
          evictPersistentRuntime(runtime);
          runtime.managedRun.cancel("manual-cancel");
        }
        return;
      }
      finalizeSuccessfulTurn(runtime, turn);
      return;
    }
  }
}

function handleRuntimeStdoutChunk(runtime: PersistentRuntime, chunk: string): void {
  const turn = runtime.activeTurn;
  if (!chunk) {
    return;
  }
  if (!turn) {
    runtime.preTurnStdoutLineBuffer += chunk;
    parseRuntimeSessionIdLines(runtime);
    return;
  }
  noteRuntimeActivity(runtime);
  if (turn.firstStdoutAtMs == null) {
    turn.firstStdoutAtMs = Date.now();
    logPersistentTurnTiming(runtime, turn, "first-stdout", {
      chunkChars: chunk.length,
      writeCbMs:
        turn.writeCompletedAtMs == null
          ? "none"
          : Math.max(0, turn.writeCompletedAtMs - turn.startedAtMs),
    });
  }
  turn.stdout += chunk;
  turn.stdoutLineBuffer += chunk;
  turn.streamingParser.push(chunk);
  rescheduleNoOutputTimer(runtime, turn);
  parseTurnStdout(runtime, turn);
}

function handleRuntimeStderrChunk(runtime: PersistentRuntime, chunk: string): void {
  const turn = runtime.activeTurn;
  if (!turn || !chunk) {
    return;
  }
  noteRuntimeActivity(runtime);
  if (!turn.stderr) {
    logPersistentTurnTiming(runtime, turn, "first-stderr", {
      chunkChars: chunk.length,
    });
  }
  turn.stderr += chunk;
  rescheduleNoOutputTimer(runtime, turn);
}

async function closePersistentRuntime(
  runtime: PersistentRuntime | undefined,
  reason: TerminationReason,
): Promise<void> {
  if (!runtime) {
    return;
  }
  evictPersistentRuntime(runtime);
  runtime.managedRun.cancel(reason);
  try {
    await runtime.exitPromise;
  } catch {
    // The exit waiter already propagated any active turn failure.
  }
  maybeStopPersistentRuntimeReaper();
}

async function launchPersistentRuntime(params: {
  context: PreparedCliRunContext;
  backend: CliBackendConfig;
  env: Record<string, string>;
  supervisor: ProcessSupervisor;
  runtimeKey: string;
  signature: string;
  resumeSessionId?: string;
  initialSessionId?: string;
  logOutputText: boolean;
}): Promise<PersistentRuntime> {
  const launchStartedAtMs = Date.now();
  const trace = createPersistentRuntimeTrace({
    runtimeKey: params.runtimeKey,
    providerId: params.context.params.provider,
    modelId: params.context.modelId,
    runId: params.context.params.runId,
    startedAtMs: launchStartedAtMs,
  });
  trace(
    "launch-start",
    `resume=${params.resumeSessionId ? "yes" : "no"} initialSession=${params.initialSessionId ?? "none"}`,
  );
  const materializedMcp = await materializeCliBundleMcpConfig({
    backend: params.backend,
    spec: params.context.preparedBackend.bundleMcpSpec ?? {
      mode: "claude-config-file",
      env: params.context.preparedBackend.env,
    },
  });
  trace("bundle-mcp-ready");
  const claudeSkillsPluginSpec =
    params.context.preparedBackend.claudeSkillsPluginSpec ??
    (await buildClaudeCliSkillsPluginSpec({
      backendId: params.context.backendResolved.id,
      skillsSnapshot: params.context.params.skillsSnapshot,
    }));
  trace(
    "skills-spec-ready",
    `signature=${claudeSkillsPluginSpec.signature ?? "none"} skills=${claudeSkillsPluginSpec.skills.length}`,
  );
  const materializedSkills = await materializeClaudeCliSkillsPlugin({
    spec: claudeSkillsPluginSpec,
  });
  trace("skills-materialized", `args=${materializedSkills.args.length}`);
  const backend = materializedMcp.backend;
  const systemPromptArg = resolveSystemPromptUsage({
    backend,
    isNewSession: !params.resumeSessionId,
    systemPrompt: params.context.systemPrompt,
  });
  const systemPromptFile = systemPromptArg
    ? await writeCliSystemPromptFile({
        backend,
        systemPrompt: systemPromptArg,
      })
    : undefined;
  trace(
    "system-prompt-ready",
    `chars=${systemPromptArg?.length ?? 0} file=${systemPromptFile ? "yes" : "no"}`,
  );
  const launchCleanup = async () => {
    await materializedSkills.cleanup();
    await materializedMcp.cleanup?.();
    await systemPromptFile?.cleanup();
  };

  try {
    const useResume = Boolean(
      params.resumeSessionId && backend.resumeArgs && backend.resumeArgs.length > 0,
    );
    const baseArgs = useResume ? (backend.resumeArgs ?? backend.args ?? []) : (backend.args ?? []);
    const resolvedArgs = useResume
      ? baseArgs.map((entry) => entry.replaceAll("{sessionId}", params.resumeSessionId ?? ""))
      : baseArgs;
    const args = buildCliArgs({
      backend,
      backendId: params.context.backendResolved.id,
      baseArgs:
        materializedSkills.args.length > 0
          ? [...resolvedArgs, ...materializedSkills.args]
          : resolvedArgs,
      modelId: params.context.normalizedModel,
      thinkLevel: params.context.params.thinkLevel,
      fastMode: params.context.params.fastMode,
      sessionId: useResume ? params.resumeSessionId : params.initialSessionId,
      systemPrompt: systemPromptArg,
      systemPromptFilePath: systemPromptFile?.filePath,
      useResume,
      includeSystemPromptOnResume: true,
    });

    if (params.logOutputText) {
      const logArgs = buildCliLogArgs({
        args,
        systemPromptArg: backend.systemPromptArg,
        sessionArg: backend.sessionArg,
        modelArg: backend.modelArg,
      });
      cliBackendLog.info(`cli persistent launch argv: ${backend.command} ${logArgs.join(" ")}`);
    }

    const pendingStdoutChunks: string[] = [];
    const pendingStderrChunks: string[] = [];
    let runtimeRef: PersistentRuntime | undefined;
    trace("spawn-start", `command=${backend.command} args=${args.length}`);
    const managedRun = await params.supervisor.spawn({
      sessionId: params.context.params.sessionId,
      backendId: params.context.backendResolved.id,
      scopeKey: params.runtimeKey,
      replaceExistingScope: true,
      mode: "child",
      argv: [backend.command, ...args],
      cwd: params.context.workspaceDir,
      env: {
        ...params.env,
        ...materializedMcp.env,
      },
      captureOutput: false,
      stdinMode: "pipe-open",
      onStdout: (chunk) => {
        if (runtimeRef) {
          handleRuntimeStdoutChunk(runtimeRef, chunk);
          return;
        }
        pendingStdoutChunks.push(chunk);
      },
      onStderr: (chunk) => {
        if (runtimeRef) {
          handleRuntimeStderrChunk(runtimeRef, chunk);
          return;
        }
        pendingStderrChunks.push(chunk);
      },
    });
    trace("spawn-done", `pid=${managedRun.pid ?? "unknown"}`);

    const runtime: PersistentRuntime = {
      key: params.runtimeKey,
      signature: params.signature,
      backend,
      providerId: params.context.params.provider,
      modelId: params.context.modelId,
      launchedAtMs: Date.now(),
      lastActivityAtMs: Date.now(),
      managedRun,
      launchCleanup,
      exitPromise: Promise.resolve({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
      sessionId: params.resumeSessionId ?? params.initialSessionId,
      preTurnStdoutLineBuffer: "",
      activeTurn: null,
      turnCount: 0,
      logOutputText: params.logOutputText,
    };
    rememberPersistentRuntimeSessionId(runtime.key, runtime.sessionId);
    runtimeRef = runtime;
    for (const chunk of pendingStdoutChunks) {
      handleRuntimeStdoutChunk(runtime, chunk);
    }
    for (const chunk of pendingStderrChunks) {
      handleRuntimeStderrChunk(runtime, chunk);
    }
    trace(
      "runtime-ready",
      `pendingStdoutChunks=${pendingStdoutChunks.length} pendingStderrChunks=${pendingStderrChunks.length}`,
    );

    runtime.exitPromise = runtime.managedRun
      .wait()
      .then(async (result) => {
        evictPersistentRuntime(runtime);
        if (runtime.activeTurn) {
          const turn = runtime.activeTurn;
          runtime.activeTurn = null;
          settleTurn(turn, {
            ...result,
            stdout: mergeCapturedOutput(turn.stdout, result.stdout),
            stderr: mergeCapturedOutput(turn.stderr, result.stderr),
            sessionId: turn.sessionId ?? runtime.sessionId,
          });
        }
        await runtime.launchCleanup();
        maybeStopPersistentRuntimeReaper();
        return result;
      })
      .catch(async (error) => {
        evictPersistentRuntime(runtime);
        if (runtime.activeTurn) {
          const turn = runtime.activeTurn;
          runtime.activeTurn = null;
          rejectTurn(turn, error instanceof Error ? error : new Error(String(error)));
        }
        await runtime.launchCleanup();
        maybeStopPersistentRuntimeReaper();
        throw error;
      });

    RUNTIMES.set(runtime.key, runtime);
    ensurePersistentRuntimeReaper();
    return runtime;
  } catch (error) {
    await launchCleanup();
    throw error;
  }
}

function buildUserMessageLine(prompt: string): string {
  return `${JSON.stringify({
    type: "user",
    session_id: "",
    message: {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
    parent_tool_use_id: null,
  })}\n`;
}

function beginPersistentTurn(params: {
  runtime: PersistentRuntime;
  context: PreparedCliRunContext;
  prompt: string;
  timeoutMs: number;
  noOutputTimeoutMs: number;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
}): Promise<PersistentCliTurnExit> {
  if (params.runtime.activeTurn) {
    throw new Error(`Persistent CLI runtime already has an active turn for ${params.runtime.key}`);
  }
  return new Promise<PersistentCliTurnExit>((resolve, reject) => {
    const turn: PersistentTurnState = {
      startedAtMs: Date.now(),
      runId: params.context.params.runId,
      promptChars: params.prompt.length,
      stdout: "",
      stderr: "",
      stdoutLineBuffer: "",
      sessionId: params.runtime.sessionId,
      settled: false,
      timeoutMs: params.timeoutMs,
      noOutputTimeoutMs: params.noOutputTimeoutMs,
      writeRequestedAtMs: null,
      writeCompletedAtMs: null,
      firstStdoutAtMs: null,
      firstJsonRecordAtMs: null,
      firstDeltaAtMs: null,
      preDeltaRecordLogCount: 0,
      timeoutTimer: null,
      noOutputTimer: null,
      streamingParser: createCliJsonlStreamingParser({
        backend: params.runtime.backend,
        providerId: params.context.backendResolved.id,
        onAssistantDelta: (delta) => {
          if (turn.firstDeltaAtMs == null) {
            turn.firstDeltaAtMs = Date.now();
            logPersistentTurnTiming(params.runtime, turn, "first-delta", {
              deltaChars: delta.delta.length,
              textChars: delta.text.length,
            });
          }
          params.onAssistantDelta(delta);
        },
      }),
      resolve,
      reject,
    };
    params.runtime.activeTurn = turn;
    noteRuntimeActivity(params.runtime);
    logPersistentTurnTiming(params.runtime, turn, "start", {
      runtimeTurnsCompleted: params.runtime.turnCount,
    });
    if (turn.timeoutMs > 0) {
      turn.timeoutTimer = setTimeout(() => {
        params.runtime.managedRun.cancel("overall-timeout");
      }, turn.timeoutMs);
      turn.timeoutTimer.unref?.();
    }
    rescheduleNoOutputTimer(params.runtime, turn);

    const stdin = params.runtime.managedRun.stdin;
    if (!stdin || stdin.destroyed) {
      params.runtime.activeTurn = null;
      rejectTurn(turn, new Error("Persistent CLI runtime stdin is unavailable"));
      return;
    }
    try {
      turn.writeRequestedAtMs = Date.now();
      const stdinLine = buildUserMessageLine(params.prompt);
      logPersistentTurnTiming(params.runtime, turn, "stdin-write-start", {
        stdinChars: stdinLine.length,
        sessionIdSent: turn.sessionId ?? "none",
      });
      stdin.write(stdinLine, (error) => {
        if (!error) {
          turn.writeCompletedAtMs = Date.now();
          logPersistentTurnTiming(params.runtime, turn, "stdin-write-cb", {
            writeCbMs: Math.max(0, turn.writeCompletedAtMs - turn.startedAtMs),
          });
          return;
        }
        params.runtime.activeTurn = null;
        rejectTurn(turn, error instanceof Error ? error : new Error(String(error)));
      });
    } catch (error) {
      params.runtime.activeTurn = null;
      rejectTurn(turn, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function executePersistentCliTurn(
  params: ExecutePersistentCliTurnParams,
): Promise<PersistentCliTurnExit> {
  const resolveStartedAtMs = Date.now();
  const runtimeKey = buildPersistentRuntimeKey(params.context);
  const trace = createPersistentRuntimeTrace({
    runtimeKey,
    providerId: params.context.params.provider,
    modelId: params.context.modelId,
    runId: params.context.params.runId,
    startedAtMs: resolveStartedAtMs,
  });
  const signature = buildPersistentRuntimeSignature({
    context: params.context,
    backend: params.backend,
  });
  const explicitResumeSessionId = normalizeOptionalString(params.resumeSessionId);
  let runtime = RUNTIMES.get(runtimeKey);
  trace(
    "resolve-start",
    `cached=${runtime ? "yes" : "no"} explicitResume=${explicitResumeSessionId ?? "none"} resolvedSession=${params.resolvedSessionId ?? "none"}`,
  );
  if (runtime) {
    noteRuntimeActivity(runtime);
  }

  if (runtime && !explicitResumeSessionId) {
    trace("relaunch-start", "reason=openclaw-cold-start");
    cliBackendLog.info(
      `cli persistent relaunch: provider=${params.context.params.provider} reason=openclaw-cold-start session=${runtimeKey}`,
    );
    clearPersistentRuntimeSessionId(runtimeKey);
    await closePersistentRuntime(runtime, "manual-cancel");
    runtime = undefined;
    trace("relaunch-done", "reason=openclaw-cold-start");
  }

  if (
    runtime &&
    explicitResumeSessionId &&
    runtime.sessionId &&
    runtime.sessionId !== explicitResumeSessionId
  ) {
    trace(
      "relaunch-start",
      `reason=session-binding-drift runtimeSession=${runtime.sessionId} explicitResume=${explicitResumeSessionId}`,
    );
    cliBackendLog.info(
      `cli persistent relaunch: provider=${params.context.params.provider} reason=session-binding-drift session=${runtimeKey}`,
    );
    await closePersistentRuntime(runtime, "manual-cancel");
    runtime = undefined;
    trace("relaunch-done", "reason=session-binding-drift");
  }

  if (runtime && runtime.signature !== signature) {
    trace("relaunch-start", "reason=launch-context-drift");
    cliBackendLog.info(
      `cli persistent relaunch: provider=${params.context.params.provider} reason=launch-context-drift session=${runtimeKey}`,
    );
    await closePersistentRuntime(runtime, "manual-cancel");
    runtime = undefined;
    trace("relaunch-done", "reason=launch-context-drift");
  }

  if (!runtime) {
    if (!explicitResumeSessionId) {
      clearPersistentRuntimeSessionId(runtimeKey);
    }
    trace("launch-needed");
    runtime = await launchPersistentRuntime({
      context: params.context,
      backend: params.backend,
      env: params.env,
      supervisor: params.supervisor,
      runtimeKey,
      signature,
      resumeSessionId: explicitResumeSessionId,
      initialSessionId: params.resolvedSessionId,
      logOutputText: params.logOutputText,
    });
  } else {
    trace(
      "runtime-reuse",
      `completedTurns=${runtime.turnCount} ageMs=${Math.max(0, Date.now() - runtime.launchedAtMs)} idleMs=${Math.max(
        0,
        Date.now() - runtime.lastActivityAtMs,
      )} session=${runtime.sessionId ?? "none"}`,
    );
  }

  const replyBackendHandle = params.context.params.replyOperation
    ? {
        kind: "cli" as const,
        cancel: () => {
          runtime?.managedRun.cancel("manual-cancel");
        },
        isStreaming: () => false,
      }
    : undefined;

  const abortTurn = () => {
    runtime?.managedRun.cancel("manual-cancel");
  };
  if (params.context.params.abortSignal?.aborted) {
    abortTurn();
    throw createPersistentCliAbortError();
  }

  try {
    if (replyBackendHandle) {
      params.context.params.replyOperation?.attachBackend(replyBackendHandle);
    }
    const turnPromise = beginPersistentTurn({
      runtime,
      context: params.context,
      prompt: params.prompt,
      timeoutMs: params.timeoutMs,
      noOutputTimeoutMs: params.noOutputTimeoutMs,
      onAssistantDelta: params.onAssistantDelta,
    });
    trace("turn-begun");
    params.context.params.abortSignal?.addEventListener("abort", abortTurn, { once: true });
    if (params.context.params.abortSignal?.aborted) {
      abortTurn();
    }
    const result = await turnPromise;
    trace(
      "turn-complete",
      `sessionId=${result.sessionId ?? "none"} stdoutChars=${result.stdout.length} stderrChars=${result.stderr.length} durationMs=${result.durationMs}`,
    );
    if (result.sessionId) {
      runtime.sessionId = result.sessionId;
    }
    return result;
  } finally {
    params.context.params.abortSignal?.removeEventListener("abort", abortTurn);
    if (replyBackendHandle) {
      params.context.params.replyOperation?.detachBackend(replyBackendHandle);
    }
  }
}

export async function resetPersistentCliRuntimesForTest(): Promise<void> {
  const runtimes = [...RUNTIMES.values()];
  RUNTIMES.clear();
  PERSISTENT_RUNTIME_SESSION_IDS.clear();
  if (persistentRuntimeReaper) {
    clearInterval(persistentRuntimeReaper);
    persistentRuntimeReaper = null;
  }
  persistentRuntimeReaperPromise = null;
  await Promise.all(
    runtimes.map(async (runtime) => {
      runtime.managedRun.cancel("manual-cancel");
      try {
        await runtime.exitPromise;
      } catch {
        // Test cleanup intentionally ignores background runtime failures.
      }
    }),
  );
}

export async function reapPersistentCliRuntimesForTest(nowMs?: number): Promise<void> {
  await reapPersistentCliRuntimes(nowMs);
}
