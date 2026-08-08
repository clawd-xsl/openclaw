/**
 * sessions_send built-in tool.
 *
 * Sends messages to visible sessions, starts embedded runs, and optionally announces replies.
 */
import crypto from "node:crypto";
import { isRequesterParentOfBackgroundAcpSession } from "@openclaw/acp-core/session-interaction-mode";
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import { parseSessionThreadInfoFast } from "../../config/sessions/thread-info.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  requestSystemEventTurn,
  runSystemEventTurn,
  SystemEventTurnAttemptError,
  type SystemEventTurnResult,
} from "../../infra/system-event-turn.js";
import { enqueueSystemEventEntryWithStatus } from "../../infra/system-events.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import {
  isCronRunSessionKey,
  isHookSessionKey,
  parseAgentSessionKey,
} from "../../sessions/session-key-utils.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import { stripFormattedReasoningMessage } from "../../shared/text/formatted-reasoning-message.js";
import {
  type GatewayMessageChannel,
  INTERNAL_MESSAGE_CHANNEL,
} from "../../utils/message-channel.js";
import { listAgentIds, resolveDefaultAgentId } from "../agent-scope.js";
import {
  type EmbeddedAgentQueueMessageOptions,
  type EmbeddedAgentQueueMessageOutcome,
  formatEmbeddedAgentQueueFailureSummary,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunSessionId,
} from "../embedded-agent-runner/runs.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import { type AgentWaitResult, waitForAgentRunReply } from "../run-wait.js";
import { loadSessionEntryByKey } from "../subagent-announce-delivery.js";
import {
  describeSessionsSendTool,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNonNegativeIntegerParam, readStringParam } from "./common.js";
import {
  createSessionVisibilityGuard,
  createAgentToAgentPolicy,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";
import {
  buildAgentToAgentMessageContext,
  resolvePingPongTurns,
  resolveSessionsSendReplyText,
} from "./sessions-send-helpers.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

const SessionsSendToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  message: Type.String(),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
});

type GatewayCaller = typeof callGateway;
const SESSIONS_SEND_MESSAGE_ALIASES = ["SendMessage", "content", "text"] as const;

function normalizeSessionsSendArguments(args: unknown): Record<string, unknown> {
  const params =
    args && typeof args === "object" && !Array.isArray(args)
      ? { ...(args as Record<string, unknown>) }
      : {};

  if (typeof params.message !== "string" || !params.message.trim()) {
    for (const alias of SESSIONS_SEND_MESSAGE_ALIASES) {
      const value = readStringParam(params, alias);
      if (value) {
        params.message = stripFormattedReasoningMessage(value);
        break;
      }
    }
  }

  for (const alias of SESSIONS_SEND_MESSAGE_ALIASES) {
    delete params[alias];
  }
  return params;
}

function resolveConfiguredAgentMainSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  mainKey: string;
}): string | undefined {
  const agentId = normalizeAgentId(params.agentId);
  if (!listAgentIds(params.cfg).includes(agentId)) {
    return undefined;
  }
  return toAgentStoreSessionKey({
    agentId,
    requestKey: "main",
    mainKey: params.mainKey,
  });
}

function isConfiguredAgentMainSessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  mainKey: string;
}): boolean {
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  return (
    params.sessionKey ===
    resolveConfiguredAgentMainSessionKey({
      cfg: params.cfg,
      agentId,
      mainKey: params.mainKey,
    })
  );
}

