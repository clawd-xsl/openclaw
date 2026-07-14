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
import { sendMessageSignalTs } from "../signal-ts-outbound.js";
import { isAllowedSignalCaller } from "./allowlist.js";
import { registerSignalCallManager, unregisterSignalCallManager } from "./call-registry.js";
import type { SignalVoiceCallConfig } from "./config.js";
import { generateSignalVoiceContextBrief } from "./context-brief.js";
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
  // Pre-call brief kicked off at accept so it overlaps the RingRTC handshake +
  // audio bringup; consumed (awaited inside the session) at connect. One slot.
  let pendingBrief: Promise<string | undefined> | undefined;
  const closeActiveSession = (): void => {
    pendingBrief = undefined;
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

  // Pre-start the brief so it overlaps ringing; buildAndConnectSession awaits it.
  const kickOffContextBrief = (peer: SignalCallPeer): void => {
    if (pendingBrief || !voiceConfig.contextBrief?.enabled) {
      return;
    }
    const pluginRuntime = getOptionalSignalRuntime();
    if (!pluginRuntime) {
      // buildAndConnectSession re-checks the runtime and starts the brief itself.
      return;
    }
    const route = resolveAgentRoute({
      cfg,
      channel: "signal",
      accountId,
      peer: { kind: "direct", id: peer.aci },
    });
    const promise = generateSignalVoiceContextBrief({
      cfg,
      agentRuntime: pluginRuntime.agent,
      voiceConfig,
      route: { agentId: route.agentId, sessionKey: route.sessionKey },
      peerAci: peer.aci,
    });
    // Suppress unhandled rejection if the call ends before anyone awaits it
    // (e.g. an outbound call the remote never answers). Awaiters still re-throw.
    promise.catch(() => {});
    pendingBrief = promise;
  };

  const manager = createSignalCallManager({
    client,
    account: accountState.account,
    stores,
    config: buildManagerConfig(voiceConfig),
    logger: buildManagerLogger(),
  });

  // Surface a call-setup failure to the caller as a normal user-facing message
  // (a Signal text to their DM). Route through the channel outbound path, not the
  // raw client, which lacks the send auth setup (else RequestUnauthorized).
  const notifyCallerError = async (peer: SignalCallPeer, reason: string): Promise<void> => {
    try {
      await sendMessageSignalTs({
        cfg,
        accountInfo: account,
        runtime,
        to: peer.aci,
        message: `⚠️ I couldn't pick up your voice call: ${reason}`,
      });
    } catch (err) {
      log.warn(`signal voice: failed to notify caller of error: ${formatErrorMessage(err)}`);
    }
  };

  // Build the realtime session and connect its provider socket + instructions.
  // The brief is awaited HERE and is fail-closed: a brief/instruction failure
  // throws, so the call is never answered without full context. No audio yet.
  const buildAndConnectSession = async (
    peer: SignalCallPeer,
  ): Promise<SignalRealtimeVoiceSession> => {
    const pluginRuntime = getOptionalSignalRuntime();
    if (!pluginRuntime) {
      throw new Error("signal voice runtime unavailable");
    }
    // Route per caller so the call shares the same agent + session the caller's
    // text DM resolves to (resolveAgentRoute is the channel's own router).
    const route = resolveAgentRoute({
      cfg,
      channel: "signal",
      accountId,
      peer: { kind: "direct", id: peer.aci },
    });
    // Use the pre-started brief (overlaps ringing) or start it now; either way
    // await it before building instructions.
    const briefPromise =
      pendingBrief ??
      generateSignalVoiceContextBrief({
        cfg,
        agentRuntime: pluginRuntime.agent,
        voiceConfig,
        route: { agentId: route.agentId, sessionKey: route.sessionKey },
        peerAci: peer.aci,
      });
    pendingBrief = undefined;
    const contextBrief = await briefPromise;
    const session = createSignalRealtimeVoiceSession({
      cfg,
      voiceConfig,
      peer,
      route: { agentId: route.agentId, sessionKey: route.sessionKey },
      runAgentTurn: buildRunAgentTurn({ pluginRuntime, route, peer }),
      ...(contextBrief ? { contextBrief } : {}),
    });
    activeSession = session;
    await session.connect();
    return session;
  };

  // Inbound barrier: prepare the voice model FULLY (brief + instructions +
  // provider socket) before answering. Only then accept. On any failure, decline
  // and tell the caller — never answer a call without its instructions.
  const prepareInboundThenAccept = async (peer: SignalCallPeer, callId: bigint): Promise<void> => {
    try {
      await buildAndConnectSession(peer);
    } catch (err) {
      const reason = formatErrorMessage(err);
      log.error(`signal voice: inbound preparation failed for ${peer.aci}; declining: ${reason}`);
      closeActiveSession();
      await notifyCallerError(peer, reason);
      void manager.decline(callId).catch((declineErr: unknown) => {
        log.warn(`signal voice: decline failed: ${formatErrorMessage(declineErr)}`);
      });
      return;
    }
    await manager.accept(callId).catch((err: unknown) => {
      log.warn(`signal voice: accept failed: ${formatErrorMessage(err)}`);
    });
  };

  // Outbound: the remote already answered; prepare, then wire the audio. Same
  // fail-closed policy — hang up and notify on any preparation failure.
  const prepareOutboundThenWire = async (
    peer: SignalCallPeer,
    audio: SignalCallAudioBridge,
  ): Promise<void> => {
    let session: SignalRealtimeVoiceSession;
    try {
      session = await buildAndConnectSession(peer);
    } catch (err) {
      const reason = formatErrorMessage(err);
      log.error(`signal voice: outbound preparation failed for ${peer.aci}; hanging up: ${reason}`);
      closeActiveSession();
      await notifyCallerError(peer, reason);
      void manager.hangup();
      return;
    }
    session.attachAudio(audio);
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
          log.info(`signal voice: preparing inbound call from ${event.peer.aci}`);
          // Start the brief immediately; do NOT answer until the whole
          // instruction is built and the voice model is connected.
          kickOffContextBrief(event.peer);
          void prepareInboundThenAccept(event.peer, event.callId);
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
      case "outgoing": {
        // Agent-placed call: start the brief now so it overlaps ringing.
        kickOffContextBrief(event.peer);
        break;
      }
      case "connected": {
        if (activeSession) {
          // Inbound: the session was prepared before we answered — just wire audio.
          activeSession.attachAudio(event.audio);
        } else {
          // Outbound: the remote just answered — prepare, then wire audio.
          void prepareOutboundThenWire(event.peer, event.audio);
        }
        break;
      }
      case "error": {
        // Surface the real call-setup failure (e.g. TURN fetch): the manager
        // carries the underlying error here, and swallowing it hid the root cause.
        log.error(
          `signal voice: call error callId=${event.callId ?? "unknown"}: ${formatErrorMessage(event.error)}`,
        );
        closeActiveSession();
        break;
      }
      case "ended":
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
