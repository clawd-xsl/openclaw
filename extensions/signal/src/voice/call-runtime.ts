// Per-account Signal voice controller. Builds the signal-ts SignalCallManager,
// gates inbound calls by allowlist, and drives one realtime-voice session on the
// "connected" event. The manager owns the RingRTC/audio lifecycle; this file owns
// allowlist policy, per-peer agent routing, and the single active voice session.
import {
  createSignalCallManager,
  type CreateSignalCallManagerParams,
  type FileSignalAccountState,
  type SignalCallAudioBridge,
  type SignalCallEvent,
  type SignalCallManager,
  type SignalCallPeer,
  type SignalLibsignalStores,
  type SignalTsClient,
} from "@openclaw/signal-ts";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  consultRealtimeVoiceAgent,
  resolveRealtimeVoiceAgentConsultToolPolicy,
  resolveRealtimeVoiceAgentConsultToolsAllow,
} from "openclaw/plugin-sdk/realtime-voice";
import { resolveAgentRoute, type ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { createSubsystemLogger, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { ResolvedSignalAccount } from "../accounts.js";
import { getOptionalSignalRuntime } from "../runtime.js";
import { isAllowedSignalCaller } from "./allowlist.js";
import { registerSignalCallManager, unregisterSignalCallManager } from "./call-registry.js";
import type { SignalVoiceCallConfig } from "./config.js";
import { createSignalRealtimeVoiceSession, type SignalRealtimeVoiceSession } from "./realtime.js";

const log = createSubsystemLogger("signal/voice");

// The realtime consult defaults to "owner" so the delegated agent keeps full tool
// access; voiceCall.toolPolicy narrows it (safe-read-only / none) per deployment.
const SIGNAL_VOICE_DEFAULT_TOOL_POLICY = "owner" as const;

export type SignalVoiceRuntime = {
  manager: SignalCallManager;
  // False once ensureReady() has failed (optional @signalapp/ringrtc missing):
  // inbound call messages are then dropped instead of repeatedly failing, and no
  // decline can be sent because the native calling stack never loaded.
  isReady(): boolean;
  stop(): Promise<void>;
};

export type StartSignalVoiceRuntimeParams = {
  cfg: OpenClawConfig;
  account: ResolvedSignalAccount;
  // signal-ts account state (from the monitor's client context) that the manager
  // needs for self-uuid, device id, and TURN fetch — distinct from the OpenClaw
  // ResolvedSignalAccount which only carries accountId + resolved config.
  accountState: FileSignalAccountState;
  voiceConfig: SignalVoiceCallConfig;
  client: SignalTsClient;
  stores: SignalLibsignalStores;
  runtime: RuntimeEnv;
};

export function startSignalVoiceRuntime(params: StartSignalVoiceRuntimeParams): SignalVoiceRuntime {
  const { cfg, account, accountState, voiceConfig, client, stores, runtime } = params;
  const accountId = account.accountId;

  // Single active voice session slot (v1 is one concurrent call per account).
  let activeSession: SignalRealtimeVoiceSession | undefined;
  const closeActiveSession = (): void => {
    if (!activeSession) {
      return;
    }
    try {
      activeSession.close();
    } catch (err) {
      log.warn(`signal voice: session close failed: ${formatErrorMessage(err)}`);
    }
    activeSession = undefined;
  };

  const manager = createSignalCallManager({
    client,
    account: accountState.account,
    stores,
    config: buildManagerConfig(voiceConfig),
    environment: "production",
    ...(accountState.userAgent ? { userAgent: accountState.userAgent } : {}),
    logger: buildManagerLogger(),
  });

  const startVoiceSession = (peer: SignalCallPeer, audio: SignalCallAudioBridge): void => {
    const pluginRuntime = getOptionalSignalRuntime();
    if (!pluginRuntime) {
      // Without the plugin runtime we cannot reach the agent; drop the call rather
      // than hold a silent line open.
      log.error("signal voice: plugin runtime unavailable; hanging up connected call");
      void manager.hangup();
      return;
    }
    // Route per caller so the voice call shares the same agent + session the caller's
    // text DM would resolve to (resolveAgentRoute is the channel's own router).
    const route = resolveAgentRoute({
      cfg,
      channel: "signal",
      accountId,
      peer: { kind: "direct", id: peer.aci },
    });
    const session = createSignalRealtimeVoiceSession({
      cfg,
      voiceConfig,
      audio,
      peer,
      route: { agentId: route.agentId, sessionKey: route.sessionKey },
      runAgentTurn: buildRunAgentTurn({ pluginRuntime, route, peer }),
    });
    activeSession = session;
    void session.connect().catch((err: unknown) => {
      log.error(`signal voice: realtime session connect failed: ${formatErrorMessage(err)}`);
      if (activeSession === session) {
        closeActiveSession();
      }
      void manager.hangup();
    });
  };

  const buildRunAgentTurn = (ctx: {
    pluginRuntime: PluginRuntime;
    route: ResolvedAgentRoute;
    peer: SignalCallPeer;
  }): ((p: { message: string }) => Promise<string>) => {
    const toolsAllow = resolveRealtimeVoiceAgentConsultToolsAllow(
      resolveRealtimeVoiceAgentConsultToolPolicy(
        voiceConfig.toolPolicy,
        SIGNAL_VOICE_DEFAULT_TOOL_POLICY,
      ),
    );
    return async ({ message }) => {
      const result = await consultRealtimeVoiceAgent({
        cfg,
        agentRuntime: ctx.pluginRuntime.agent,
        logger: log,
        agentId: ctx.route.agentId,
        sessionKey: ctx.route.sessionKey,
        messageProvider: "signal",
        lane: "signal-voice",
        runIdPrefix: `signal-voice-consult:${ctx.peer.aci}`,
        args: { question: message },
        transcript: [],
        surface: "a live Signal voice call",
        userLabel: "Caller",
        assistantLabel: "Agent",
        questionSourceLabel: "caller",
        ...(toolsAllow !== undefined ? { toolsAllow } : {}),
      });
      return result.text;
    };
  };

  const handleEvent = (event: SignalCallEvent): void => {
    switch (event.type) {
      case "incoming": {
        if (isAllowedSignalCaller(event.peer, voiceConfig.allowFrom)) {
          log.info(`signal voice: accepting inbound call from ${event.peer.aci}`);
          void manager.accept(event.callId).catch((err: unknown) => {
            log.warn(`signal voice: accept failed: ${formatErrorMessage(err)}`);
          });
        } else {
          log.info(
            `signal voice: declining inbound call from ${event.peer.aci} (not in allowFrom)`,
          );
          void manager.decline(event.callId).catch((err: unknown) => {
            log.warn(`signal voice: decline failed: ${formatErrorMessage(err)}`);
          });
        }
        break;
      }
      case "connected": {
        // A fresh connect supersedes any lingering session from a prior call.
        closeActiveSession();
        startVoiceSession(event.peer, event.audio);
        break;
      }
      case "ended":
      case "error":
      case "busy": {
        closeActiveSession();
        break;
      }
      default:
        break;
    }
  };

  const offEvents = manager.on(handleEvent);

  // ensureReady loads the optional @signalapp/ringrtc native package. A missing
  // package surfaces a friendly error into the channel log and leaves the manager
  // unavailable; text features are unaffected because we never throw here.
  let ready = true;
  void manager.ensureReady().catch((err: unknown) => {
    ready = false;
    const message = formatErrorMessage(err);
    log.error(`signal voice: calling unavailable: ${message}`);
    runtime.error(`signal-ts: signal voice calling disabled: ${message}`);
  });

  const voiceRuntime: SignalVoiceRuntime = {
    manager,
    isReady: () => ready,
    stop: async () => {
      offEvents();
      closeActiveSession();
      unregisterSignalCallManager(accountId, voiceRuntime);
      await manager.close();
    },
  };
  registerSignalCallManager(accountId, voiceRuntime);
  log.info(`signal voice: runtime started account=${accountId}`);
  return voiceRuntime;

  function buildManagerLogger(): NonNullable<CreateSignalCallManagerParams["logger"]> {
    return {
      debug: (message) => log.debug?.(message),
      info: (message) => log.info(message),
      warn: (message) => log.warn(message),
      error: (message, err) =>
        log.error(err === undefined ? message : `${message}: ${formatErrorMessage(err)}`),
    };
  }
}

function buildManagerConfig(
  voiceConfig: SignalVoiceCallConfig,
): NonNullable<CreateSignalCallManagerParams["config"]> {
  return {
    dataMode: "normal",
    ...(voiceConfig.hideIp !== undefined ? { hideIp: voiceConfig.hideIp } : {}),
    ...(voiceConfig.maxCallDurationMs !== undefined
      ? { maxCallDurationMs: voiceConfig.maxCallDurationMs }
      : {}),
    ...(voiceConfig.pulse ? { pulse: voiceConfig.pulse } : {}),
  };
}
