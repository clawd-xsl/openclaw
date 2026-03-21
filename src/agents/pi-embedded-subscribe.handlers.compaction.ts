import fs from "node:fs";
import path from "node:path";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { emitAgentEvent } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  COMPACTION_RECOVERY_CUSTOM_TYPE,
  createCompactionRecoveryMessage,
} from "./compaction-recovery.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { makeZeroUsageSnapshot } from "./usage.js";

export function handleAutoCompactionStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.state.compactionInFlight = true;
  ctx.ensureCompactionPromise();
  ctx.log.debug(`embedded run compaction start: runId=${ctx.params.runId}`);
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: { phase: "start" },
  });
  void ctx.params.onAgentEvent?.({
    stream: "compaction",
    data: { phase: "start" },
  });

  // Run before_compaction plugin hook (fire-and-forget)
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("before_compaction")) {
    void hookRunner
      .runBeforeCompaction(
        {
          messageCount: ctx.params.session.messages?.length ?? 0,
          messages: ctx.params.session.messages,
          sessionFile: ctx.params.session.sessionFile,
        },
        {
          sessionKey: ctx.params.sessionKey,
        },
      )
      .catch((err) => {
        ctx.log.warn(`before_compaction hook failed: ${String(err)}`);
      });
  }
}

export function handleAutoCompactionEnd(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { willRetry?: unknown; result?: unknown; aborted?: unknown },
) {
  ctx.state.compactionInFlight = false;
  const willRetry = Boolean(evt.willRetry);
  // Increment counter whenever compaction actually produced a result,
  // regardless of willRetry.  Overflow-triggered compaction sets willRetry=true
  // (the framework retries the LLM request), but the compaction itself succeeded
  // and context was trimmed — the counter must reflect that.  (#38905)
  const hasResult = evt.result != null;
  const wasAborted = Boolean(evt.aborted);
  if (hasResult && !wasAborted) {
    persistCompactionRecoveryMarker(ctx, willRetry);
    ctx.incrementCompactionCount?.();
  }
  if (willRetry) {
    ctx.noteCompactionRetry();
    ctx.resetForCompactionRetry();
    ctx.log.debug(`embedded run compaction retry: runId=${ctx.params.runId}`);
  } else {
    ctx.maybeResolveCompactionWait();
    clearStaleAssistantUsageOnSessionMessages(ctx);
  }
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: { phase: "end", willRetry },
  });
  void ctx.params.onAgentEvent?.({
    stream: "compaction",
    data: { phase: "end", willRetry },
  });

  // Run after_compaction plugin hook (fire-and-forget)
  if (!willRetry) {
    const hookRunnerEnd = getGlobalHookRunner();
    if (hookRunnerEnd?.hasHooks("after_compaction")) {
      void hookRunnerEnd
        .runAfterCompaction(
          {
            messageCount: ctx.params.session.messages?.length ?? 0,
            compactedCount: ctx.getCompactionCount(),
          },
          {},
        )
        .catch((err) => {
          ctx.log.warn(`after_compaction hook failed: ${String(err)}`);
        });
    }
  }
}

function persistCompactionRecoveryMarker(
  ctx: EmbeddedPiSubscribeContext,
  willRetry: boolean,
): void {
  try {
    const recoveryPath = path.join(ctx.params.workspaceDir, "COMPACTION.md");
    const recoveryContent = fs.readFileSync(recoveryPath, "utf-8").trim();
    if (!recoveryContent) {
      return;
    }

    const recoveryMessage = createCompactionRecoveryMessage({
      sessionId: ctx.params.sessionId,
      recoveryContent,
    });
    ctx.params.sessionManager.appendMessage(recoveryMessage);

    const sessionContext = ctx.params.sessionManager.buildSessionContext();
    const updatedMessages = willRetry
      ? stripTrailingRetryErrorBeforeRecovery(sessionContext.messages)
      : sessionContext.messages;
    ctx.params.session.agent.replaceMessages(updatedMessages);
    ctx.log.debug(
      `[compaction-recovery] Persisted COMPACTION.md marker after auto-compaction: runId=${ctx.params.runId}`,
    );
  } catch (err) {
    ctx.log.debug(`[compaction-recovery] auto-compaction injection skipped: ${String(err)}`);
  }
}

function stripTrailingRetryErrorBeforeRecovery(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length < 2) {
    return messages;
  }

  const marker = messages[messages.length - 1] as {
    role?: string;
    customType?: string;
  };
  if (marker.role !== "custom" || marker.customType !== COMPACTION_RECOVERY_CUSTOM_TYPE) {
    return messages;
  }

  const candidate = messages[messages.length - 2] as {
    role?: string;
    stopReason?: string;
  };
  if (candidate.role !== "assistant" || candidate.stopReason !== "error") {
    return messages;
  }

  return [...messages.slice(0, -2), messages[messages.length - 1]];
}

function clearStaleAssistantUsageOnSessionMessages(ctx: EmbeddedPiSubscribeContext): void {
  const messages = ctx.params.session.messages;
  if (!Array.isArray(messages)) {
    return;
  }
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const candidate = message as { role?: unknown; usage?: unknown };
    if (candidate.role !== "assistant") {
      continue;
    }
    // pi-coding-agent expects assistant usage to exist when computing context usage.
    // Reset stale snapshots to zeros instead of deleting the field.
    candidate.usage = makeZeroUsageSnapshot();
  }
}
