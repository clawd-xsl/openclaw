// Memory Core plugin module runs durable session-summary generation work.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { readBoundedSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import type { SessionSummariesConfig } from "./session-summaries-config.js";
import {
  buildSessionSummaryStoreKey,
  SessionSummaryRepository,
  type SessionSummaryEnqueueInput,
  type SessionSummaryRecord,
} from "./session-summaries-store.js";
import {
  buildSessionTranscriptFingerprint,
  extractSessionSummaryMessages,
  generateSessionSummary,
  redactSessionSummarySecrets,
} from "./session-summaries-transcript.js";

type Logger = Pick<OpenClawPluginApi["logger"], "debug" | "info" | "warn">;
type CompleteLlm = OpenClawPluginApi["runtime"]["llm"]["complete"];
type ReadBoundedTranscriptEvents = typeof readBoundedSessionTranscriptEvents;

export type SessionSummaryServiceDependencies = {
  complete: CompleteLlm;
  getConfig: () => SessionSummariesConfig;
  logger: Logger;
  now?: () => number;
  readBoundedTranscriptEvents?: ReadBoundedTranscriptEvents;
  repository: SessionSummaryRepository;
  validateGenerationPolicy?: (params: { agentId: string; config: SessionSummariesConfig }) => void;
};

const MAX_PERSISTED_ERROR_CHARS = 2_000;
const SESSION_SUMMARY_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;
const SESSION_SUMMARY_TRANSCRIPT_MAX_EVENTS = 2_400;
export const SESSION_SUMMARY_CLAIM_TIMEOUT_MS = 2 * 60 * 1_000;
const SESSION_SUMMARY_STORE_RETRY_MS = 30_000;

export const SESSION_SUMMARY_POLICY_ERROR_CODE = "SESSION_SUMMARY_POLICY_DENIED" as const;

export class SessionSummaryPolicyError extends Error {
  readonly code = SESSION_SUMMARY_POLICY_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "SessionSummaryPolicyError";
  }
}

type ActiveClaim = {
  controller: AbortController;
  revision: number;
};

type RetryTimer = {
  dueAt: number;
  timer: ReturnType<typeof setTimeout>;
};

function safeErrorMessage(error: unknown): string {
  return redactSessionSummarySecrets(formatErrorMessage(error)).slice(0, MAX_PERSISTED_ERROR_CHARS);
}

