/**
 * Manages reusable Claude CLI stdio sessions for CLI-backed agent turns.
 */
import crypto from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ReplyBackendHandle } from "../../auto-reply/reply/reply-run-registry.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import type { CliBackendConfig } from "../../config/types.js";
import { createAbortError as createNamedAbortError } from "../../infra/abort-signal.js";
import {
  emitTrustedDiagnosticEvent,
  type DiagnosticPhaseDetails,
  type DiagnosticToolParamsSummary,
  type DiagnosticToolSource,
  type DiagnosticToolExecutionErrorEvent,
  type DiagnosticToolExecutionCompletedEvent,
} from "../../infra/diagnostic-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  loadExecApprovals,
  maxAsk,
  minSecurity,
  normalizeExecAsk,
  resolveExecApprovalsFromFile,
  type ExecAsk,
  type ExecSecurity,
} from "../../infra/exec-approvals.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS,
  createCliJsonlStreamingParser,
  extractCliErrorMessage,
  parseCliOutput,
  type CliOutput,
  type CliStreamJsonOutputLimits,
  type CliStreamingBoundary,
  type CliStreamingDelta,
  type CliToolResultDelta,
  type CliToolUseStartDelta,
  resolveCliStreamJsonOutputLimits,
} from "../cli-output.js";
import { classifyFailoverReason } from "../embedded-agent-helpers.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import { prepareCliBundleMcpCaptureAttempt } from "./bundle-mcp.js";
import { isClaudePrintModeArg } from "./claude-print-args.js";
import { buildClaudeOwnerKey } from "./helpers.js";
import { cliBackendLog, formatCliBackendOutputDigest } from "./log.js";
import type { PreparedCliRunContext } from "./types.js";

type ProcessSupervisor = ReturnType<
  typeof import("../../process/supervisor/index.js").getProcessSupervisor
>;
type ManagedRun = Awaited<ReturnType<ProcessSupervisor["spawn"]>>;
type ClaudeLiveTurn = {
  backend: CliBackendConfig;
  diagnosticRefs: ClaudeLiveDiagnosticRefs;
  outputLimits: ClaudeLiveOutputLimits;
  startedAtMs: number;
  processAgeMs: number;
  sessionReuse: ClaudeLiveSessionReuse;
  restartReason?: ClaudeLiveRestartReason;
  fingerprintChange?: string;
  timings: ClaudeLiveTurnTimings;
  rawLines: string[];
  rawChars: number;
  sessionId?: string;
  noOutputTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
  activeToolTimer: NodeJS.Timeout | null;
  activeTools: Map<string, ClaudeLiveActiveTool>;
  observedStdout: boolean;
  streamingParser: ReturnType<typeof createCliJsonlStreamingParser>;
  execPermission: ClaudeLiveExecPermission;
  resolve: (output: CliOutput) => void;
  reject: (error: unknown) => void;
};
type ClaudeLiveSession = {
  key: string;
  fingerprint: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  pinnedMain: boolean;
  pinnedMainOwnerKey?: string;
  retireAfterTurn: boolean;
  turnPending: boolean;
  managedRun: ManagedRun;
  providerId: string;
  modelId: string;
  noOutputTimeoutMs: number;
  stderr: string;
  stdoutBuffer: string;
  currentTurn: ClaudeLiveTurn | null;
  idleTimer: NodeJS.Timeout | null;
  cleanup: () => Promise<void>;
  cleanupPromise: Promise<void> | null;
  closing: boolean;
  mcpCaptureKey?: string;
};
type ClaudeLiveSessionCreate = {
  promise: Promise<ClaudeLiveSession>;
  pinnedMainOwnerKey?: string;
  retireAfterTurn: boolean;
};
type ClaudeLiveRunResult = {
  output: CliOutput;
};
type ClaudeLiveOutputLimits = CliStreamJsonOutputLimits;
type ClaudeLiveExecPermission = {
  security: ExecSecurity;
  ask: ExecAsk;
  permissionMode: "bypassPermissions" | "default";
};
type ClaudeLiveDiagnosticRefs = {
  runId: string;
  sessionId: string;
  sessionKey?: string;
};
type ClaudeLiveActiveTool = {
  toolName: string;
  toolCallId: string;
  startedAt: number;
};
type ClaudeLiveToolUse = {
  toolName: string;
  toolCallId: string;
  paramsSummary?: DiagnosticToolParamsSummary;
};
type ClaudeLiveSessionReuse = "cold_miss" | "warm_hit";
type ClaudeLiveRestartReason = "fingerprint_changed" | "max_age" | "non_resume_turn";
type ClaudeLiveTurnOutcome = "aborted" | "completed" | "error";
type ClaudeLiveTurnTimings = {
  stdinWriteMs?: number;
  timeToFirstStdoutByteMs?: number;
  timeToFirstParsedRecordMs?: number;
  timeToFirstAssistantDeltaMs?: number;
  timeToResultMs?: number;
};

const CLAUDE_LIVE_IDLE_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
const CLAUDE_LIVE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const CLAUDE_LIVE_ACTIVE_TOOL_PROGRESS_MS = 10_000;
const CLAUDE_LIVE_MAX_SESSIONS = 16;
const CLAUDE_LIVE_MAX_STDERR_CHARS = 64 * 1024;
const CLAUDE_LIVE_CLOSE_WAIT_TIMEOUT_MS = 5_000;
const liveSessions = new Map<string, ClaudeLiveSession>();
const liveSessionCreates = new Map<string, ClaudeLiveSessionCreate>();

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Closes all live Claude CLI sessions and clears creation promises for tests. */
export function resetClaudeLiveSessionsForTest(): void {
  for (const session of liveSessions.values()) {
    closeLiveSession(session, "restart");
  }
  liveSessions.clear();
  liveSessionCreates.clear();
}

async function waitForManagedRunExit(managedRun: ManagedRun): Promise<void> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      managedRun.wait().then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, CLAUDE_LIVE_CLOSE_WAIT_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/** Closes the live Claude session associated with a prepared run context, if one exists. */
export async function closeClaudeLiveSessionForContext(
  context: PreparedCliRunContext,
): Promise<void> {
  const key = buildClaudeLiveKey(context);
  const session = liveSessions.get(key);
  if (session) {
    closeLiveSession(session, "restart");
    await Promise.all([waitForManagedRunExit(session.managedRun), cleanupLiveSession(session)]);
  }
  liveSessionCreates.delete(key);
}

/** Close a tainted live process so its replacement gets a fresh MCP capture key. */
export async function rotateClaudeLiveMcpCaptureKeyForContext(
  context: PreparedCliRunContext,
): Promise<void> {
  await closeClaudeLiveSessionForContext(context);
}

/** Returns whether a prepared backend context is eligible for Claude live stdio reuse. */
export function shouldUseClaudeLiveSession(context: PreparedCliRunContext): boolean {
  return (
    context.backendResolved.id === "claude-cli" &&
    context.preparedBackend.backend.liveSession === "claude-stdio" &&
    context.preparedBackend.backend.output === "jsonl" &&
    context.preparedBackend.backend.input === "stdin"
  );
}

