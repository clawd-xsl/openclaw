import { randomUUID } from "node:crypto";
import { sanitizeInboundSystemTags } from "../../auto-reply/reply/inbound-text.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { CliDeps } from "../../cli/deps.types.js";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { extractDeliveryInfo } from "../../config/sessions/delivery-info.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import { assertSafeCronSessionTargetId } from "../../cron/session-target.js";
import type { CronJob } from "../../cron/types.js";
import { requestHookAgentTurn } from "../../infra/hook-agent-turn.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { type HookAgentDispatchPayload, type HooksConfigResolved } from "../hooks.js";
import { createHooksRequestHandler, type HookClientIpConfig } from "../server-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

function previewHookTraceText(value: string | undefined, maxChars = 160): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const singleLine = trimmed.replace(/\s+/g, " ").trim();
  return singleLine.length > maxChars ? `${singleLine.slice(0, maxChars - 1)}…` : singleLine;
}

export function resolveHookClientIpConfig(cfg: OpenClawConfig): HookClientIpConfig {
  return {
    trustedProxies: cfg.gateway?.trustedProxies,
    allowRealIpFallback: cfg.gateway?.allowRealIpFallback === true,
  };
}

export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  getClientIpConfig: () => HookClientIpConfig;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { deps, getHooksConfig, getClientIpConfig, bindHost, port, logHooks } = params;

  const dispatchWakeHook = (value: { text: string; mode: "now" | "next-heartbeat" }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    const deliveryContext = extractDeliveryInfo(sessionKey).deliveryContext;
    const enqueued = enqueueSystemEvent(value.text, {
      sessionKey,
      trusted: false,
      deliveryContext,
    });
    logHooks.info("hook trace: wake event queued", {
      sessionKey,
      wakeMode: value.mode,
      enqueued,
      textPreview: previewHookTraceText(value.text),
    });
    if (value.mode === "now") {
      logHooks.info("hook trace: wake requested for direct wake hook", {
        sessionKey,
      });
      requestHookAgentTurn({ reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: HookAgentDispatchPayload) => {
    const sessionKey = value.sessionKey;
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const mainDeliveryContext = extractDeliveryInfo(mainSessionKey).deliveryContext;
    const safeName = sanitizeInboundSystemTags(value.name);
    const jobId = randomUUID();
    const now = Date.now();
    const persistentSessionTarget =
      value.deleteAfterRun === false
        ? (`session:${assertSafeCronSessionTargetId(sessionKey)}` as const)
        : "isolated";
    const delivery = value.deliver
      ? {
          mode: "announce" as const,
          channel: value.channel,
          to: value.to,
        }
      : { mode: "none" as const };
    const job: CronJob = {
      id: jobId,
      agentId: value.agentId,
      name: safeName,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", at: new Date(now).toISOString() },
      deleteAfterRun: value.deleteAfterRun ?? true,
      sessionTarget: persistentSessionTarget,
      wakeMode: value.wakeMode,
      payload: {
        kind: "agentTurn",
        message: value.message,
        model: value.model,
        thinking: value.thinking,
        timeoutSeconds: value.timeoutSeconds,
        allowUnsafeExternalContent: value.allowUnsafeExternalContent,
        externalContentSource: value.externalContentSource,
      },
      delivery,
      state: { nextRunAtMs: now },
    };

    const runId = randomUUID();
    void (async () => {
      logHooks.info("hook trace: agent dispatch start", {
        jobId,
        runId,
        hookName: safeName,
        hookSessionKey: sessionKey,
        mainSessionKey,
        wakeMode: value.wakeMode,
        deliver: value.deliver,
        deleteAfterRun: value.deleteAfterRun ?? true,
        deliveryMode: delivery.mode,
        deliveryChannel: value.channel,
        deliveryTo: value.to,
        messagePreview: previewHookTraceText(value.message),
      });
      try {
        const cfg = loadConfig();
        const result = await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job,
          message: value.message,
          sessionKey,
          lane: "cron",
          deliveryContract: "shared",
        });
        const summary =
          normalizeOptionalString(result.summary) ||
          normalizeOptionalString(result.error) ||
          result.status;
        const prefix =
          result.status === "ok" ? `Hook ${safeName}` : `Hook ${safeName} (${result.status})`;
        logHooks.info("hook trace: isolated run finished", {
          jobId,
          runId,
          hookName: safeName,
          status: result.status,
          delivered: result.delivered ?? false,
          deliveryAttempted: result.deliveryAttempted ?? false,
          isolatedSessionId: result.sessionId,
          isolatedSessionKey: result.sessionKey,
          summaryPreview: previewHookTraceText(summary),
          errorPreview: previewHookTraceText(result.error),
        });
        if (!result.delivered) {
          if (result.status === "ok" && isSilentReplyText(summary, SILENT_REPLY_TOKEN)) {
            logHooks.info("hook trace: silent fallback suppressed", {
              jobId,
              runId,
              hookName: safeName,
              mainSessionKey,
              wakeMode: value.wakeMode,
              summaryPreview: previewHookTraceText(summary),
            });
            return;
          }
          const fallbackText = `${prefix}: ${summary}`.trim();
          const enqueued = enqueueSystemEvent(fallbackText, {
            sessionKey: mainSessionKey,
            trusted: false,
            deliveryContext: mainDeliveryContext,
          });
          logHooks.info("hook trace: fallback system event queued", {
            jobId,
            runId,
            hookName: safeName,
            mainSessionKey,
            enqueued,
            wakeMode: value.wakeMode,
            eventPreview: previewHookTraceText(fallbackText),
          });
          if (value.wakeMode === "now") {
            logHooks.info("hook trace: wake requested for fallback system event", {
              jobId,
              runId,
              hookName: safeName,
              mainSessionKey,
            });
            requestHookAgentTurn({ reason: `hook:${jobId}` });
          }
        } else {
          logHooks.info("hook trace: isolated run handled delivery directly", {
            jobId,
            runId,
            hookName: safeName,
          });
        }
      } catch (err) {
        const errorText = String(err);
        logHooks.warn(`hook agent failed: ${errorText}`);
        const fallbackText = `Hook ${safeName} (error): ${errorText}`;
        const enqueued = enqueueSystemEvent(fallbackText, {
          sessionKey: mainSessionKey,
          trusted: false,
          deliveryContext: mainDeliveryContext,
        });
        logHooks.info("hook trace: error fallback system event queued", {
          jobId,
          runId,
          hookName: safeName,
          mainSessionKey,
          enqueued,
          wakeMode: value.wakeMode,
          eventPreview: previewHookTraceText(fallbackText),
        });
        if (value.wakeMode === "now") {
          logHooks.info("hook trace: wake requested for hook error", {
            jobId,
            runId,
            hookName: safeName,
            mainSessionKey,
          });
          requestHookAgentTurn({ reason: `hook:${jobId}:error` });
        }
      }
    })();

    return runId;
  };

  return createHooksRequestHandler({
    getHooksConfig,
    bindHost,
    port,
    logHooks,
    getClientIpConfig,
    dispatchAgentHook,
    dispatchWakeHook,
  });
}
