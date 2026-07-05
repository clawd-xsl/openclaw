// Memory Core plugin module runs durable completed-session memory-flush work.
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { ensureAbsoluteDirectory } from "openclaw/plugin-sdk/security-runtime";
import { readBoundedSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { tempWorkspace, type TempWorkspace } from "openclaw/plugin-sdk/temp-path";
import type { CompletedSessionMemoryFlushConfig } from "./session-memory-flush-config.js";
import {
  projectSessionMemoryFlushCandidate,
  SessionMemoryFlushProjectionError,
  withSessionMemoryFlushProjectionLock,
} from "./session-memory-flush-projection.js";
import {
  buildSessionMemoryFlushPrompt,
  parseSessionMemoryFlushCandidate,
} from "./session-memory-flush-prompt.js";
import {
  buildSessionMemoryFlushOperationId,
  createSessionMemoryFlushCandidate,
  createSessionMemoryFlushWorkspaceTarget,
  SessionMemoryFlushRepository,
  type SessionMemoryFlushEnqueueInput,
  type SessionMemoryFlushRecord,
  type SessionMemoryFlushWorkspaceTarget,
} from "./session-memory-flush-store.js";
import {
  buildSessionTranscriptFingerprint,
  extractSessionSummaryMessages,
  redactSessionSummarySecrets,
} from "./session-summaries-transcript.js";

type Logger = Pick<OpenClawPluginApi["logger"], "debug" | "info" | "warn">;
type AgentRuntime = OpenClawPluginApi["runtime"]["agent"];
type RunEmbeddedAgent = AgentRuntime["runEmbeddedAgent"];
type ReadBoundedTranscriptEvents = typeof readBoundedSessionTranscriptEvents;
type ProjectCandidate = typeof projectSessionMemoryFlushCandidate;
type WithProjectionLock = typeof withSessionMemoryFlushProjectionLock;
type CaptureWorkspaceTarget = typeof captureSessionMemoryFlushWorkspaceTarget;
type ValidateWorkspaceTarget = typeof validateSessionMemoryFlushWorkspaceTarget;

type SessionArtifact = {
  cleanup: () => Promise<void>;
  sessionFile: string;
};

export type SessionMemoryFlushServiceDependencies = {
  getConfig: () => CompletedSessionMemoryFlushConfig;
  getRuntimeConfig: () => OpenClawConfig;
  logger: Logger;
  projectionLockDir: string;
  repository: SessionMemoryFlushRepository;
  resolveAgentDir: AgentRuntime["resolveAgentDir"];
  resolveAgentTimeoutMs: AgentRuntime["resolveAgentTimeoutMs"];
  resolveAgentWorkspaceDir: AgentRuntime["resolveAgentWorkspaceDir"];
  runEmbeddedAgent: RunEmbeddedAgent;
  createSessionArtifact?: (params: {
    runSessionId: string;
    workspaceDir: string;
  }) => Promise<SessionArtifact>;
  now?: () => number;
  projectCandidate?: ProjectCandidate;
  readBoundedTranscriptEvents?: ReadBoundedTranscriptEvents;
  captureWorkspaceTarget?: CaptureWorkspaceTarget;
  validateWorkspaceTarget?: ValidateWorkspaceTarget;
  withProjectionLock?: WithProjectionLock;
};

export type SessionMemoryFlushServiceEnqueueInput = Omit<
  SessionMemoryFlushEnqueueInput,
  "generationConfigFingerprint" | "maxPromptTokens" | "workspaceTarget"
>;

const MAX_PERSISTED_ERROR_CHARS = 2_000;
const TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;
const TRANSCRIPT_MAX_EVENTS = 2_400;
const STORE_RETRY_MS = 30_000;
export const SESSION_MEMORY_FLUSH_RUN_TIMEOUT_MS = 10 * 60 * 1_000;

type ActiveClaim = {
  controller: AbortController;
  revision: number;
  resolveSettled: () => void;
  settled: Promise<void>;
};

type RetryTimer = {
  dueAt: number;
  timer: ReturnType<typeof setTimeout>;
};

function safeErrorMessage(error: unknown): string {
  return redactSessionSummarySecrets(formatErrorMessage(error)).slice(0, MAX_PERSISTED_ERROR_CHARS);
}

function generationConfigFingerprint(config: CompletedSessionMemoryFlushConfig): string {
  return JSON.stringify({ maxPromptTokens: config.maxPromptTokens });
}

function recoverableAt(record: SessionMemoryFlushRecord, now: number): number | undefined {
  if (record.status === "pending") {
    return now;
  }
  if (record.status === "failed") {
    return record.nextAttemptAt ?? undefined;
  }
  if (record.status === "processing") {
    return record.leaseExpiresAt ?? record.processingAt ?? now;
  }
  return undefined;
}

export async function captureSessionMemoryFlushWorkspaceTarget(
  workspaceDir: string,
): Promise<SessionMemoryFlushWorkspaceTarget> {
  const configuredPath = path.resolve(workspaceDir);
  const ensured = await ensureAbsoluteDirectory(configuredPath, {
    scopeLabel: "completed-session memory-flush workspace",
  });
  if (!ensured.ok) {
    throw ensured.error;
  }
  const canonicalPath = await realpath(ensured.path);
  const identity = await stat(canonicalPath, { bigint: true });
  if (!identity.isDirectory()) {
    throw new Error("completed-session memory-flush workspace is not a directory");
  }
  return createSessionMemoryFlushWorkspaceTarget({
    configuredPath: ensured.path,
    realPath: canonicalPath,
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
  });
}

export async function validateSessionMemoryFlushWorkspaceTarget(
  target: SessionMemoryFlushWorkspaceTarget,
): Promise<string> {
  const canonicalPath = await realpath(target.configuredPath);
  const identity = await stat(canonicalPath, { bigint: true });
  if (
    !identity.isDirectory() ||
    canonicalPath !== target.realPath ||
    identity.dev.toString() !== target.device ||
    identity.ino.toString() !== target.inode
  ) {
    throw new Error("completed-session memory-flush workspace target changed after enqueue");
  }
  return target.realPath;
}

export async function createSessionMemoryFlushArtifact(params: {
  runSessionId: string;
  workspaceDir: string;
}): Promise<SessionArtifact> {
  const tempRoot = path.join(
    path.resolve(params.workspaceDir),
    ".openclaw",
    "tmp",
    "completed-session-memory-flush",
  );
  const ensured = await ensureAbsoluteDirectory(tempRoot, {
    scopeLabel: "completed-session memory-flush temp directory",
    mode: 0o700,
  });
  if (!ensured.ok) {
    throw ensured.error;
  }
  let workspace: TempWorkspace | undefined;
  try {
    workspace = await tempWorkspace({
      rootDir: ensured.path,
      prefix: "run-",
      dirMode: 0o700,
      mode: 0o600,
    });
    const sessionFile = await workspace.writeText(`${params.runSessionId}.jsonl`, "");
    return {
      sessionFile,
      cleanup: async () => {
        await workspace?.cleanup();
      },
    };
  } catch (error) {
    await workspace?.cleanup();
    throw error;
  }
}

export function assertEmbeddedRunSucceeded(result: Awaited<ReturnType<RunEmbeddedAgent>>): string {
  if (result.meta.aborted) {
    throw new Error("completed-session memory extraction was aborted");
  }
  if (result.meta.error) {
    throw new Error(`completed-session memory extraction failed: ${result.meta.error.message}`);
  }
  if (result.meta.failureSignal) {
    throw new Error(
      `completed-session memory extraction was denied: ${result.meta.failureSignal.message}`,
    );
  }
  if (result.meta.completion?.refusal) {
    throw new Error("completed-session memory extraction was refused");
  }
  if ((result.meta.pendingToolCalls?.length ?? 0) > 0) {
    throw new Error("completed-session memory extraction ended with pending tool calls");
  }
  if (
    result.didSendViaMessagingTool ||
    result.didDeliverSourceReplyViaMessageTool ||
    (result.messagingToolSentTexts?.length ?? 0) > 0 ||
    (result.messagingToolSentMediaUrls?.length ?? 0) > 0
  ) {
    throw new Error("completed-session memory extraction unexpectedly sent a message");
  }
  if (result.payloads?.some((payload) => payload.isError)) {
    throw new Error("completed-session memory extraction returned an error payload");
  }
  if (result.meta.agentHarnessResultClassification) {
    throw new Error(
      `completed-session memory extraction returned ${result.meta.agentHarnessResultClassification}`,
    );
  }
  const unexpectedTool = result.meta.toolSummary?.tools.find((tool) => tool !== "read");
  if (unexpectedTool) {
    throw new Error(
      `completed-session memory extraction violated read-only tool policy with ${unexpectedTool}`,
    );
  }
  const text = result.meta.finalAssistantRawText?.trim() ?? "";
  if (!text) {
    throw new Error("completed-session memory extraction returned no candidate");
  }
  return text;
}

export class SessionMemoryFlushService {
  readonly repository: SessionMemoryFlushRepository;

  private readonly getConfig: () => CompletedSessionMemoryFlushConfig;
  private readonly getRuntimeConfig: () => OpenClawConfig;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly readBoundedTranscriptEvents: ReadBoundedTranscriptEvents;
  private readonly runEmbeddedAgent: RunEmbeddedAgent;
  private readonly resolveAgentDir: AgentRuntime["resolveAgentDir"];
  private readonly resolveAgentTimeoutMs: AgentRuntime["resolveAgentTimeoutMs"];
  private readonly resolveAgentWorkspaceDir: AgentRuntime["resolveAgentWorkspaceDir"];
  private readonly createSessionArtifact: NonNullable<
    SessionMemoryFlushServiceDependencies["createSessionArtifact"]
  >;
  private readonly projectCandidate: ProjectCandidate;
  private readonly projectionLockDir: string;
  private readonly captureWorkspaceTarget: CaptureWorkspaceTarget;
  private readonly validateWorkspaceTarget: ValidateWorkspaceTarget;
  private readonly withProjectionLock: WithProjectionLock;
  private readonly queuedKeys = new Set<string>();
  private readonly activeClaims = new Map<string, ActiveClaim>();
  private readonly cancelledKeys = new Set<string>();
  private readonly retryTimers = new Map<string, RetryTimer>();
  private drainPromise: Promise<void> | undefined;
  private drainScheduled = false;
  private recoveryPromise: Promise<void> | undefined;
  private stopped = false;

  constructor(deps: SessionMemoryFlushServiceDependencies) {
    this.repository = deps.repository;
    this.getConfig = deps.getConfig;
    this.getRuntimeConfig = deps.getRuntimeConfig;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
    this.readBoundedTranscriptEvents =
      deps.readBoundedTranscriptEvents ?? readBoundedSessionTranscriptEvents;
    this.runEmbeddedAgent = deps.runEmbeddedAgent;
    this.resolveAgentDir = deps.resolveAgentDir;
    this.resolveAgentTimeoutMs = deps.resolveAgentTimeoutMs;
    this.resolveAgentWorkspaceDir = deps.resolveAgentWorkspaceDir;
    this.createSessionArtifact = deps.createSessionArtifact ?? createSessionMemoryFlushArtifact;
    this.projectCandidate = deps.projectCandidate ?? projectSessionMemoryFlushCandidate;
    this.projectionLockDir = deps.projectionLockDir;
    this.captureWorkspaceTarget =
      deps.captureWorkspaceTarget ?? captureSessionMemoryFlushWorkspaceTarget;
    this.validateWorkspaceTarget =
      deps.validateWorkspaceTarget ?? validateSessionMemoryFlushWorkspaceTarget;
    this.withProjectionLock = deps.withProjectionLock ?? withSessionMemoryFlushProjectionLock;
  }

  async enqueue(input: SessionMemoryFlushServiceEnqueueInput): Promise<void> {
    const config = this.getConfig();
    if (this.stopped || !config.enabled) {
      return;
    }
    const cfg = this.getRuntimeConfig();
    const workspaceTarget = await this.captureWorkspaceTarget(
      this.resolveAgentWorkspaceDir(cfg, input.agentId),
    );
    const result = await this.repository.enqueue({
      ...input,
      maxPromptTokens: config.maxPromptTokens,
      generationConfigFingerprint: generationConfigFingerprint(config),
      workspaceTarget,
    });
    this.cancelledKeys.delete(result.key);
    if (result.shouldProcess) {
      this.schedule(result.key);
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.recover();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.queuedKeys.clear();
    for (const key of this.retryTimers.keys()) {
      this.clearRetryTimer(key);
    }
    for (const claim of this.activeClaims.values()) {
      claim.controller.abort(new Error("session memory flush service stopped"));
    }
    await this.drainPromise;
  }

  async purge(agentId: string, sessionId: string): Promise<void> {
    const key = buildSessionMemoryFlushOperationId(agentId, sessionId);
    this.cancelledKeys.add(key);
    this.queuedKeys.delete(key);
    this.clearRetryTimer(key);
    const active = this.activeClaims.get(key);
    active?.controller.abort(new Error("completed session was deleted"));
    const cancelled = await this.repository.cancel(key);
    let purgeError: unknown;
    if (cancelled?.requiresProjectionLock) {
      try {
        await this.withProjectionLock(
          {
            lockDir: this.projectionLockDir,
            relativePath: cancelled.record.plan.relativePath,
            workspaceDir: cancelled.record.workspaceTarget.realPath,
            workspaceFingerprint: cancelled.record.workspaceTarget.fingerprint,
          },
          async () => {
            await this.repository.purge(agentId, sessionId);
          },
        );
      } catch (error) {
        // Keep the non-recoverable cancellation tombstone. A cross-process
        // projector may still own the target lock, so deleting without it would
        // discard the only durable fence that makes shouldProject fail closed.
        purgeError = error;
        this.logger.debug?.(
          `memory-core: session memory flush purge lock unavailable for ${key}: ${safeErrorMessage(error)}`,
        );
      }
    } else {
      await this.repository.purge(agentId, sessionId);
    }
    await active?.settled;
    if (purgeError !== undefined) {
      throw purgeError;
    }
  }

  async recover(): Promise<void> {
    if (this.stopped || !this.getConfig().enabled) {
      return;
    }
    if (this.recoveryPromise) {
      return await this.recoveryPromise;
    }
    this.recoveryPromise = this.recoverInternal().finally(() => {
      this.recoveryPromise = undefined;
    });
    return await this.recoveryPromise;
  }

  private async recoverInternal(): Promise<void> {
    for (const { record } of await this.repository.listCancelled()) {
      try {
        await this.purge(record.agentId, record.sessionId);
      } catch (error) {
        this.logger.debug?.(
          `memory-core: deferred cancelled flush purge for ${record.operationId}: ${safeErrorMessage(error)}`,
        );
      }
    }
    for (const { key, record } of await this.repository.listRecoverable()) {
      const availableAt = recoverableAt(record, this.now());
      if (availableAt === undefined) {
        continue;
      }
      if (availableAt <= this.now()) {
        this.schedule(key);
      } else {
        this.scheduleAt(key, availableAt);
      }
    }
  }

  private schedule(key: string): void {
    if (this.stopped || this.cancelledKeys.has(key)) {
      return;
    }
    this.clearRetryTimer(key);
    this.queuedKeys.add(key);
    this.ensureDrain();
  }

  private scheduleAt(key: string, dueAt: number): void {
    if (this.stopped || this.cancelledKeys.has(key)) {
      return;
    }
    if (dueAt <= this.now()) {
      this.schedule(key);
      return;
    }
    const current = this.retryTimers.get(key);
    if (current && current.dueAt <= dueAt) {
      return;
    }
    this.clearRetryTimer(key);
    const timer = setTimeout(
      () => {
        this.retryTimers.delete(key);
        this.schedule(key);
      },
      Math.max(1, dueAt - this.now()),
    );
    timer.unref?.();
    this.retryTimers.set(key, { dueAt, timer });
  }

  private clearRetryTimer(key: string): void {
    const retry = this.retryTimers.get(key);
    if (!retry) {
      return;
    }
    clearTimeout(retry.timer);
    this.retryTimers.delete(key);
  }

  private ensureDrain(): void {
    if (this.stopped || this.drainPromise || this.drainScheduled || this.queuedKeys.size === 0) {
      return;
    }
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      if (this.stopped || this.drainPromise || this.queuedKeys.size === 0) {
        return;
      }
      this.drainPromise = this.drain()
        .catch((error: unknown) => {
          this.logger.warn(
            `memory-core: session memory flush drain failed: ${safeErrorMessage(error)}`,
          );
        })
        .finally(() => {
          this.drainPromise = undefined;
          this.ensureDrain();
        });
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.queuedKeys.size > 0) {
      const key = this.queuedKeys.values().next().value;
      if (!key) {
        return;
      }
      this.queuedKeys.delete(key);
      if (this.cancelledKeys.has(key) || this.activeClaims.has(key)) {
        continue;
      }
      try {
        await this.processKey(key);
      } catch (error) {
        this.logger.warn(
          `memory-core: session memory flush worker failed for ${key}: ${safeErrorMessage(error)}`,
        );
        this.scheduleAt(key, this.now() + STORE_RETRY_MS);
      }
    }
  }

  private async processKey(key: string): Promise<void> {
    if (this.stopped || this.cancelledKeys.has(key)) {
      return;
    }
    const claimed = await this.repository.claim(key);
    if (!claimed) {
      const record = await this.repository.lookupKey(key);
      const availableAt = record ? recoverableAt(record, this.now()) : undefined;
      if (availableAt !== undefined && availableAt > this.now()) {
        this.scheduleAt(key, availableAt);
      }
      return;
    }
    const controller = new AbortController();
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    this.activeClaims.set(key, {
      controller,
      revision: claimed.revision,
      resolveSettled,
      settled,
    });
    try {
      if (this.stopped || this.cancelledKeys.has(key) || !this.getConfig().enabled) {
        await this.repository.releaseClaim(key, claimed.revision);
        return;
      }
      let candidate = claimed.candidate;
      if (!candidate) {
        const transcript = await this.readBoundedTranscriptEvents({
          agentId: claimed.agentId,
          sessionId: claimed.sessionId,
          sessionKey: claimed.sessionKey,
          ...(claimed.sessionFile ? { sessionFile: claimed.sessionFile } : {}),
          maxBytes: TRANSCRIPT_MAX_BYTES,
          maxEvents: TRANSCRIPT_MAX_EVENTS,
        });
        controller.signal.throwIfAborted();
        if (!transcript.available) {
          throw new Error("completed-session transcript is not currently available");
        }
        const messages = extractSessionSummaryMessages(transcript.events);
        const fingerprint = buildSessionTranscriptFingerprint(messages);
        if (messages.length === 0) {
          candidate = createSessionMemoryFlushCandidate({ kind: "noop" });
        } else {
          const cfg = this.getRuntimeConfig();
          const workspaceDir = await this.validateWorkspaceTarget(claimed.workspaceTarget);
          const prompt = buildSessionMemoryFlushPrompt({
            maxPromptTokens: claimed.maxPromptTokens,
            messages,
            plan: claimed.plan,
          });
          const runSessionId = randomUUID();
          const artifact = await this.createSessionArtifact({ runSessionId, workspaceDir });
          try {
            const result = await this.runEmbeddedAgent({
              sessionId: runSessionId,
              sandboxSessionKey: claimed.sessionKey,
              agentId: claimed.agentId,
              workspaceDir,
              agentDir: this.resolveAgentDir(cfg, claimed.agentId),
              config: cfg,
              prompt: prompt.prompt,
              extraSystemPrompt: prompt.systemPrompt,
              transcriptPrompt: "",
              sessionFile: artifact.sessionFile,
              timeoutMs: Math.min(
                this.resolveAgentTimeoutMs({ cfg }),
                SESSION_MEMORY_FLUSH_RUN_TIMEOUT_MS,
              ),
              runId: randomUUID(),
              abortSignal: controller.signal,
              trigger: "memory",
              memoryFlushWritePath: claimed.plan.relativePath,
              toolsAllow: ["read"],
              disableMessageTool: true,
              allowGatewaySubagentBinding: false,
              cleanupBundleMcpOnRunEnd: true,
              oneShotCliRun: true,
              suppressLiveStreamOutput: true,
              suppressToolErrorWarnings: true,
              silentExpected: true,
              ...(claimed.plan.model
                ? { model: claimed.plan.model, modelFallbacksOverride: [] }
                : {}),
            });
            candidate = createSessionMemoryFlushCandidate(
              parseSessionMemoryFlushCandidate(assertEmbeddedRunSucceeded(result)),
            );
          } finally {
            await artifact.cleanup();
          }
        }
        const persisted = await this.repository.persistCandidate(key, {
          candidate,
          expectedRevision: claimed.revision,
          extractedMessageCount: messages.length,
          transcriptFingerprint: fingerprint,
        });
        if (!persisted) {
          return;
        }
      }

      controller.signal.throwIfAborted();
      if (this.stopped || this.cancelledKeys.has(key) || !this.getConfig().enabled) {
        await this.repository.releaseClaim(key, claimed.revision);
        return;
      }
      if (candidate.kind === "append") {
        const workspaceDir = await this.validateWorkspaceTarget(claimed.workspaceTarget);
        const projection = await this.projectCandidate({
          candidate,
          lockDir: this.projectionLockDir,
          operationId: claimed.operationId,
          relativePath: claimed.plan.relativePath,
          workspaceDir,
          workspaceFingerprint: claimed.workspaceTarget.fingerprint,
          validateTarget: async () => {
            const validated = await this.validateWorkspaceTarget(claimed.workspaceTarget);
            if (validated !== workspaceDir) {
              throw new Error(
                "completed-session memory-flush workspace target changed during projection",
              );
            }
          },
          shouldProject: async () => {
            if (this.stopped || this.cancelledKeys.has(key) || !this.getConfig().enabled) {
              return false;
            }
            const current = await this.repository.lookupKey(key);
            return (
              current?.status === "processing" &&
              current.revision === claimed.revision &&
              current.candidate?.sha256 === candidate.sha256
            );
          },
        });
        if (projection === "cancelled") {
          await this.repository.releaseClaim(key, claimed.revision);
          return;
        }
        controller.signal.throwIfAborted();
      }
      const completed = await this.repository.markComplete(key, {
        expectedRevision: claimed.revision,
        ...(candidate.kind === "append" ? { projectedAt: this.now() } : {}),
      });
      if (completed) {
        this.logger.info(
          `memory-core: completed session memory flush for ${claimed.agentId}/${claimed.sessionId}`,
        );
      }
    } catch (error) {
      if (this.cancelledKeys.has(key)) {
        return;
      }
      if (this.stopped) {
        await this.repository.releaseClaim(key, claimed.revision).catch(() => undefined);
        return;
      }
      const terminalCode =
        error instanceof SessionMemoryFlushProjectionError ? error.code : undefined;
      const failed = await this.repository.markFailed(key, {
        error: safeErrorMessage(error),
        expectedRevision: claimed.revision,
        ...(terminalCode ? { terminalCode } : {}),
      });
      if (failed?.nextAttemptAt !== null && failed?.nextAttemptAt !== undefined) {
        this.scheduleAt(key, failed.nextAttemptAt);
      }
      this.logger.warn(
        `memory-core: session memory flush failed for ${claimed.agentId}/${claimed.sessionId}: ${safeErrorMessage(error)}`,
      );
    } finally {
      this.activeClaims.get(key)?.resolveSettled();
      this.activeClaims.delete(key);
    }
  }
}