async function ensureConfiguredAgentMainSession(params: {
  cfg: OpenClawConfig;
  callGateway: GatewayCaller;
  sessionKey: string;
  mainKey: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (
    !isConfiguredAgentMainSessionKey({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      mainKey: params.mainKey,
    })
  ) {
    return { ok: true };
  }

  try {
    await params.callGateway({
      method: "sessions.resolve",
      params: { key: params.sessionKey },
      timeoutMs: 10_000,
    });
    return { ok: true };
  } catch {
    try {
      await params.callGateway({
        method: "sessions.create",
        params: {
          key: params.sessionKey,
          agentId: resolveAgentIdFromSessionKey(params.sessionKey),
        },
        timeoutMs: 10_000,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatErrorMessage(err) };
    }
  }
}

type SessionsSendRouteEntry = Pick<SessionEntry, "acp" | "parentSessionKey" | "spawnedBy">;

function isRequesterParentOfNativeSubagentSession(params: {
  entry: SessionsSendRouteEntry | null | undefined;
  acpMeta?: unknown;
  requesterSessionKey: string | null | undefined;
  targetSessionKey: string;
}): boolean {
  if (
    !params.entry ||
    params.acpMeta ||
    params.entry.acp ||
    !isSubagentSessionKey(params.targetSessionKey)
  ) {
    return false;
  }
  const requester = normalizeOptionalString(params.requesterSessionKey);
  if (!requester) {
    return false;
  }
  const spawnedBy = normalizeOptionalString(params.entry.spawnedBy);
  const parentSessionKey = normalizeOptionalString(params.entry.parentSessionKey);
  return requester === spawnedBy || requester === parentSessionKey;
}

function isTerminalAgentWaitTimeout(result: AgentWaitResult): boolean {
  return result.endedAt !== undefined || Boolean(result.stopReason || result.livenessState);
}

function isPendingErrorAgentWaitTimeout(result: AgentWaitResult): boolean {
  return (
    result.pendingError === true && typeof result.error === "string" && result.error.trim() !== ""
  );
}

type SystemEventFailedCounts = NonNullable<
  Extract<SystemEventTurnResult, { status: "ran" }>["failedCounts"]
>;

function resolveSystemEventDeliveryFailure(
  result: SystemEventTurnResult,
): SystemEventFailedCounts | undefined {
  if (result.status !== "ran" || !result.failedCounts) {
    return undefined;
  }
  return Object.values(result.failedCounts).some((count) => (count ?? 0) > 0)
    ? result.failedCounts
    : undefined;
}

function isRunScopedAgentSessionKey(sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(normalizeOptionalString(sessionKey));
  return Boolean(parsed && /(?:^|:)run:[^:]+(?::|$)/.test(parsed.rest));
}

function resolveCronRunScopedFallbackSessionKey(sessionKey: string): string | undefined {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey || !isCronRunSessionKey(normalizedSessionKey)) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(normalizedSessionKey);
  if (!parsed) {
    return undefined;
  }
  const runMarker = ":run:";
  const runMarkerIndex = parsed.rest.lastIndexOf(runMarker);
  if (runMarkerIndex <= 0) {
    return undefined;
  }
  const runId = parsed.rest.slice(runMarkerIndex + runMarker.length);
  if (!runId || runId.includes(":")) {
    return undefined;
  }
  const fallbackRest = parsed.rest.slice(0, runMarkerIndex);
  if (!fallbackRest) {
    return undefined;
  }
  return `agent:${parsed.agentId}:${fallbackRest}`;
}

function shouldFallbackCronRunScopedActiveDelivery(
  outcome: EmbeddedAgentQueueMessageOutcome,
): boolean {
  return (
    !outcome.queued &&
    (outcome.reason === "not_streaming" ||
      outcome.reason === "no_active_run" ||
      outcome.reason === "sender_owner_mismatch")
  );
}

async function startAgentRun(params: {
  callGateway: GatewayCaller;
  runId: string;
  sendParams: Record<string, unknown>;
  sessionKey: string;
  senderIsOwner?: boolean;
  deliveryTimeoutMs?: number;
  allowActiveRunQueueDelivery?: boolean;
}): Promise<
  | {
      ok: true;
      runId: string;
      activeRunQueue?: boolean;
      a2aSessionKey?: string;
      a2aDisplayKey?: string;
    }
  | { ok: false; result: ReturnType<typeof jsonResult> }
> {
  try {
    const activeRunSessionId =
      params.allowActiveRunQueueDelivery && isRunScopedAgentSessionKey(params.sessionKey)
        ? resolveActiveEmbeddedRunSessionId(params.sessionKey)
        : undefined;
    const messageText =
      typeof params.sendParams.message === "string" ? params.sendParams.message : undefined;
    if (activeRunSessionId && messageText) {
      const sourceReplyDeliveryMode =
        params.sendParams.sourceReplyDeliveryMode === "automatic" ||
        params.sendParams.sourceReplyDeliveryMode === "message_tool_only"
          ? params.sendParams.sourceReplyDeliveryMode
          : undefined;
      const queueOptions: EmbeddedAgentQueueMessageOptions = {
        steeringMode: "all",
        debounceMs: 0,
        deliveryTimeoutMs: params.deliveryTimeoutMs,
        waitForTranscriptCommit: true,
        ...(sourceReplyDeliveryMode ? { sourceReplyDeliveryMode } : {}),
      };
      const authorization = {
        kind: "sender" as const,
        senderIsOwner: params.senderIsOwner === true,
      };
      let queueOutcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
        activeRunSessionId,
        messageText,
        queueOptions,
        authorization,
      );
      if (!queueOutcome.queued && queueOutcome.reason === "transcript_commit_wait_unsupported") {
        const bestEffortQueueOptions = { ...queueOptions };
        delete bestEffortQueueOptions.waitForTranscriptCommit;
        queueOutcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
          activeRunSessionId,
          messageText,
          bestEffortQueueOptions,
          authorization,
        );
      }
      if (queueOutcome.queued) {
        return { ok: true, runId: params.runId, activeRunQueue: true };
      }
      const fallbackSessionKey = resolveCronRunScopedFallbackSessionKey(params.sessionKey);
      if (fallbackSessionKey && shouldFallbackCronRunScopedActiveDelivery(queueOutcome)) {
        const response = await params.callGateway<{ runId: string }>({
          method: "agent",
          params: {
            ...params.sendParams,
            sessionKey: fallbackSessionKey,
            idempotencyKey: crypto.randomUUID(),
          },
          ...(params.senderIsOwner === true
            ? {
                scopes: ["operator.admin" as const],
                requireLocalBackendOperatorAuth: true,
              }
            : {}),
          timeoutMs: 10_000,
        });
        return {
          ok: true,
          runId:
            typeof response?.runId === "string" && response.runId ? response.runId : params.runId,
          a2aSessionKey: fallbackSessionKey,
          a2aDisplayKey: fallbackSessionKey,
        };
      }
      if (queueOutcome.reason !== "sender_owner_mismatch") {
        const queueSummary =
          formatEmbeddedAgentQueueFailureSummary(queueOutcome) ?? "active run queue rejected";
        throw new Error(queueSummary);
      }
      // A non-cron ownership mismatch cannot reuse the target run's tool
      // authority. Continue below with a separately authenticated turn.
    }
    const response = await params.callGateway<{ runId: string }>({
      method: "agent",
      params: params.sendParams,
      // A separate gateway turn must preserve host-admitted owner identity;
      // otherwise the device-less loopback connection loses owner-only tools.
      ...(params.senderIsOwner === true
        ? {
            scopes: ["operator.admin" as const],
            requireLocalBackendOperatorAuth: true,
          }
        : {}),
      timeoutMs: 10_000,
    });
    return {
      ok: true,
      runId: typeof response?.runId === "string" && response.runId ? response.runId : params.runId,
    };
  } catch (err) {
    const messageText =
      err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return {
      ok: false,
      result: jsonResult({
        runId: params.runId,
        status: "error",
        error: messageText,
        sessionKey: params.sessionKey,
      }),
    };
  }
}