function upsertArgValue(args: string[], flag: string, value: string): string[] {
  const normalized: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === flag) {
      i += 1;
      continue;
    }
    if (arg.startsWith(`${flag}=`)) {
      continue;
    }
    normalized.push(arg);
  }
  normalized.push(flag, value);
  return normalized;
}

function appendArg(args: string[], flag: string): string[] {
  return args.includes(flag) ? args : [...args, flag];
}

function stripLiveProcessArgs(
  args: string[],
  backend: CliBackendConfig,
  stripSystemPrompt: boolean,
): string[] {
  const liveProcessFlags = new Set(
    [
      backend.sessionArg,
      "--session-id",
      stripSystemPrompt ? backend.systemPromptArg : undefined,
      stripSystemPrompt ? backend.systemPromptFileArg : undefined,
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  const stripped: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    // A piped Claude stream-json process is already headless. Never leak the
    // one-shot print selector into the persistent child, including from a
    // legacy custom backend override.
    if (isClaudePrintModeArg(arg)) {
      continue;
    }
    if (liveProcessFlags.has(arg)) {
      i += 1;
      continue;
    }
    if ([...liveProcessFlags].some((flag) => arg.startsWith(`${flag}=`))) {
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
}

/** Builds Claude CLI args for stream-json live sessions, stripping one-shot session flags. */
export function buildClaudeLiveArgs(params: {
  args: string[];
  backend: CliBackendConfig;
  systemPrompt: string;
  useResume: boolean;
  permissionMode?: string;
}): string[] {
  const liveArgs = appendArg(
    upsertArgValue(
      upsertArgValue(
        upsertArgValue(
          stripLiveProcessArgs(
            params.args,
            params.backend,
            params.useResume && params.backend.systemPromptWhen !== "always",
          ),
          "--input-format",
          "stream-json",
        ),
        "--output-format",
        "stream-json",
      ),
      "--permission-prompt-tool",
      "stdio",
    ),
    "--replay-user-messages",
  );
  // Live sessions always speak stream-json over stdin/stdout. Strip stale one-shot args above, then
  // force the live protocol flags so resume and non-resume turns share the same process contract.
  return params.permissionMode
    ? upsertArgValue(liveArgs, "--permission-mode", params.permissionMode)
    : liveArgs;
}

function buildClaudeLiveKey(context: PreparedCliRunContext): string {
  return `${context.backendResolved.id}:${buildClaudeOwnerKey({
    agentId: context.params.agentId,
    sessionId: context.params.sessionId,
    sessionKey: context.params.sessionKey,
  })}`;
}

function isCanonicalMainSession(context: PreparedCliRunContext): boolean {
  const sessionKey = context.params.sessionKey?.trim();
  if (!sessionKey) {
    return false;
  }
  const agentId = context.params.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  return sessionKey === resolveAgentMainSessionKey({ cfg: context.params.config, agentId });
}

function resolvePinnedMainOwnerKey(context: PreparedCliRunContext): string | undefined {
  const sessionKey = context.params.sessionKey?.trim();
  if (!sessionKey || !isCanonicalMainSession(context)) {
    return undefined;
  }
  const agentId = context.params.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  return `${context.backendResolved.id}:${buildClaudeOwnerKey({
    agentId,
    sessionKey,
  })}`;
}

function buildClaudeLiveFingerprint(params: {
  context: PreparedCliRunContext;
  argv: string[];
  env: Record<string, string>;
}): string {
  const perTurnMcpEnvKeys = new Set([
    // Account is a per-turn delivery fact like the channel fields below; an
    // internal turn (no account) sharing the session's process must not
    // respawn it via a fingerprint flip.
    "OPENCLAW_MCP_ACCOUNT_ID",
    "OPENCLAW_MCP_MESSAGE_CHANNEL",
    "OPENCLAW_MCP_CURRENT_CHANNEL_ID",
    "OPENCLAW_MCP_CURRENT_THREAD_TS",
    "OPENCLAW_MCP_CURRENT_MESSAGE_ID",
    "OPENCLAW_MCP_CURRENT_INBOUND_AUDIO",
    "OPENCLAW_MCP_INBOUND_EVENT_KIND",
    "OPENCLAW_MCP_SOURCE_REPLY_DELIVERY_MODE",
    "OPENCLAW_MCP_REQUIRE_EXPLICIT_MESSAGE_TARGET",
    "OPENCLAW_MCP_CLI_CAPTURE_KEY",
  ]);
  const normalizeMcpConfigPath = Boolean(params.context.preparedBackend.mcpConfigHash);
  const skillSnapshot = params.context.params.skillsSnapshot;
  // Content-derived fields only: the snapshot `version` is a watcher counter
  // that bumps on any file event (touch, git ops, config reload) even when the
  // rebuilt snapshot is byte-identical, and hashing it respawned warm
  // processes for no behavior change.
  const skillsFingerprint = skillSnapshot
    ? sha256(
        JSON.stringify({
          promptHash: sha256(skillSnapshot.prompt),
          skillFilter: skillSnapshot.skillFilter,
          skills: skillSnapshot.skills,
          resolvedSkills: (skillSnapshot.resolvedSkills ?? []).map((skill) => ({
            name: skill.name,
            description: skill.description,
            filePath: skill.filePath,
            sourceInfo: skill.sourceInfo,
          })),
        }),
      )
    : undefined;
  const normalizePluginDir = Boolean(skillsFingerprint);
  const omittedValueFlags = new Set(
    [
      params.context.preparedBackend.backend.systemPromptArg,
      params.context.preparedBackend.backend.systemPromptFileArg,
      "--resume",
      "-r",
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  const unstableValueFlags = new Set(
    [
      params.context.preparedBackend.backend.sessionArg,
      "--session-id",
      normalizeMcpConfigPath ? "--mcp-config" : undefined,
      normalizePluginDir ? "--plugin-dir" : undefined,
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  const stableArgv: string[] = [];
  for (let i = 0; i < params.argv.length; i += 1) {
    const entry = params.argv[i] ?? "";
    if (omittedValueFlags.has(entry)) {
      i += 1;
      continue;
    }
    if ([...omittedValueFlags].some((flag) => entry.startsWith(`${flag}=`))) {
      continue;
    }
    if (unstableValueFlags.has(entry)) {
      stableArgv.push("<unstable>");
      i += 1;
      continue;
    }
    if ([...unstableValueFlags].some((flag) => entry.startsWith(`${flag}=`))) {
      stableArgv.push("<unstable>");
      continue;
    }
    stableArgv.push(entry);
  }
  return JSON.stringify({
    command: params.context.preparedBackend.backend.command,
    workspaceDirHash: sha256(params.context.workspaceDir),
    cwdHash: params.context.cwdHash ?? sha256(params.context.cwd ?? params.context.workspaceDir),
    provider: params.context.params.provider,
    model: params.context.normalizedModel,
    // The composed system prompt is reassembled every turn (heartbeat text,
    // hook context, media tasks), so it must NOT be part of the reuse
    // fingerprint: a warm process owns its launch-time prompt until it
    // restarts for another reason. Killing it per drift costs a cold start
    // and the whole prompt cache each turn.
    // Auth profile/epoch stay out too: the claude-cli child authenticates from
    // its own credential store (OpenClaw clears ANTHROPIC_* from its env), so
    // a warm process absorbs any credential change without a respawn.
    // A changed tool topology MUST respawn: the CLI client refreshes MCP tools
    // only on a tools/list_changed notification, which the loopback never
    // emits, so a warm process would otherwise keep its launch-time tool list
    // forever. The hash is session-stable (delivery facts are zeroed in
    // prepare), so only real config/plugin tool changes flip it.
    promptToolNamesHash: params.context.promptToolNamesHash,
    // The loopback MCP port changes across gateway restarts; the resume hash is
    // port-canonicalized so a loopback rebind alone must not kill a warm
    // process. Raw-hash fallback mirrors the binding comparison in cli-session.
    mcpConfigHash:
      params.context.preparedBackend.mcpResumeHash ?? params.context.preparedBackend.mcpConfigHash,
    skillsFingerprint,
    argv: stableArgv,
    // Only deliberately staged env participates (backend config env plus
    // prepared launch env such as OPENCLAW_MCP_*): inherited host env is
    // frozen for the gateway lifetime, and skill env overrides mutate
    // process.env globally for a run's duration, so hashing every key let an
    // overlapping run of another session leak temporary values into this
    // snapshot and force a respawn.
    env: (() => {
      const stagedEnvKeys = new Set([
        ...Object.keys(params.context.preparedBackend.backend.env ?? {}),
        ...Object.keys(params.context.preparedBackend.env ?? {}),
      ]);
      return Object.keys(params.env)
        .filter((key) => !perTurnMcpEnvKeys.has(key) && stagedEnvKeys.has(key))
        .toSorted()
        .map((key) => [key, params.env[key] ? sha256(params.env[key]) : ""]);
    })(),
  });
}

/**
 * Names the fingerprint components that changed between two launches so
 * operators can see WHY a warm process restarted. Emits component names (and
 * env var names, whose values are already hashed) only — never argv values,
 * prompts, or hashes themselves, matching the restart-log redaction invariant.
 */
export function summarizeClaudeLiveFingerprintChange(
  previousFingerprint: string,
  nextFingerprint: string,
): string | undefined {
  if (previousFingerprint === nextFingerprint) {
    return undefined;
  }
  let previous: Record<string, unknown>;
  let next: Record<string, unknown>;
  try {
    previous = JSON.parse(previousFingerprint) as Record<string, unknown>;
    next = JSON.parse(nextFingerprint) as Record<string, unknown>;
  } catch {
    return "unparsed";
  }
  const describeEnvChange = (): string => {
    const toEnvMap = (value: unknown): Map<string, string> =>
      new Map(Array.isArray(value) ? (value as Array<[string, string]>) : []);
    const previousEnv = toEnvMap(previous.env);
    const nextEnv = toEnvMap(next.env);
    const changedKeys = [...new Set([...previousEnv.keys(), ...nextEnv.keys()])]
      .filter((key) => previousEnv.get(key) !== nextEnv.get(key))
      .toSorted();
    return changedKeys.length > 0 ? `env(${changedKeys.join("|")})` : "env";
  };
  const changed = [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
    .toSorted()
    .map((key) => (key === "env" ? describeEnvChange() : key));
  return changed.length > 0 ? changed.join(",") : "unchanged";
}

function createAbortError(): Error {
  return createNamedAbortError("CLI run aborted");
}

function clearTurnTimers(turn: ClaudeLiveTurn): void {
  if (turn.noOutputTimer) {
    clearTimeout(turn.noOutputTimer);
    turn.noOutputTimer = null;
  }
  if (turn.timeoutTimer) {
    clearTimeout(turn.timeoutTimer);
    turn.timeoutTimer = null;
  }
  if (turn.activeToolTimer) {
    clearInterval(turn.activeToolTimer);
    turn.activeToolTimer = null;
  }
}

function elapsedClaudeLiveTurnMs(turn: ClaudeLiveTurn, now = Date.now()): number {
  return Math.max(0, now - turn.startedAtMs);
}

function emitClaudeLiveTurnTiming(
  session: ClaudeLiveSession,
  turn: ClaudeLiveTurn,
  outcome: ClaudeLiveTurnOutcome,
) {
  const endedAt = Date.now();
  const durationMs = elapsedClaudeLiveTurnMs(turn, endedAt);
  const details = {
    runId: turn.diagnosticRefs.runId,
    provider: session.providerId,
    model: session.modelId,
    sessionReuse: turn.sessionReuse,
    outcome,
    processAgeMs: turn.processAgeMs,
    ...(turn.restartReason ? { restartReason: turn.restartReason } : {}),
    ...(turn.fingerprintChange ? { fingerprintChange: turn.fingerprintChange } : {}),
    ...turn.timings,
  } satisfies DiagnosticPhaseDetails;
  emitTrustedDiagnosticEvent({
    type: "diagnostic.phase.completed",
    name: "claude.live.turn",
    startedAt: turn.startedAtMs,
    endedAt,
    durationMs,
    details,
  });
  return { durationMs, details };
}

function finishTurn(session: ClaudeLiveSession, output: CliOutput): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  completeActiveClaudeLiveTools(turn);
  clearTurnTimers(turn);
  turn.streamingParser.finish();
  const timing = emitClaudeLiveTurnTiming(session, turn, "completed");
  // Keep the per-stage latencies in the message line itself: operators diagnose
  // warm/cold latency from default logs, not from diagnostic-event subscribers.
  const stageTimings = turn.timings;
  cliBackendLog.info(
    `claude live session turn: provider=${session.providerId} model=${session.modelId} reuse=${turn.sessionReuse}${
      turn.restartReason ? ` restart=${turn.restartReason}` : ""
    } durationMs=${timing.durationMs} stdinMs=${stageTimings.stdinWriteMs ?? "-"} firstStdoutMs=${
      stageTimings.timeToFirstStdoutByteMs ?? "-"
    } firstDeltaMs=${stageTimings.timeToFirstAssistantDeltaMs ?? "-"} resultMs=${
      stageTimings.timeToResultMs ?? "-"
    } rawLines=${turn.rawLines.length} ${formatCliBackendOutputDigest(output.text)}`,
    timing.details,
  );
  session.currentTurn = null;
  session.lastUsedAtMs = Date.now();
  turn.resolve(output);
  scheduleIdleClose(session);
}

function failTurn(session: ClaudeLiveSession, error: unknown): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  const errorKind =
    error instanceof FailoverError
      ? error.reason
      : error instanceof Error && error.name === "AbortError"
        ? "aborted"
        : "error";
  failActiveClaudeLiveTools(turn, error);
  clearTurnTimers(turn);
  turn.streamingParser.finish();
  const outcome = errorKind === "aborted" ? "aborted" : "error";
  const timing = emitClaudeLiveTurnTiming(session, turn, outcome);
  cliBackendLog.warn(
    `claude live session turn failed: provider=${session.providerId} model=${session.modelId} durationMs=${timing.durationMs} error=${errorKind}`,
    { ...timing.details, errorCategory: errorKind },
  );
  session.currentTurn = null;
  session.lastUsedAtMs = Date.now();
  turn.reject(error);
}

function abortTurn(session: ClaudeLiveSession, error: Error): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  closeLiveSession(session, "abort", error);
}

function cleanupLiveSession(session: ClaudeLiveSession): Promise<void> {
  if (!session.cleanupPromise) {
    session.cleanupPromise = session.cleanup().catch((error: unknown) => {
      cliBackendLog.warn(`Claude live session cleanup failed: ${formatErrorMessage(error)}`);
    });
  }
  return session.cleanupPromise;
}

function closeLiveSession(
  session: ClaudeLiveSession,
  reason: "idle" | "restart" | "abort",
  error?: unknown,
): void {
  if (session.closing) {
    return;
  }
  cliBackendLog.info(
    `claude live session close: provider=${session.providerId} model=${session.modelId} reason=${reason}`,
  );
  session.closing = true;
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  if (liveSessions.get(session.key) === session) {
    liveSessions.delete(session.key);
  }
  if (error) {
    failTurn(session, error);
  }
  session.managedRun.cancel("manual-cancel");
  void cleanupLiveSession(session);
}

function scheduleIdleClose(session: ClaudeLiveSession): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  if (session.retireAfterTurn) {
    closeLiveSession(session, "restart");
    return;
  }
  if (session.pinnedMain) {
    return;
  }
  session.idleTimer = setTimeout(() => {
    if (!session.currentTurn) {
      closeLiveSession(session, "idle");
    }
  }, CLAUDE_LIVE_IDLE_TIMEOUT_MS);
}

function createTimeoutError(
  session: ClaudeLiveSession,
  message: string,
  code?: string,
): FailoverError {
  return new FailoverError(message, {
    reason: "timeout",
    provider: session.providerId,
    model: session.modelId,
    status: resolveFailoverStatus("timeout"),
    code,
  });
}

function createOutputLimitError(session: ClaudeLiveSession, message: string): FailoverError {
  return new FailoverError(message, {
    reason: "format",
    provider: session.providerId,
    model: session.modelId,
    status: resolveFailoverStatus("format"),
  });
}

function diagnosticToolSourceForClaudeLiveTool(toolName: string): DiagnosticToolSource {
  return toolName.startsWith("mcp__") ? "mcp" : "core";
}

function claudeLiveDiagnosticBase(turn: ClaudeLiveTurn) {
  return {
    runId: turn.diagnosticRefs.runId,
    sessionId: turn.diagnosticRefs.sessionId,
    ...(turn.diagnosticRefs.sessionKey ? { sessionKey: turn.diagnosticRefs.sessionKey } : {}),
  };
}

function emitClaudeLiveProgress(turn: ClaudeLiveTurn, reason: string): void {
  emitTrustedDiagnosticEvent({
    type: "run.progress",
    ...claudeLiveDiagnosticBase(turn),
    reason,
  });
}

function summarizeClaudeLiveToolInput(input: unknown): DiagnosticToolParamsSummary | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (input === null) {
    return { kind: "null" };
  }
  if (Array.isArray(input)) {
    return { kind: "array", length: input.length };
  }
  switch (typeof input) {
    case "object":
      return { kind: "object" };
    case "string":
      return { kind: "string", length: input.length };
    case "number":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    case "undefined":
      return { kind: "undefined" };
    default:
      return { kind: "other" };
  }
}

function readClaudeLiveMessageContent(parsed: Record<string, unknown>): unknown[] {
  const message = parsed.message;
  if (!isRecord(message)) {
    return [];
  }
  const content = message.content;
  return Array.isArray(content) ? content : [];
}

function readClaudeLiveToolUses(parsed: Record<string, unknown>): ClaudeLiveToolUse[] {
  const tools: ClaudeLiveToolUse[] = [];
  for (const entry of readClaudeLiveMessageContent(parsed)) {
    if (!isRecord(entry) || entry.type !== "tool_use") {
      continue;
    }
    const toolName = typeof entry.name === "string" ? entry.name.trim() : "";
    const toolCallId = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!toolName || !toolCallId) {
      continue;
    }
    tools.push({
      toolName,
      toolCallId,
      paramsSummary: summarizeClaudeLiveToolInput(entry.input),
    });
  }
  return tools;
}

function readClaudeLiveToolResultIds(parsed: Record<string, unknown>): string[] {
  const toolResultIds: string[] = [];
  for (const entry of readClaudeLiveMessageContent(parsed)) {
    if (!isRecord(entry) || entry.type !== "tool_result") {
      continue;
    }
    const toolCallId = typeof entry.tool_use_id === "string" ? entry.tool_use_id.trim() : "";
    if (toolCallId) {
      toolResultIds.push(toolCallId);
    }
  }
  return toolResultIds;
}

function startClaudeLiveActiveToolHeartbeat(turn: ClaudeLiveTurn): void {
  if (turn.activeToolTimer || turn.activeTools.size === 0) {
    return;
  }
  turn.activeToolTimer = setInterval(() => {
    if (turn.activeTools.size === 0) {
      if (turn.activeToolTimer) {
        clearInterval(turn.activeToolTimer);
        turn.activeToolTimer = null;
      }
      return;
    }
    emitClaudeLiveProgress(turn, "cli_live:tool_running");
  }, CLAUDE_LIVE_ACTIVE_TOOL_PROGRESS_MS);
  turn.activeToolTimer.unref?.();
}

function stopClaudeLiveActiveToolHeartbeatIfIdle(turn: ClaudeLiveTurn): void {
  if (turn.activeTools.size > 0 || !turn.activeToolTimer) {
    return;
  }
  clearInterval(turn.activeToolTimer);
  turn.activeToolTimer = null;
}

function markClaudeLiveToolStarted(turn: ClaudeLiveTurn, tool: ClaudeLiveToolUse): void {
  const now = Date.now();
  turn.activeTools.set(tool.toolCallId, {
    toolName: tool.toolName,
    toolCallId: tool.toolCallId,
    startedAt: now,
  });
  emitTrustedDiagnosticEvent({
    type: "tool.execution.started",
    ...claudeLiveDiagnosticBase(turn),
    toolName: tool.toolName,
    toolSource: diagnosticToolSourceForClaudeLiveTool(tool.toolName),
    toolOwner: "claude-cli",
    toolCallId: tool.toolCallId,
    ...(tool.paramsSummary ? { paramsSummary: tool.paramsSummary } : {}),
  });
  emitClaudeLiveProgress(turn, "cli_live:tool_started");
  startClaudeLiveActiveToolHeartbeat(turn);
}

function markClaudeLiveToolCompleted(turn: ClaudeLiveTurn, toolCallId: string): void {
  const activeTool = turn.activeTools.get(toolCallId);
  if (!activeTool) {
    emitClaudeLiveProgress(turn, "cli_live:tool_result");
    return;
  }
  turn.activeTools.delete(toolCallId);
  const event: Omit<DiagnosticToolExecutionCompletedEvent, "seq" | "ts" | "type"> = {
    ...claudeLiveDiagnosticBase(turn),
    toolName: activeTool.toolName,
    toolSource: diagnosticToolSourceForClaudeLiveTool(activeTool.toolName),
    toolOwner: "claude-cli",
    toolCallId: activeTool.toolCallId,
    durationMs: Math.max(0, Date.now() - activeTool.startedAt),
  };
  emitTrustedDiagnosticEvent({
    type: "tool.execution.completed",
    ...event,
  });
  emitClaudeLiveProgress(turn, "cli_live:tool_result");
  stopClaudeLiveActiveToolHeartbeatIfIdle(turn);
}

function completeActiveClaudeLiveTools(turn: ClaudeLiveTurn): void {
  const activeToolCallIds = Array.from(turn.activeTools.keys());
  for (const toolCallId of activeToolCallIds) {
    markClaudeLiveToolCompleted(turn, toolCallId);
  }
}

function failActiveClaudeLiveTools(turn: ClaudeLiveTurn, error: unknown): void {
  const errorCategory = error instanceof Error && error.name === "AbortError" ? "aborted" : "error";
  for (const activeTool of turn.activeTools.values()) {
    const event: Omit<DiagnosticToolExecutionErrorEvent, "seq" | "ts" | "type"> = {
      ...claudeLiveDiagnosticBase(turn),
      toolName: activeTool.toolName,
      toolSource: diagnosticToolSourceForClaudeLiveTool(activeTool.toolName),
      toolOwner: "claude-cli",
      toolCallId: activeTool.toolCallId,
      durationMs: Math.max(0, Date.now() - activeTool.startedAt),
      errorCategory,
    };
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      ...event,
    });
  }
  turn.activeTools.clear();
}