function buildGenerationConfigFingerprint(config: SessionSummariesConfig): string {
  return JSON.stringify({
    maxPromptTokens: config.maxPromptTokens,
    minMessages: config.minMessages,
    model: config.model ?? null,
  });
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("session summary aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function recoverableAt(record: SessionSummaryRecord, now: number): number | undefined {
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

export class SessionSummaryService {
  readonly repository: SessionSummaryRepository;

  private readonly complete: CompleteLlm;
  private readonly getConfig: () => SessionSummariesConfig;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly readBoundedTranscriptEvents: ReadBoundedTranscriptEvents;
  private readonly validateGenerationPolicy:
    | ((params: { agentId: string; config: SessionSummariesConfig }) => void)
    | undefined;
  private readonly queuedKeys = new Set<string>();
  private readonly activeKeys = new Set<string>();
  private readonly activeClaims = new Map<string, ActiveClaim>();
  private readonly cancelledKeys = new Set<string>();
  private readonly retryTimers = new Map<string, RetryTimer>();
  private drainScheduled = false;
  private drainPromise: Promise<void> | undefined;
  private recoveryPromise: Promise<void> | undefined;
  private stopped = false;

  constructor(deps: SessionSummaryServiceDependencies) {
    this.repository = deps.repository;
    this.complete = deps.complete;
    this.getConfig = deps.getConfig;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
    this.readBoundedTranscriptEvents =
      deps.readBoundedTranscriptEvents ?? readBoundedSessionTranscriptEvents;
    this.validateGenerationPolicy = deps.validateGenerationPolicy;
  }

  async enqueue(input: SessionSummaryEnqueueInput): Promise<void> {
    const config = this.getConfig();
    if (this.stopped || !config.enabled) {
      return;
    }
    const key = buildSessionSummaryStoreKey(input.agentId, input.sessionId);
    this.cancelledKeys.delete(key);
    const result = await this.repository.enqueue({
      ...input,
      generationConfigFingerprint: buildGenerationConfigFingerprint(config),
    });
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
    const releases: Promise<void>[] = [];
    for (const [key, claim] of this.activeClaims) {
      claim.controller.abort(new Error("session summary service stopped"));
      releases.push(
        this.repository
          .releaseClaim(key, claim.revision)
          .then(() => undefined)
          .catch((error) => {
            this.logger.warn(
              `memory-core: failed to release session summary claim ${key}: ${safeErrorMessage(error)}`,
            );
          }),
      );
    }
    await Promise.all(releases);
    await this.drainPromise;
  }

  async purge(agentId: string, sessionId: string): Promise<void> {
    const key = buildSessionSummaryStoreKey(agentId, sessionId);
    this.cancelledKeys.add(key);
    this.queuedKeys.delete(key);
    this.clearRetryTimer(key);
    this.activeClaims.get(key)?.controller.abort(new Error("session was deleted"));
    await this.repository.purge(agentId, sessionId);
  }

  async recover(): Promise<void> {
    if (this.stopped) {
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
    const config = this.getConfig();
    if (!config.enabled) {
      return;
    }
    const records = await this.repository.listRecoverable(config.lookbackDays);
    await this.scheduleRecoverable(records);
  }

  private async scheduleRecoverable(
    records: Awaited<ReturnType<SessionSummaryRepository["listRecoverable"]>>,
  ): Promise<void> {
    for (const { key, record } of records) {
      if (this.stopped || this.cancelledKeys.has(key) || this.activeKeys.has(key)) {
        continue;
      }
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
        .catch((error) => {
          this.logger.warn(`memory-core: session summary drain failed: ${safeErrorMessage(error)}`);
        })
        .finally(() => {
          this.drainPromise = undefined;
          this.ensureDrain();
        });
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.queuedKeys.size > 0) {
      const key = this.queuedKeys.values().next().value as string | undefined;
      if (!key) {
        return;
      }
      this.queuedKeys.delete(key);
      if (this.cancelledKeys.has(key) || this.activeKeys.has(key)) {
        continue;
      }
      this.activeKeys.add(key);
      try {
        await this.processKey(key);
      } catch (error) {
        this.logger.warn(
          `memory-core: session summary worker failed for ${key}: ${safeErrorMessage(error)}`,
        );
        this.scheduleAt(key, this.now() + SESSION_SUMMARY_STORE_RETRY_MS);
      } finally {
        this.activeKeys.delete(key);
      }
    }
  }

  private async processKey(key: string): Promise<void> {
    if (this.stopped || this.cancelledKeys.has(key)) {
      return;
    }
    const claimed = await this.repository.claim(key);
    if (!claimed) {
      return;
    }
    const controller = new AbortController();
    const activeClaim: ActiveClaim = { controller, revision: claimed.revision };
    this.activeClaims.set(key, activeClaim);
    const timeout = setTimeout(() => {
      controller.abort(
        new Error(`session summary claim timed out after ${SESSION_SUMMARY_CLAIM_TIMEOUT_MS}ms`),
      );
    }, SESSION_SUMMARY_CLAIM_TIMEOUT_MS);
    timeout.unref?.();

    const config = this.getConfig();
    try {
      if (this.stopped || this.cancelledKeys.has(key) || !config.enabled) {
        await this.repository.releaseClaim(key, claimed.revision);
        return;
      }
      this.validateGenerationPolicy?.({ agentId: claimed.agentId, config });
      const transcript = await raceWithAbort(
        this.readBoundedTranscriptEvents({
          agentId: claimed.agentId,
          sessionId: claimed.sessionId,
          sessionKey: claimed.sessionKey,
          ...(claimed.sessionFile ? { sessionFile: claimed.sessionFile } : {}),
          maxBytes: SESSION_SUMMARY_TRANSCRIPT_MAX_BYTES,
          maxEvents: SESSION_SUMMARY_TRANSCRIPT_MAX_EVENTS,
        }),
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (!transcript.available) {
        throw new Error("session transcript is not currently available");
      }
      const messages = extractSessionSummaryMessages(transcript.events);
      const fingerprint = buildSessionTranscriptFingerprint(messages);
      if (transcript.truncated && messages.length === 0) {
        throw new Error("bounded session transcript contained no summary messages");
      }
      if (!transcript.truncated && messages.length < config.minMessages) {
        const committed = await this.repository.markComplete(key, {
          extractedMessageCount: messages.length,
          expectedRevision: claimed.revision,
          fingerprint,
          generatedAt: this.now(),
          model: null,
          skipReason: "below_min_messages",
          summary: "",
        });
        if (committed) {
          this.logger.debug?.(
            `memory-core: skipped session summary for ${claimed.agentId}/${claimed.sessionId}; ${messages.length} message(s) below minimum ${config.minMessages}`,
          );
        }
        return;
      }

      const result = await raceWithAbort(
        generateSessionSummary({
          agentId: claimed.agentId,
          complete: this.complete,
          config,
          messages,
          signal: controller.signal,
        }),
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (this.stopped || this.cancelledKeys.has(key)) {
        await this.repository.releaseClaim(key, claimed.revision);
        return;
      }
      const committed = await this.repository.markComplete(key, {
        extractedMessageCount: result.messageCount,
        expectedRevision: claimed.revision,
        fingerprint: result.fingerprint,
        generatedAt: this.now(),
        model: result.model,
        summary: result.summary,
      });
      if (committed) {
        this.logger.info(
          `memory-core: generated session summary for ${claimed.agentId}/${claimed.sessionId}`,
        );
      }
    } catch (error) {
      if (this.stopped) {
        await this.repository.releaseClaim(key, claimed.revision).catch((releaseError) => {
          this.logger.warn(
            `memory-core: failed to release stopped session summary ${claimed.agentId}/${claimed.sessionId}: ${safeErrorMessage(releaseError)}`,
          );
        });
        return;
      }
      if (this.cancelledKeys.has(key)) {
        return;
      }
      const message = safeErrorMessage(error);
      try {
        const failed = await this.repository.markFailed(
          key,
          message,
          this.now(),
          claimed.revision,
          {
            retryable: !(error instanceof SessionSummaryPolicyError),
          },
        );
        if (failed) {
          this.logger.warn(
            `memory-core: session summary generation failed for ${claimed.agentId}/${claimed.sessionId}: ${message}`,
          );
          if (failed.nextAttemptAt !== null) {
            this.scheduleAt(key, failed.nextAttemptAt);
          }
        } else {
          this.logger.warn(
            `memory-core: session summary error was fenced for ${claimed.agentId}/${claimed.sessionId}: ${message}`,
          );
        }
      } catch (markError) {
        this.logger.warn(
          `memory-core: failed to persist session summary failure for ${claimed.agentId}/${claimed.sessionId}: ${safeErrorMessage(markError)}`,
        );
        this.scheduleAt(key, claimed.leaseExpiresAt ?? this.now() + SESSION_SUMMARY_STORE_RETRY_MS);
      }
    } finally {
      clearTimeout(timeout);
      if (this.activeClaims.get(key) === activeClaim) {
        this.activeClaims.delete(key);
      }
    }
  }

  async waitForIdle(): Promise<void> {
    while (
      this.recoveryPromise ||
      this.drainPromise ||
      this.drainScheduled ||
      this.queuedKeys.size > 0
    ) {
      await (this.recoveryPromise ?? this.drainPromise ?? Promise.resolve());
      // schedule() begins the drain in a microtask; yield once when only queued work remains.
      if ((!this.drainPromise && this.drainScheduled) || this.queuedKeys.size > 0) {
        await new Promise<void>((resolve) => {
          queueMicrotask(resolve);
        });
      }
    }
  }
}
