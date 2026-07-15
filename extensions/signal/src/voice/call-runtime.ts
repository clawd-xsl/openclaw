// Per-account Signal voice controller. Builds the signal-ts SignalCallManager,
// gates inbound calls by allowlist, and drives one realtime-voice session on the
// "connected" event. The manager owns the RingRTC/audio lifecycle; this file owns
// allowlist policy, per-peer agent routing, and the single active voice session.
import {
  createSignalCallManager,
  type CreateSignalCallManagerParams,
  type FileSignalAccountState,
  type FileSignalRepository,
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
import { resolveSignalTsPreKeyAuth } from "../signal-ts-client.js";
import { sendMessageSignalTs } from "../signal-ts-outbound.js";
import { isAllowedSignalCaller } from "./allowlist.js";
import { registerSignalCallManager, unregisterSignalCallManager } from "./call-registry.js";
import type { SignalVoiceCallConfig } from "./config.js";
import {
  generateSignalVoiceContextBrief,
  refreshSignalVoicePersonaBrief,
} from "./context-brief.js";
import { createSignalRealtimeVoiceSession, type SignalRealtimeVoiceSession } from "./realtime.js";

const log = createSubsystemLogger("signal/voice");

// The realtime consult defaults to "owner" so the delegated agent keeps full tool
// access; voiceCall.toolPolicy narrows it (safe-read-only / none) per deployment.
const SIGNAL_VOICE_DEFAULT_TOOL_POLICY = "owner" as const;

// End reasons that indicate failure rather than an intentional hangup/decline.
// The manager emits no separate "error" event for these (e.g. a signaling
// failure just ends the call), so they carry the real pickup-failure cause.
const CALL_FAILURE_END_REASONS = new Set([
  "glare",
  "timeout",
  "connection-failure",
  "signaling-failure",
  "unsupported",
  "internal-failure",
  // Callee's message-request gate blocked the call (they lack our profile key).
  "need-permission",
]);

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
  // Recipient store backing per-peer access-key resolution for call signaling.
  repository: FileSignalRepository;
  runtime: RuntimeEnv;
};