function noteClaudeLiveProgress(turn: ClaudeLiveTurn, parsed: Record<string, unknown>): void {
  const toolUses = readClaudeLiveToolUses(parsed);
  const toolResultIds = readClaudeLiveToolResultIds(parsed);
  for (const tool of toolUses) {
    markClaudeLiveToolStarted(turn, tool);
  }
  for (const toolCallId of toolResultIds) {
    markClaudeLiveToolCompleted(turn, toolCallId);
  }
  if (parsed.type === "result") {
    emitClaudeLiveProgress(turn, "cli_live:result");
    return;
  }
  if (toolUses.length > 0 || toolResultIds.length > 0) {
    return;
  }
  emitClaudeLiveProgress(turn, "cli_live:stream_progress");
}

function resetNoOutputTimer(session: ClaudeLiveSession): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  if (turn.noOutputTimer) {
    clearTimeout(turn.noOutputTimer);
  }
  turn.noOutputTimer = setTimeout(() => {
    closeLiveSession(
      session,
      "abort",
      createTimeoutError(
        session,
        `CLI produced no output for ${Math.round(session.noOutputTimeoutMs / 1000)}s and was terminated.`,
      ),
    );
  }, session.noOutputTimeoutMs);
}

function parseSessionId(parsed: Record<string, unknown>): string | undefined {
  const sessionId =
    typeof parsed.session_id === "string"
      ? parsed.session_id.trim()
      : typeof parsed.sessionId === "string"
        ? parsed.sessionId.trim()
        : "";
  return sessionId || undefined;
}