export function createSessionsSendTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  /** Trusted sender identity admitted by the host for this run. */
  senderIsOwner?: boolean;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Session Send",
    name: "sessions_send",
    displaySummary: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSendTool(),
    parameters: SessionsSendToolSchema,
    prepareArguments: normalizeSessionsSendArguments,
    execute: async (_toolCallId, args) => {
      const params = normalizeSessionsSendArguments(args);
      const gatewayCall = opts?.callGateway ?? callGateway;
      const message = readStringParam(params, "message", { required: true });
      const timeoutSeconds = readNonNegativeIntegerParam(params, "timeoutSeconds") ?? 30;
      const { cfg, mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSessionToolContext(opts);

      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const sessionVisibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });

      const sessionKeyParam = readStringParam(params, "sessionKey");
      const labelParam = normalizeOptionalString(readStringParam(params, "label"));
      const labelAgentIdParam = normalizeOptionalString(readStringParam(params, "agentId"));

      let sessionKey = sessionKeyParam;
      if (!sessionKey && !labelParam && labelAgentIdParam) {
        const agentMainKey = resolveConfiguredAgentMainSessionKey({
          cfg,
          agentId: labelAgentIdParam,
          mainKey,
        });
        if (!agentMainKey) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: `agent not found: ${labelAgentIdParam}`,
          });
        }
        sessionKey = agentMainKey;
      }
      if (!sessionKey && labelParam) {
        const requesterAgentId = resolveAgentIdFromSessionKey(effectiveRequesterKey);
        const requestedAgentId = labelAgentIdParam
          ? normalizeAgentId(labelAgentIdParam)
          : undefined;

        if (restrictToSpawned && requestedAgentId && requestedAgentId !== requesterAgentId) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error: "Sandboxed sessions_send label lookup is limited to this agent",
          });
        }

        if (requesterAgentId && requestedAgentId && requestedAgentId !== requesterAgentId) {
          if (!a2aPolicy.enabled) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error:
                "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
            });
          }
          if (!a2aPolicy.isAllowed(requesterAgentId, requestedAgentId)) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
            });
          }
        }

        const resolveParams: Record<string, unknown> = {
          label: labelParam,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
          ...(restrictToSpawned ? { spawnedBy: effectiveRequesterKey } : {}),
        };
        let resolvedKey;
        try {
          const resolved = await gatewayCall<{ key: string }>({
            method: "sessions.resolve",
            params: resolveParams,
            timeoutMs: 10_000,
          });
          resolvedKey = normalizeOptionalString(resolved?.key) ?? "";
        } catch (err) {
          const msg = formatErrorMessage(err);
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: msg || `No session found with label: ${labelParam}`,
          });
        }

        if (!resolvedKey) {
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: `No session found with label: ${labelParam}`,
          });
        }
        sessionKey = resolvedKey;
      }

      if (!sessionKey) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Either sessionKey or label is required",
        });
      }
      const resolvedSession = await resolveSessionReference({
        sessionKey,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: resolvedSession.status,
          error: resolvedSession.error,
        });
      }
      const visibleSession = await resolveVisibleSessionReference({
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        restrictToSpawned,
        visibilitySessionKey: sessionKey,
      });
      const unresolvedDisplayKey = sessionKey;
      if (!visibleSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: visibleSession.status,
          error: visibleSession.error,
          sessionKey: unresolvedDisplayKey,
        });
      }
      // Normalize sessionKey/sessionId input into a canonical session key.
      const resolvedKey = visibleSession.key;
      const displayKey = visibleSession.displayKey;
      const timeoutMs =
        finiteSecondsToTimerSafeMilliseconds(timeoutSeconds, {
          floorSeconds: true,
        }) ?? 0;
      const announceTimeoutMs = timeoutSeconds === 0 ? 30_000 : timeoutMs;
      const idempotencyKey = crypto.randomUUID();
      let runId: string = idempotencyKey;
      if (parseSessionThreadInfoFast(resolvedKey).threadId) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error:
            "sessions_send cannot target a thread session for inter-agent coordination. Use the parent channel session key instead.",
          sessionKey: unresolvedDisplayKey,
        });
      }
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "send",
        requesterSessionKey: effectiveRequesterKey,
        visibility: sessionVisibility,
        a2aPolicy,
      });
      const access = visibilityGuard.check(resolvedKey);
      if (!access.allowed) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: access.status,
          error: access.error,
          sessionKey: unresolvedDisplayKey,
        });
      }

      const ensuredSession = await ensureConfiguredAgentMainSession({
        cfg,
        callGateway: gatewayCall,
        sessionKey: resolvedKey,
        mainKey,
      });
      if (!ensuredSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: ensuredSession.error,
          sessionKey: displayKey,
        });
      }

      const requesterSessionKey = opts?.agentSessionKey;
      const requesterChannel = opts?.agentChannel;
      const isIsolatedCronRequester = isCronRunSessionKey(requesterSessionKey);
      const isHookRequester = isHookSessionKey(requesterSessionKey);
      const requesterAgentId = isHookRequester
        ? (parseAgentSessionKey(requesterSessionKey)?.agentId ?? resolveDefaultAgentId(cfg))
        : undefined;
      const isRequesterMainSession =
        (alias === "global" && resolvedKey === alias) ||
        (isConfiguredAgentMainSessionKey({ cfg, sessionKey: resolvedKey, mainKey }) &&
          requesterAgentId === resolveAgentIdFromSessionKey(resolvedKey));

      if (isHookRequester && opts?.senderIsOwner === true && isRequesterMainSession) {
        const inputProvenance = {
          kind: "inter_session" as const,
          sourceSessionKey: requesterSessionKey,
          sourceChannel: requesterChannel,
          sourceTool: "sessions_send",
        };
        // Hook workers hand off once into the target's normal inbound dispatcher.
        // Starting a nested A2A run here bypasses its stable channel prompt and replays replies.
        const enqueueResult = enqueueSystemEventEntryWithStatus(message, {
          sessionKey: resolvedKey,
          consumer: "system-event-turn",
          inputProvenance,
          // This branch is reachable only from a host-admitted owner run.
          // Carry that fact explicitly; the target delivery route is not an auth principal.
          sourceAuthority: { kind: "owner" },
        });
        if (enqueueResult.status === "skipped" && enqueueResult.reason === "full") {
          return jsonResult({
            runId: idempotencyKey,
            status: "error",
            error: "The target session's system-event queue is full; retry this handoff.",
            sessionKey: displayKey,
          });
        }
        const queuedEvent = enqueueResult.status === "enqueued" ? enqueueResult.event : null;
        const reason = "sessions_send:hook";
        if (timeoutSeconds === 0) {
          requestSystemEventTurn({ sessionKey: resolvedKey, reason });
          return jsonResult({
            handoffId: idempotencyKey,
            status: "accepted",
            sessionKey: displayKey,
            delivery: {
              status: queuedEvent ? "pending" : "coalesced",
              mode: "system-event",
            },
          });
        }
        if (!queuedEvent) {
          requestSystemEventTurn({ sessionKey: resolvedKey, reason });
          return jsonResult({
            handoffId: idempotencyKey,
            status: "accepted",
            sessionKey: displayKey,
            delivery: { status: "coalesced", mode: "system-event" },
          });
        }
        let waitTimer: NodeJS.Timeout | undefined;
        const timedOut = Symbol("hook-handoff-wait-timeout");
        const deliveryPromise = runSystemEventTurn({
          sessionKey: resolvedKey,
          reason,
          requestedEvents: [queuedEvent],
        }).then(
          (delivery) => ({ kind: "delivered" as const, delivery }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        );
        const waitTimeout = new Promise<typeof timedOut>((resolve) => {
          waitTimer = setTimeout(() => resolve(timedOut), timeoutMs);
          waitTimer.unref?.();
        });
        const outcome = await Promise.race([deliveryPromise, waitTimeout]);
        if (waitTimer) {
          clearTimeout(waitTimer);
        }

        if (outcome === timedOut) {
          // The caller timeout bounds only its wait. The turn already owns the claimed event;
          // retry only if that turn later fails and restores the event to the queue.
          void deliveryPromise.then((lateOutcome) => {
            if (
              lateOutcome.kind === "failed" &&
              lateOutcome.error instanceof SystemEventTurnAttemptError &&
              lateOutcome.error.disposition === "restored"
            ) {
              requestSystemEventTurn({ sessionKey: resolvedKey, reason });
            }
          });
          return jsonResult({
            handoffId: idempotencyKey,
            status: "accepted",
            sessionKey: displayKey,
            delivery: { status: "pending", mode: "system-event" },
          });
        }
        if (outcome.kind === "delivered") {
          const failedCounts = resolveSystemEventDeliveryFailure(outcome.delivery);
          if (failedCounts) {
            return jsonResult({
              handoffId: idempotencyKey,
              status: "error",
              error: "The target session completed, but one or more channel replies failed.",
              sessionKey: displayKey,
              delivery: {
                status: "failed",
                mode: "system-event",
                failedCounts,
              },
            });
          }
          return jsonResult({
            handoffId: idempotencyKey,
            status: "ok",
            sessionKey: displayKey,
            delivery: { status: outcome.delivery.status, mode: "system-event" },
          });
        }
        if (
          outcome.error instanceof SystemEventTurnAttemptError &&
          outcome.error.disposition === "restored"
        ) {
          requestSystemEventTurn({ sessionKey: resolvedKey, reason });
          return jsonResult({
            handoffId: idempotencyKey,
            status: "accepted",
            sessionKey: displayKey,
            delivery: { status: "pending", mode: "system-event" },
            warning: formatErrorMessage(outcome.error),
          });
        }
        return jsonResult({
          handoffId: idempotencyKey,
          status: "error",
          error: formatErrorMessage(outcome.error),
          sessionKey: displayKey,
          delivery: { status: "failed", mode: "system-event" },
        });
      }

      const agentMessageContext = buildAgentToAgentMessageContext({
        requesterSessionKey: opts?.agentSessionKey,
        requesterChannel: opts?.agentChannel,
        targetSessionKey: displayKey,
      });
      const inputProvenance = {
        kind: "inter_session" as const,
        sourceSessionKey: opts?.agentSessionKey,
        sourceChannel: opts?.agentChannel,
        sourceTool: "sessions_send",
      };
      const sendParams = {
        message: annotateInterSessionPromptText(message, inputProvenance),
        sessionKey: resolvedKey,
        idempotencyKey,
        deliver: false,
        sourceReplyDeliveryMode: "message_tool_only" as const,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: resolveNestedAgentLaneForSession(resolvedKey),
        extraSystemPrompt: agentMessageContext,
        inputProvenance,
      };
      const maxPingPongTurns = resolvePingPongTurns(cfg);

      // Skip the A2A ping-pong + announce flow when the current caller is the
      // parent of a parent-owned child session it spawned itself and another
      // parent-visible result path already exists.
      //
      // ACP background sessions report through the internal task completion
      // path. Waited native subagent sends return the child reply inline. In
      // both cases treating the child as a peer agent wakes the parent with
      // the child's reply, can generate another user-facing response, and can
      // forward that response back to the child as a new message — producing a
      // ping-pong loop (bounded by maxPingPongTurns, but visible as duplicate
      // conversation output).
      //
      // The skip is gated on requester ownership, not just target type: an
      // unrelated sender that can see the same target (e.g. under
      // `tools.sessions.visibility=all`) must still go through the normal A2A
      // path so it actually receives a follow-up delivery.
      const targetSessionEntry = loadSessionEntryByKey(resolvedKey);
      const targetAcpMeta = readAcpSessionMeta({ sessionKey: resolvedKey });
      const targetSessionEntryWithAcp =
        targetAcpMeta && targetSessionEntry
          ? { ...targetSessionEntry, acp: targetAcpMeta }
          : targetSessionEntry;
      const skipAcpA2AFlow = isRequesterParentOfBackgroundAcpSession(
        targetSessionEntryWithAcp,
        effectiveRequesterKey,
      );
      const skipNativeParentA2AFlow =
        timeoutSeconds !== 0 &&
        isRequesterParentOfNativeSubagentSession({
          entry: targetSessionEntry,
          acpMeta: targetAcpMeta,
          requesterSessionKey: effectiveRequesterKey,
          targetSessionKey: resolvedKey,
        });
      const skipA2AFlow = skipAcpA2AFlow || skipNativeParentA2AFlow;
      // When the A2A flow is skipped, no follow-up announcement will fire and
      // the reply (when present) is returned inline via the `reply` field.
      // Reflect that in the metadata so the parent LLM does not wait for a
      // second result that will never arrive.
      const delivery = skipA2AFlow
        ? ({ status: "skipped", mode: "announce" } as const)
        : ({ status: "pending", mode: "announce" } as const);

      const startA2AFlow = (
        roundOneReply?: string,
        waitRunId?: string,
        flowTargetSessionKey = resolvedKey,
        flowDisplayKey = displayKey,
      ) => {
        if (skipA2AFlow) {
          return;
        }
        void runSessionsSendA2AFlow({
          targetSessionKey: flowTargetSessionKey,
          displayKey: flowDisplayKey,
          message,
          announceTimeoutMs,
          // Cron runs are isolated jobs; target replies must not become new
          // requester turns, but the target-side announce still runs.
          maxPingPongTurns: isIsolatedCronRequester ? 0 : maxPingPongTurns,
          requesterSessionKey,
          requesterChannel,
          roundOneReply,
          waitRunId,
        });
      };

      if (timeoutSeconds === 0) {
        const start = await startAgentRun({
          callGateway: gatewayCall,
          runId,
          sendParams,
          sessionKey: displayKey,
          senderIsOwner: opts?.senderIsOwner,
          deliveryTimeoutMs: announceTimeoutMs,
          allowActiveRunQueueDelivery: true,
        });
        if (!start.ok) {
          return start.result;
        }
        runId = start.runId;
        if (!start.activeRunQueue) {
          startA2AFlow(undefined, runId, start.a2aSessionKey, start.a2aDisplayKey);
        }
        return jsonResult({
          runId,
          status: "accepted",
          sessionKey: displayKey,
          delivery,
        });
      }

      const start = await startAgentRun({
        callGateway: gatewayCall,
        runId,
        sendParams,
        sessionKey: displayKey,
        senderIsOwner: opts?.senderIsOwner,
        deliveryTimeoutMs: announceTimeoutMs,
      });
      if (!start.ok) {
        return start.result;
      }
      runId = start.runId;
      const result = await waitForAgentRunReply({
        runId,
        timeoutMs,
        callGateway: gatewayCall,
      });

      if (result.status === "timeout") {
        if (isPendingErrorAgentWaitTimeout(result)) {
          startA2AFlow(undefined, runId);
          return jsonResult({
            runId,
            status: "timeout",
            error: result.error,
            sentBeforeError: true,
            sessionKey: displayKey,
            delivery,
          });
        }
        if (!isTerminalAgentWaitTimeout(result)) {
          startA2AFlow(undefined, runId);
          return jsonResult({
            runId,
            status: "accepted",
            sessionKey: displayKey,
            delivery,
          });
        }
        return jsonResult({
          runId,
          status: "timeout",
          error: result.error,
          sentBeforeError: true,
          sessionKey: displayKey,
        });
      }
      if (result.status === "error") {
        return jsonResult({
          runId,
          status: "error",
          error: result.error ?? "agent error",
          sentBeforeError: true,
          sessionKey: displayKey,
        });
      }
      const reply = resolveSessionsSendReplyText(result);
      startA2AFlow(reply ?? undefined);

      return jsonResult({
        runId,
        status: "ok",
        reply,
        sessionKey: displayKey,
        delivery,
      });
    },
  };
}