export function startSignalVoiceRuntime(params: StartSignalVoiceRuntimeParams): SignalVoiceRuntime {
  const { cfg, account, accountState, voiceConfig, client, stores, repository, runtime } = params;
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

  // Warm the persona cache off the call path at voice-runtime start. The
  // refresh reruns the compressor only when the persona workspace files
  // changed; otherwise the cached brief stays as-is (no TTL, no periodic
  // recompute) and call time just reads it.
  const warmPersonaBrief = (): void => {
    if (!voiceConfig.contextBrief?.enabled) {
      return;
    }
    const pluginRuntime = getOptionalSignalRuntime();
    if (!pluginRuntime) {
      return;
    }
    const route = resolveAgentRoute({ cfg, channel: "signal", accountId });
    refreshSignalVoicePersonaBrief({
      cfg,
      agentRuntime: pluginRuntime.agent,
      voiceConfig,
      route: { agentId: route.agentId, sessionKey: route.sessionKey },
    });
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
    // Call signaling rides the same content-send path as normal messages and
    // needs the same per-recipient access-key auth for its prekey fetch.
    resolvePreKeyAuth: (recipientAci) => resolveSignalTsPreKeyAuth(recipientAci, repository),
    config: buildManagerConfig(voiceConfig),
    logger: buildManagerLogger(),
  });

  // Pickup-failure notification state, reset per call attempt. The manager's
  // "error" event carries the root cause (e.g. SignalingFailure) but its teardown
  // also kills the in-flight provider socket, so the prepare catch would
  // otherwise report the secondary "WebSocket was closed" error. Notify once per
  // attempt, root cause first; after audio is wired the call counts as picked up
  // and later errors are log-only.
  let currentPeer: SignalCallPeer | undefined;
  let lastCallError: string | undefined;
  let callerNotified = false;
  let pickedUp = false;
  const beginCallAttempt = (peer: SignalCallPeer): void => {
    currentPeer = peer;
    lastCallError = undefined;
    callerNotified = false;
    pickedUp = false;
  };

  // Surface a call-setup failure to the caller as a normal user-facing message
  // (a Signal text to their DM). Route through the channel outbound path, not the
  // raw client, which lacks the send auth setup (else RequestUnauthorized).
  const notifyCallerError = async (peer: SignalCallPeer, reason: string): Promise<void> => {
    if (callerNotified) {
      return;
    }
    callerNotified = true;
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
      // Prefer the manager's error: its teardown closed our in-flight provider
      // socket, so `err` is often just the secondary "WebSocket was closed".
      const reason = lastCallError ?? formatErrorMessage(err);
      log.error(`signal voice: inbound preparation failed for ${peer.aci}; declining: ${reason}`);
      closeActiveSession();
      await notifyCallerError(peer, reason);
      void manager.decline(callId).catch((declineErr: unknown) => {
        log.warn(`signal voice: decline failed: ${formatErrorMessage(declineErr)}`);
      });
      return;
    }
    // accept() waits for RingRTC to become acceptable (ICE connected) and
    // throws if the call ends or wedges first — the caller must hear about
    // that, since no prepare catch fires after this point.
    await manager.accept(callId).catch(async (err: unknown) => {
      const reason = lastCallError ?? formatErrorMessage(err);
      log.error(`signal voice: accept failed for ${peer.aci}: ${reason}`);
      closeActiveSession();
      await notifyCallerError(peer, reason);
      void manager.hangup();
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
      const reason = lastCallError ?? formatErrorMessage(err);
      log.error(`signal voice: outbound preparation failed for ${peer.aci}; hanging up: ${reason}`);
      closeActiveSession();
      await notifyCallerError(peer, reason);
      void manager.hangup();
      return;
    }
    session.attachAudio(audio);
    pickedUp = true;
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
    // Voice consults want a brief spoken answer fast; default reasoning low
    // (the consult runtime would otherwise use "high", the dominant latency
    // cost on a live call) and let config point at a faster consult model.
    const consultConfig = voiceConfig.consult;
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
        thinkLevel: consultConfig?.thinkLevel ?? "low",
        ...(consultConfig?.model ? { model: consultConfig.model } : {}),
        ...(consultConfig?.provider ? { provider: consultConfig.provider } : {}),
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
          beginCallAttempt(event.peer);
          // Start the brief immediately; do NOT answer until the whole
          // instruction is built and the voice model is connected.
          kickOffContextBrief(event.peer);
          void prepareInboundThenAccept(event.peer, event.callId);
        } else {
          log.info(
            `signal voice: declining inbound call from ${event.peer.aci} (not in allowFrom)`,
          );
          // Not a tracked attempt: a stale currentPeer must not get notified
          // for errors this decline may raise.
          currentPeer = undefined;
          void manager.decline(event.callId).catch((err: unknown) => {
            log.warn(`signal voice: decline failed: ${formatErrorMessage(err)}`);
          });
        }
        break;
      }
      case "outgoing": {
        // Agent-placed call: start the brief now so it overlaps ringing.
        beginCallAttempt(event.peer);
        kickOffContextBrief(event.peer);
        break;
      }
      case "connected": {
        if (activeSession) {
          // Inbound: the session was prepared before we answered — just wire audio.
          activeSession.attachAudio(event.audio);
          pickedUp = true;
        } else {
          // Outbound: the remote just answered — prepare, then wire audio.
          void prepareOutboundThenWire(event.peer, event.audio);
        }
        break;
      }
      case "error": {
        // Surface the real call-setup failure (e.g. TURN fetch, signaling): the
        // manager carries the underlying error here; swallowing it hid the root
        // cause behind secondary teardown errors.
        lastCallError = formatErrorMessage(event.error);
        log.error(`signal voice: call error callId=${event.callId ?? "unknown"}: ${lastCallError}`);
        if (!pickedUp && currentPeer) {
          // Pickup failed on the call path itself (no prepare catch will fire,
          // e.g. after accept). notifyCallerError dedupes against the prepare
          // catch when both race on the same attempt.
          void notifyCallerError(currentPeer, lastCallError);
        }
        closeActiveSession();
        break;
      }
      case "ended": {
        // Failure-flavored ends arrive without a separate "error" event; record
        // the cause (first writer wins) and tell the caller when pickup never
        // happened. Intentional hangups/declines stay silent.
        if (CALL_FAILURE_END_REASONS.has(event.reason)) {
          lastCallError ??= `call ended: ${event.reason}`;
          if (!pickedUp && currentPeer) {
            void notifyCallerError(currentPeer, lastCallError);
          }
        }
        closeActiveSession();
        break;
      }
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
  // Warm the default route's persona cache so the first call doesn't pay the
  // live persona composition.
  warmPersonaBrief();
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