function readConfiguredExecPolicy(context: PreparedCliRunContext): {
  security: ExecSecurity;
  ask: ExecAsk;
  agentId: string;
} {
  const agentId = context.params.agentId ?? resolveAgentIdFromSessionKey(context.params.sessionKey);
  const agentExec = context.params.config?.agents?.list?.find((agent) => agent.id === agentId)
    ?.tools?.exec;
  const exec = agentExec ?? context.params.config?.tools?.exec;
  const security = exec?.security ?? "full";
  const configuredAsk = exec?.ask ?? "off";
  const sessionAsk = normalizeExecAsk(context.params.sessionEntry?.execAsk);
  return {
    agentId,
    security,
    ask: sessionAsk ? maxAsk(configuredAsk, sessionAsk) : configuredAsk,
  };
}

function resolveClaudeLiveExecPermission(context: PreparedCliRunContext): ClaudeLiveExecPermission {
  const configured = readConfiguredExecPolicy(context);
  const approvals = resolveExecApprovalsFromFile({
    file: loadExecApprovals(),
    agentId: configured.agentId,
    overrides: {
      security: configured.security,
      ask: configured.ask,
    },
  });
  const security = minSecurity(configured.security, approvals.agent.security);
  const ask = maxAsk(configured.ask, approvals.agent.ask);
  return {
    security,
    ask,
    permissionMode: security === "full" && ask === "off" ? "bypassPermissions" : "default",
  };
}

function parseClaudeLiveJsonLine(
  session: ClaudeLiveSession,
  trimmed: string,
): Record<string, unknown> | null {
  const maxPendingLineChars =
    session.currentTurn?.outputLimits.maxPendingLineChars ??
    CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS;
  if (trimmed.length > maxPendingLineChars) {
    closeLiveSession(
      session,
      "abort",
      createOutputLimitError(session, "Claude CLI JSONL line exceeded output limit."),
    );
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

function createParsedOutputError(session: ClaudeLiveSession, output: CliOutput): FailoverError {
  const message = output.errorText || "Claude CLI failed.";
  const reason = classifyFailoverReason(message, { provider: session.providerId }) ?? "unknown";
  const code = reason === "context_overflow" ? "cli_context_overflow" : undefined;
  return new FailoverError(message, {
    reason,
    provider: session.providerId,
    model: session.modelId,
    status: resolveFailoverStatus(reason),
    code,
  });
}

function writeClaudeLiveControlResponse(session: ClaudeLiveSession, response: unknown): void {
  const stdin = session.managedRun.stdin;
  if (!stdin) {
    throw new Error("Claude CLI live session stdin is unavailable");
  }
  stdin.write(`${JSON.stringify(response)}\n`);
}

function handleClaudeLiveControlRequest(
  session: ClaudeLiveSession,
  turn: ClaudeLiveTurn,
  parsed: Record<string, unknown>,
): void {
  if (parsed.type !== "control_request" || !isRecord(parsed.request)) {
    return;
  }
  const request = parsed.request;
  if (request.subtype !== "can_use_tool") {
    return;
  }
  const requestId = typeof parsed.request_id === "string" ? parsed.request_id : "";
  if (!requestId) {
    return;
  }
  const toolUseId = typeof request.tool_use_id === "string" ? request.tool_use_id : undefined;
  const toolInput = isRecord(request.input) ? request.input : {};
  const allowed = turn.execPermission.security === "full" && turn.execPermission.ask === "off";
  writeClaudeLiveControlResponse(session, {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: allowed
        ? {
            behavior: "allow",
            updatedInput: toolInput,
            ...(toolUseId ? { toolUseID: toolUseId } : {}),
          }
        : {
            behavior: "deny",
            decisionClassification: "user_reject",
            message: `OpenClaw exec policy denied Claude native tool use (security=${turn.execPermission.security}, ask=${turn.execPermission.ask}).`,
          },
    },
  });
}

function handleClaudeLiveLine(session: ClaudeLiveSession, line: string): void {
  const turn = session.currentTurn;
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  const parsed = parseClaudeLiveJsonLine(session, trimmed);
  if (turn) {
    turn.observedStdout = true;
  }
  if (!parsed) {
    return;
  }
  if (!turn) {
    return;
  }
  turn.timings.timeToFirstParsedRecordMs ??= elapsedClaudeLiveTurnMs(turn);
  if (parsed.type === "result") {
    turn.timings.timeToResultMs ??= elapsedClaudeLiveTurnMs(turn);
  }
  turn.rawChars += trimmed.length + 1;
  if (
    turn.rawChars > turn.outputLimits.maxTurnRawChars ||
    turn.rawLines.length >= turn.outputLimits.maxTurnLines
  ) {
    closeLiveSession(
      session,
      "abort",
      createOutputLimitError(session, "Claude CLI turn output exceeded limit."),
    );
    return;
  }
  turn.rawLines.push(trimmed);
  turn.streamingParser.push(`${trimmed}\n`);
  turn.sessionId = parseSessionId(parsed) ?? turn.sessionId;
  noteClaudeLiveProgress(turn, parsed);
  handleClaudeLiveControlRequest(session, turn, parsed);
  if (parsed.type !== "result") {
    return;
  }
  const raw = turn.rawLines.join("\n");
  // Reuse the parser that classified pre-tool text as commentary. Reparsing the
  // transcript loses that boundary when Claude's terminal result is empty.
  const output =
    turn.streamingParser.getOutput() ??
    parseCliOutput({
      raw,
      backend: turn.backend,
      providerId: session.providerId,
      outputMode: "jsonl",
      fallbackSessionId: turn.sessionId,
    });
  if (output.errorText) {
    failTurn(session, createParsedOutputError(session, output));
    scheduleIdleClose(session);
    return;
  }
  finishTurn(session, output);
}

function handleClaudeStdout(session: ClaudeLiveSession, chunk: string) {
  const turn = session.currentTurn;
  if (turn && chunk.length > 0) {
    turn.timings.timeToFirstStdoutByteMs ??= elapsedClaudeLiveTurnMs(turn);
  }
  resetNoOutputTimer(session);
  session.stdoutBuffer += chunk;
  const maxPendingLineChars =
    session.currentTurn?.outputLimits.maxPendingLineChars ??
    CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS;
  if (session.stdoutBuffer.length > maxPendingLineChars) {
    closeLiveSession(
      session,
      "abort",
      createOutputLimitError(session, "Claude CLI JSONL line exceeded output limit."),
    );
    return;
  }
  const lines = session.stdoutBuffer.split(/\r?\n/g);
  session.stdoutBuffer = lines.pop() ?? "";
  try {
    for (const line of lines) {
      handleClaudeLiveLine(session, line);
    }
  } catch (error) {
    closeLiveSession(session, "abort", error);
  }
}

function handleClaudeExit(session: ClaudeLiveSession, exitCode: number | null): void {
  session.closing = true;
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  if (liveSessions.get(session.key) === session) {
    liveSessions.delete(session.key);
  }
  void cleanupLiveSession(session);
  if (!session.currentTurn) {
    return;
  }
  if (session.stdoutBuffer.trim()) {
    try {
      handleClaudeLiveLine(session, session.stdoutBuffer);
    } catch (error) {
      session.stdoutBuffer = "";
      failTurn(session, error);
      return;
    }
    session.stdoutBuffer = "";
  }
  if (!session.currentTurn) {
    return;
  }
  const stderr = session.stderr.trim();
  const fallbackMessage =
    exitCode === 0 ? "Claude CLI exited before completing the turn." : "Claude CLI failed.";
  const message = extractCliErrorMessage(stderr) ?? (stderr || fallbackMessage);
  if (exitCode === 0 && !stderr) {
    const turn = session.currentTurn;
    const retryCode =
      turn && !turn.observedStdout && turn.rawLines.length === 0
        ? "cli_unknown_empty_failure"
        : undefined;
    failTurn(
      session,
      new FailoverError(message, {
        reason: "empty_response",
        provider: session.providerId,
        model: session.modelId,
        status: resolveFailoverStatus("empty_response"),
        code: retryCode,
      }),
    );
    return;
  }
  const reason = classifyFailoverReason(message, { provider: session.providerId }) ?? "unknown";
  const code = reason === "context_overflow" ? "cli_context_overflow" : undefined;
  failTurn(
    session,
    new FailoverError(message, {
      reason,
      provider: session.providerId,
      model: session.modelId,
      status: resolveFailoverStatus(reason),
      code,
    }),
  );
}

function createClaudeUserInputMessage(content: string): string {
  return `${JSON.stringify({
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content,
    },
  })}\n`;
}

async function writeTurnInput(session: ClaudeLiveSession, prompt: string): Promise<void> {
  const stdin = session.managedRun.stdin;
  if (!stdin) {
    throw new Error("Claude CLI live session stdin is unavailable");
  }
  const turn = session.currentTurn;
  const startedAtMs = Date.now();
  await new Promise<void>((resolve, reject) => {
    stdin.write(createClaudeUserInputMessage(prompt), (error) => {
      if (turn) {
        turn.timings.stdinWriteMs ??= Math.max(0, Date.now() - startedAtMs);
      }
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function createClaudeLiveSession(params: {
  context: PreparedCliRunContext;
  argv: string[];
  env: Record<string, string>;
  fingerprint: string;
  key: string;
  mcpCaptureKey?: string;
  noOutputTimeoutMs: number;
  supervisor: ProcessSupervisor;
  cleanup: () => Promise<void>;
}): Promise<ClaudeLiveSession> {
  let session: ClaudeLiveSession | null = null;
  const cleanupLaunchResources = params.context.preparedBackend.takeLiveSessionLaunchCleanup?.();
  let cleanupMcpCaptureAttempt: (() => Promise<void>) | undefined;
  let childCleanupPromise: Promise<void> | undefined;
  const cleanupChildResources = () => {
    childCleanupPromise ??= (async () => {
      try {
        await cleanupMcpCaptureAttempt?.();
      } finally {
        try {
          await cleanupLaunchResources?.();
        } finally {
          await params.cleanup();
        }
      }
    })();
    return childCleanupPromise;
  };
  let managedRun: ManagedRun;
  try {
    const mcpCaptureAttempt = await prepareCliBundleMcpCaptureAttempt({
      mode: params.context.backendResolved.bundleMcpMode,
      backend: params.context.preparedBackend.backend,
      env: params.env,
      captureKey: params.mcpCaptureKey,
    });
    cleanupMcpCaptureAttempt = mcpCaptureAttempt.cleanup;
    managedRun = await params.supervisor.spawn({
      sessionId: params.context.params.sessionId,
      backendId: params.context.backendResolved.id,
      scopeKey: `claude-live:${params.key}`,
      replaceExistingScope: true,
      mode: "child",
      argv: params.argv,
      cwd: params.context.cwd ?? params.context.workspaceDir,
      env: mcpCaptureAttempt.env ?? params.env,
      stdinMode: "pipe-open",
      captureOutput: false,
      onStdout: (chunk) => {
        if (session) {
          handleClaudeStdout(session, chunk);
        }
      },
      onStderr: (chunk) => {
        if (session) {
          session.stderr += chunk;
          if (session.stderr.length > CLAUDE_LIVE_MAX_STDERR_CHARS) {
            closeLiveSession(
              session,
              "abort",
              createOutputLimitError(session, "Claude CLI stderr exceeded limit."),
            );
            return;
          }
          resetNoOutputTimer(session);
        }
      },
    });
  } catch (error) {
    try {
      await cleanupChildResources();
    } catch (cleanupError) {
      cliBackendLog.warn(
        `Claude live session launch cleanup failed: ${formatErrorMessage(cleanupError)}`,
      );
    }
    throw error;
  }
  const pinnedMainOwnerKey = resolvePinnedMainOwnerKey(params.context);
  session = {
    key: params.key,
    fingerprint: params.fingerprint,
    createdAtMs: managedRun.startedAtMs,
    lastUsedAtMs: Date.now(),
    pinnedMain: pinnedMainOwnerKey !== undefined,
    pinnedMainOwnerKey,
    retireAfterTurn: false,
    turnPending: true,
    managedRun,
    providerId: params.context.params.provider,
    modelId: params.context.modelId,
    noOutputTimeoutMs: params.noOutputTimeoutMs,
    stderr: "",
    stdoutBuffer: "",
    currentTurn: null,
    idleTimer: null,
    cleanup: cleanupChildResources,
    cleanupPromise: null,
    closing: false,
    mcpCaptureKey: params.mcpCaptureKey,
  };
  void managedRun.wait().then(
    (exit) => handleClaudeExit(session, exit.exitCode),
    (error: unknown) => {
      if (session) {
        closeLiveSession(session, "abort", error);
      }
    },
  );
  liveSessions.set(params.key, session);
  cliBackendLog.info(
    `claude live session start: provider=${session.providerId} model=${session.modelId} activeSessions=${liveSessions.size}`,
  );
  return session;
}

function createTurn(params: {
  context: PreparedCliRunContext;
  noOutputTimeoutMs: number;
  sessionReuse: ClaudeLiveSessionReuse;
  restartReason?: ClaudeLiveRestartReason;
  fingerprintChange?: string;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  onAssistantBoundary?: (boundary: CliStreamingBoundary) => void;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
  onCommentaryText?: (text: string) => void;
  session: ClaudeLiveSession;
  execPermission: ClaudeLiveExecPermission;
  resolve: (output: CliOutput) => void;
  reject: (error: unknown) => void;
}): ClaudeLiveTurn {
  const startedAtMs = Date.now();
  const timings: ClaudeLiveTurnTimings = {};
  const turn: ClaudeLiveTurn = {
    backend: params.context.preparedBackend.backend,
    diagnosticRefs: {
      runId: params.context.params.runId,
      sessionId: params.context.params.sessionId,
      ...(params.context.params.sessionKey ? { sessionKey: params.context.params.sessionKey } : {}),
    },
    outputLimits: resolveCliStreamJsonOutputLimits(params.context.preparedBackend.backend),
    startedAtMs,
    processAgeMs: Math.max(0, startedAtMs - params.session.createdAtMs),
    sessionReuse: params.sessionReuse,
    restartReason: params.restartReason,
    fingerprintChange: params.fingerprintChange,
    timings,
    rawLines: [],
    rawChars: 0,
    noOutputTimer: null,
    timeoutTimer: null,
    activeToolTimer: null,
    activeTools: new Map(),
    observedStdout: false,
    streamingParser: createCliJsonlStreamingParser({
      backend: params.context.preparedBackend.backend,
      providerId: params.context.backendResolved.id,
      onAssistantDelta: (delta) => {
        timings.timeToFirstAssistantDeltaMs ??= Math.max(0, Date.now() - startedAtMs);
        params.onAssistantDelta(delta);
      },
      onAssistantBoundary: params.onAssistantBoundary,
      onToolUseStart: params.onToolUseStart,
      onToolResult: params.onToolResult,
      onCommentaryText: params.onCommentaryText,
    }),
    execPermission: params.execPermission,
    resolve: params.resolve,
    reject: params.reject,
  };
  turn.noOutputTimer = setTimeout(() => {
    closeLiveSession(
      params.session,
      "abort",
      createTimeoutError(
        params.session,
        `CLI produced no output for ${Math.round(params.noOutputTimeoutMs / 1000)}s and was terminated.`,
        "cli_no_output_timeout",
      ),
    );
  }, params.noOutputTimeoutMs);
  turn.timeoutTimer = setTimeout(() => {
    closeLiveSession(
      params.session,
      "abort",
      createTimeoutError(
        params.session,
        `CLI exceeded timeout (${Math.round(params.context.params.timeoutMs / 1000)}s) and was terminated.`,
      ),
    );
  }, params.context.params.timeoutMs);
  return turn;
}

function closeOldestIdleSession(): boolean {
  const oldest = [...liveSessions.values()]
    .filter((session) => !session.currentTurn && !session.turnPending && !session.pinnedMain)
    .toSorted((left, right) => left.lastUsedAtMs - right.lastUsedAtMs)[0];
  if (oldest) {
    closeLiveSession(oldest, "idle");
    return true;
  }
  return false;
}

function retirePreviousPinnedMainGenerations(params: {
  key: string;
  pinnedMainOwnerKey: string;
  retireActive: boolean;
}): void {
  for (const session of liveSessions.values()) {
    if (session.key === params.key || session.pinnedMainOwnerKey !== params.pinnedMainOwnerKey) {
      continue;
    }
    if (session.currentTurn || session.turnPending) {
      if (params.retireActive) {
        session.retireAfterTurn = true;
      }
      continue;
    }
    closeLiveSession(session, "restart");
  }
  if (!params.retireActive) {
    return;
  }
  for (const [pendingKey, pending] of liveSessionCreates) {
    if (pendingKey !== params.key && pending.pinnedMainOwnerKey === params.pinnedMainOwnerKey) {
      pending.retireAfterTurn = true;
    }
  }
}

function ensureLiveSessionCapacity(key: string, context: PreparedCliRunContext): void {
  if (
    liveSessions.has(key) ||
    liveSessionCreates.has(key) ||
    liveSessions.size + liveSessionCreates.size < CLAUDE_LIVE_MAX_SESSIONS
  ) {
    return;
  }
  if (closeOldestIdleSession()) {
    return;
  }
  throw new FailoverError("Too many Claude CLI live sessions are active.", {
    reason: "rate_limit",
    provider: context.params.provider,
    model: context.modelId,
    status: resolveFailoverStatus("rate_limit"),
  });
}

function resolveClaudeLiveRestartReason(params: {
  session: ClaudeLiveSession;
  fingerprint: string;
  resumeCapable: boolean;
  useResume: boolean;
}): ClaudeLiveRestartReason | undefined {
  if (Date.now() - params.session.createdAtMs >= CLAUDE_LIVE_MAX_AGE_MS) {
    return "max_age";
  }
  if (params.resumeCapable && !params.useResume) {
    return "non_resume_turn";
  }
  if (params.session.fingerprint !== params.fingerprint) {
    return "fingerprint_changed";
  }
  return undefined;
}

/** Runs one prompt through a reusable Claude CLI live session. */
export async function runClaudeLiveSessionTurn(params: {
  context: PreparedCliRunContext;
  args: string[];
  env: Record<string, string>;
  prompt: string;
  useResume: boolean;
  noOutputTimeoutMs: number;
  getProcessSupervisor: () => ProcessSupervisor;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  onAssistantBoundary?: (boundary: CliStreamingBoundary) => void;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
  onCommentaryText?: (text: string) => void;
  onMcpCaptureReady?: (captureKey: string) => void;
  cleanup: () => Promise<void>;
}): Promise<ClaudeLiveRunResult> {
  const key = buildClaudeLiveKey(params.context);
  const pinnedMainOwnerKey = resolvePinnedMainOwnerKey(params.context);
  if (pinnedMainOwnerKey) {
    // A reset gives the same logical main session a new sessionId/key. Retire
    // idle generations before enforcing the process cap, while allowing an
    // in-flight predecessor to finish its current turn.
    retirePreviousPinnedMainGenerations({
      key,
      pinnedMainOwnerKey,
      retireActive: false,
    });
  }
  const resumeCapable = Boolean(params.context.preparedBackend.backend.resumeArgs?.length);
  const execPermission = resolveClaudeLiveExecPermission(params.context);
  const argv = [
    params.context.preparedBackend.backend.command,
    ...buildClaudeLiveArgs({
      args: params.args,
      backend: params.context.preparedBackend.backend,
      systemPrompt: params.context.systemPrompt,
      useResume: params.useResume,
      permissionMode: execPermission.permissionMode,
    }),
  ];
  const fingerprint = buildClaudeLiveFingerprint({
    context: params.context,
    argv,
    env: params.env,
  });
  let cleanupDone = false;
  const cleanup = async () => {
    if (cleanupDone) {
      return;
    }
    cleanupDone = true;
    await params.cleanup();
  };
  let restartReason: ClaudeLiveRestartReason | undefined;
  let fingerprintChange: string | undefined;
  const selectReusableSession = (candidate: ClaudeLiveSession | null): ClaudeLiveSession | null => {
    if (!candidate) {
      return null;
    }
    const reason = resolveClaudeLiveRestartReason({
      session: candidate,
      fingerprint,
      resumeCapable,
      useResume: params.useResume,
    });
    if (!reason) {
      return candidate;
    }
    // Bound launch-time state and prevent non-resume turns from inheriting a
    // reusable process. The closed code and component names are safe to emit;
    // fingerprints are not.
    restartReason ??= reason;
    if (reason === "fingerprint_changed") {
      fingerprintChange ??= summarizeClaudeLiveFingerprintChange(
        candidate.fingerprint,
        fingerprint,
      );
    }
    cliBackendLog.info(
      `claude live session restart: provider=${candidate.providerId} model=${candidate.modelId} reason=${reason}${
        fingerprintChange ? ` fingerprintChange=${fingerprintChange}` : ""
      }`,
      {
        runId: params.context.params.runId,
        restartReason: reason,
        ...(fingerprintChange ? { fingerprintChange } : {}),
        processAgeMs: Math.max(0, Date.now() - candidate.createdAtMs),
      },
    );
    closeLiveSession(candidate, "restart");
    return null;
  };
  let session = selectReusableSession(liveSessions.get(key) ?? null);
  let cleanupTurnArtifacts = Boolean(session);
  try {
    ensureLiveSessionCapacity(key, params.context);
  } catch (error) {
    await cleanup();
    throw error;
  }
  if (pinnedMainOwnerKey) {
    retirePreviousPinnedMainGenerations({
      key,
      pinnedMainOwnerKey,
      retireActive: true,
    });
  }
  if (!session) {
    const pendingCreate = liveSessionCreates.get(key);
    if (pendingCreate) {
      try {
        session = selectReusableSession(await pendingCreate.promise);
      } catch (error) {
        await cleanup();
        throw error;
      }
      if (session) {
        cleanupTurnArtifacts = true;
      }
    }
    if (!session) {
      const createEntry: ClaudeLiveSessionCreate = {
        promise: createClaudeLiveSession({
          context: params.context,
          argv,
          env: params.env,
          fingerprint,
          key,
          mcpCaptureKey: params.context.mcpDeliveryCapture ? crypto.randomUUID() : undefined,
          noOutputTimeoutMs: params.noOutputTimeoutMs,
          supervisor: params.getProcessSupervisor(),
          cleanup,
        })
          .then((createdSession) => {
            if (createEntry.retireAfterTurn) {
              createdSession.retireAfterTurn = true;
            }
            return createdSession;
          })
          .finally(() => {
            if (liveSessionCreates.get(key) === createEntry) {
              liveSessionCreates.delete(key);
            }
          }),
        pinnedMainOwnerKey,
        retireAfterTurn: false,
      };
      liveSessionCreates.set(key, createEntry);
      try {
        session = await createEntry.promise;
      } catch (error) {
        await cleanup();
        throw error;
      }
    }
  }
  if (cleanupTurnArtifacts && session) {
    await cleanup();
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    cliBackendLog.info(
      `claude live session reuse: provider=${session.providerId} model=${session.modelId}`,
    );
  }
  if (session.closing) {
    await cleanup();
    throw new Error("Claude CLI live session closed before handling the turn");
  }
  if (session.currentTurn) {
    throw new Error("Claude CLI live session is already handling a turn");
  }
  const liveSession = session;
  liveSession.lastUsedAtMs = Date.now();
  if (liveSession.mcpCaptureKey) {
    params.onMcpCaptureReady?.(liveSession.mcpCaptureKey);
  }
  liveSession.noOutputTimeoutMs = params.noOutputTimeoutMs;
  liveSession.stderr = "";
  const sessionReuse: ClaudeLiveSessionReuse = cleanupTurnArtifacts ? "warm_hit" : "cold_miss";

  const outputPromise = new Promise<CliOutput>((resolve, reject) => {
    try {
      liveSession.currentTurn = createTurn({
        context: params.context,
        noOutputTimeoutMs: params.noOutputTimeoutMs,
        sessionReuse,
        restartReason,
        fingerprintChange,
        onAssistantDelta: params.onAssistantDelta,
        onAssistantBoundary: params.onAssistantBoundary,
        onToolUseStart: params.onToolUseStart,
        onToolResult: params.onToolResult,
        onCommentaryText: params.onCommentaryText,
        session: liveSession,
        execPermission,
        resolve,
        reject,
      });
    } finally {
      liveSession.turnPending = false;
    }
  });
  // Timeout/abort can reject the turn while stdin is backpressured. Keep the
  // rejection handled until the final await below rethrows the canonical result.
  void outputPromise.catch(() => undefined);
  const abort = () => abortTurn(liveSession, createAbortError());
  let replyBackendCompleted = false;
  const replyBackendHandle: ReplyBackendHandle | undefined = params.context.params.replyOperation
    ? {
        kind: "cli",
        senderIsOwner: params.context.params.senderIsOwner === true,
        cancel: abort,
        isStreaming: () => !replyBackendCompleted,
      }
    : undefined;
  params.context.params.abortSignal?.addEventListener("abort", abort, { once: true });
  if (replyBackendHandle) {
    params.context.params.replyOperation?.attachBackend(replyBackendHandle);
  }
  try {
    if (params.context.params.abortSignal?.aborted) {
      abort();
    } else {
      try {
        await Promise.race([writeTurnInput(liveSession, params.prompt), outputPromise]);
      } catch (error) {
        closeLiveSession(liveSession, "abort", error);
      }
    }
    return { output: await outputPromise };
  } finally {
    replyBackendCompleted = true;
    params.context.params.abortSignal?.removeEventListener("abort", abort);
    if (replyBackendHandle) {
      params.context.params.replyOperation?.detachBackend(replyBackendHandle);
    }
  }
}
