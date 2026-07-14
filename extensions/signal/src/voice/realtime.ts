// One realtime-voice bridge session bound to a single Signal call's AudioBridge.
// Mirrors the Discord voice realtime template: a PCM16/24k audio sink writes model
// TTS into the call's mic (-> INPUT_SINK -> remote peer), the call's ear stream
// (OUTPUT_SINK.monitor, 48k stereo) is pumped into the model, and the agent brain
// is reached through the openclaw_agent_consult tool -> runAgentTurn (which
// delegates to consultRealtimeVoiceAgent / the main Claude agent).
//
// The SignalCallManager owns the AudioBridge lifecycle; this session only reads
// `ear` and writes `mic`, and never calls `audio.close()`.
import type { SignalCallAudioBridge, SignalCallPeer } from "@openclaw/signal-ts";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  buildRealtimeVoiceAgentConsultChatMessage,
  buildRealtimeVoiceAgentConsultPolicyInstructions,
  createRealtimeVoiceBridgeSession,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resolveConfiguredRealtimeVoiceProvider,
  resolveRealtimeVoiceAgentConsultToolPolicy,
  resolveRealtimeVoiceAgentConsultTools,
  type RealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceRole,
  type RealtimeVoiceToolCallEvent,
} from "openclaw/plugin-sdk/realtime-voice";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  convertRealtimePcm24kMonoToSignalPcm48kStereo,
  convertSignalPcm48kStereoToRealtimePcm24kMono,
  REALTIME_MONO_SAMPLE_BYTES,
  SIGNAL_STEREO_FRAME_BYTES,
  takeAlignedFrames,
} from "./audio.js";
import type { SignalVoiceCallConfig } from "./config.js";

const logger = createSubsystemLogger("signal/voice");

const SIGNAL_REALTIME_TRANSCRIPT_PREVIEW_CHARS = 200;
const SIGNAL_REALTIME_DEFAULT_TOOL_POLICY: RealtimeVoiceAgentConsultToolPolicy = "owner";
const SIGNAL_REALTIME_DEFAULT_CONSULT_POLICY = "always" as const;

export type SignalRealtimeVoiceSession = {
  connect(): Promise<void>;
  close(): void;
};

type SignalRealtimeVoiceSessionParams = {
  cfg: OpenClawConfig;
  voiceConfig: SignalVoiceCallConfig; // resolved channels.signal.voiceCall
  audio: SignalCallAudioBridge; // from the "connected" event
  peer: SignalCallPeer;
  route: { agentId: string; sessionKey: string };
  // Delegates substantive turns to consultRealtimeVoiceAgent / the main agent.
  runAgentTurn: (p: { message: string }) => Promise<string>;
};

/**
 * Builds a realtime voice bridge session for one answered Signal call. The caller
 * ("connected" event) owns the AudioBridge; connect() attaches the ear pump and
 * close() detaches it without tearing down the bridge itself.
 */
export function createSignalRealtimeVoiceSession(
  params: SignalRealtimeVoiceSessionParams,
): SignalRealtimeVoiceSession {
  return new SignalRealtimeVoiceSessionImpl(params);
}

class SignalRealtimeVoiceSessionImpl implements SignalRealtimeVoiceSession {
  private bridge: RealtimeVoiceBridgeSession | null = null;
  private stopped = false;
  private consultToolPolicy: RealtimeVoiceAgentConsultToolPolicy =
    SIGNAL_REALTIME_DEFAULT_TOOL_POLICY;
  // Sub-frame remainders carried across arbitrarily-chunked stream reads/writes.
  private earResidual: Buffer = Buffer.alloc(0);
  private micResidual: Buffer = Buffer.alloc(0);
  // Bound once so the same reference detaches cleanly on close().
  private readonly earListener = (chunk: unknown): void => {
    if (this.stopped || !this.bridge || !Buffer.isBuffer(chunk)) {
      return;
    }
    const { frames, residual } = takeAlignedFrames(
      this.earResidual,
      chunk,
      SIGNAL_STEREO_FRAME_BYTES,
    );
    this.earResidual = residual;
    if (frames.length === 0) {
      return;
    }
    const realtimePcm = convertSignalPcm48kStereoToRealtimePcm24kMono(frames);
    if (realtimePcm.length > 0) {
      this.bridge.sendAudio(realtimePcm);
    }
  };

  constructor(private readonly params: SignalRealtimeVoiceSessionParams) {}

  async connect(): Promise<void> {
    const voiceConfig = this.params.voiceConfig;
    const resolved = resolveConfiguredRealtimeVoiceProvider({
      configuredProviderId: voiceConfig.realtimeProvider,
      providerConfigOverrides: buildSignalProviderConfigOverrides(voiceConfig),
      cfg: this.params.cfg,
      defaultModel: voiceConfig.model,
      noRegisteredProviderMessage: "No configured realtime voice provider registered",
    });
    const toolPolicy = resolveRealtimeVoiceAgentConsultToolPolicy(
      voiceConfig.toolPolicy,
      SIGNAL_REALTIME_DEFAULT_TOOL_POLICY,
    );
    this.consultToolPolicy = toolPolicy;
    const consultPolicy = voiceConfig.consultPolicy ?? SIGNAL_REALTIME_DEFAULT_CONSULT_POLICY;
    const instructions = buildSignalRealtimeInstructions({
      instructions: voiceConfig.instructions,
      toolPolicy,
      consultPolicy,
    });
    this.bridge = createRealtimeVoiceBridgeSession({
      provider: resolved.provider,
      cfg: this.params.cfg,
      providerConfig: resolved.providerConfig,
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      instructions,
      // Continuous 1:1 telephony-style audio; the provider VAD drives responses
      // and interruption directly off the mono ear stream.
      autoRespondToAudio: true,
      interruptResponseOnInputAudio: true,
      markStrategy: "ack-immediately",
      tools: toolPolicy === "none" ? [] : resolveRealtimeVoiceAgentConsultTools(toolPolicy),
      audioSink: {
        isOpen: () => !this.stopped,
        sendAudio: (audio) => this.writeMicAudio(audio),
        clearAudio: () => {
          // No per-frame clear on the Pulse mic sink: RingRTC captures a continuous
          // stream and the model's VAD owns barge-in. Dropping bytes here would
          // desync the 48k pacat playback pipeline mid-utterance.
        },
      },
      onTranscript: (role, text, isFinal) => this.handleTranscript(role, text, isFinal),
      onToolCall: (event, session) => this.handleToolCall(event, session),
      onError: (error) => logger.warn(`signal voice: realtime error: ${formatErrorMessage(error)}`),
      onClose: (reason) => logger.debug(`signal voice: realtime closed: ${reason}`),
    });
    const resolvedModel =
      readProviderConfigString(resolved.providerConfig, "model") ?? resolved.provider.defaultModel;
    const resolvedVoice = readProviderConfigString(resolved.providerConfig, "voice");
    logger.info(
      `signal voice: realtime bridge starting peer=${this.params.peer.aci} agent=${this.params.route.agentId} provider=${resolved.provider.id} model=${resolvedModel ?? "default"} voice=${resolvedVoice ?? "default"} consultPolicy=${consultPolicy} toolPolicy=${toolPolicy}`,
    );
    await this.bridge.connect();
    // Attach the ear pump only after the provider socket is ready so early frames
    // are not sent before the model can accept them.
    this.params.audio.ear.on("data", this.earListener);
    const greeting = voiceConfig.greeting?.trim();
    if (greeting) {
      this.bridge.triggerGreeting(greeting);
    }
    logger.info(
      `signal voice: realtime bridge ready peer=${this.params.peer.aci} provider=${resolved.provider.id}`,
    );
  }

  close(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.params.audio.ear.removeListener("data", this.earListener);
    this.earResidual = Buffer.alloc(0);
    this.micResidual = Buffer.alloc(0);
    this.bridge?.close();
    this.bridge = null;
  }

  private writeMicAudio(realtimePcm24kMono: Buffer): void {
    if (this.stopped) {
      return;
    }
    const { frames, residual } = takeAlignedFrames(
      this.micResidual,
      realtimePcm24kMono,
      REALTIME_MONO_SAMPLE_BYTES,
    );
    this.micResidual = residual;
    if (frames.length === 0) {
      return;
    }
    const signalPcm = convertRealtimePcm24kMonoToSignalPcm48kStereo(frames);
    if (signalPcm.length === 0) {
      return;
    }
    const mic = this.params.audio.mic;
    if (!mic.writable) {
      return;
    }
    try {
      mic.write(signalPcm);
    } catch (error) {
      logger.warn(`signal voice: mic write failed: ${formatErrorMessage(error)}`);
    }
  }

  private handleTranscript(role: RealtimeVoiceRole, text: string, isFinal: boolean): void {
    if (!isFinal || !text.trim()) {
      return;
    }
    logger.info(
      `signal voice: realtime ${role} transcript (${text.length} chars) peer=${this.params.peer.aci} agent=${this.params.route.agentId}: ${previewTranscript(text)}`,
    );
  }

  private handleToolCall(
    event: RealtimeVoiceToolCallEvent,
    session: RealtimeVoiceBridgeSession,
  ): void {
    const callId = event.callId || event.itemId || "unknown";
    if (
      event.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME ||
      this.consultToolPolicy === "none"
    ) {
      session.submitToolResult(callId, { error: `Tool "${event.name}" not available` });
      return;
    }
    let consultMessage: string;
    try {
      consultMessage = buildRealtimeVoiceAgentConsultChatMessage(event.args);
    } catch (error) {
      const message = formatErrorMessage(error);
      logger.warn(
        `signal voice: realtime consult rejected malformed args call=${callId}: ${message}`,
      );
      session.submitToolResult(callId, { error: message });
      return;
    }
    logger.info(
      `signal voice: realtime consult requested call=${callId} peer=${this.params.peer.aci} agent=${this.params.route.agentId} sessionKey=${this.params.route.sessionKey} question=${previewTranscript(consultMessage)}`,
    );
    // Delegate real work to the main agent; the result becomes the tool output the
    // realtime model speaks back over the call.
    void this.params
      .runAgentTurn({ message: consultMessage })
      .then((text) => {
        logger.info(
          `signal voice: realtime consult answer (${text.length} chars) call=${callId} peer=${this.params.peer.aci}: ${previewTranscript(text)}`,
        );
        session.submitToolResult(callId, { text });
      })
      .catch((error: unknown) => {
        logger.warn(
          `signal voice: realtime consult failed call=${callId}: ${formatErrorMessage(error)}`,
        );
        session.submitToolResult(callId, { error: formatErrorMessage(error) });
      });
  }
}

function readProviderConfigString(
  config: RealtimeVoiceProviderConfig,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildSignalProviderConfigOverrides(
  voiceConfig: SignalVoiceCallConfig,
): RealtimeVoiceProviderConfig | undefined {
  const overrides: Record<string, unknown> = {
    ...(voiceConfig.model ? { model: voiceConfig.model } : {}),
    ...(voiceConfig.voice ? { voice: voiceConfig.voice } : {}),
  };
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function buildSignalRealtimeInstructions(params: {
  instructions?: string;
  toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
  consultPolicy: "auto" | "always";
}): string {
  const base =
    params.instructions ??
    [
      "You are OpenClaw's Signal voice interface, speaking on a live 1:1 phone call.",
      "Keep spoken replies concise, natural, and suitable for a real-time call.",
    ].join("\n");
  return [
    base,
    "You are the realtime voice surface for the same OpenClaw agent the caller can message directly.",
    "Do not mention a backend, supervisor, helper, or separate system. Present the result as your own work.",
    "Delegate substantive requests, actions, tool work, current facts, memory, and caller-specific context with openclaw_agent_consult.",
    "Answer directly only for greetings, acknowledgements, or brief filler while waiting.",
    'While waiting for OpenClaw data, use at most one short natural backchannel such as "one sec" or "mm-hmm"; do not treat it as the final answer.',
    buildRealtimeVoiceAgentConsultPolicyInstructions({
      toolPolicy: params.toolPolicy,
      consultPolicy: params.consultPolicy,
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function previewTranscript(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > SIGNAL_REALTIME_TRANSCRIPT_PREVIEW_CHARS
    ? `${collapsed.slice(0, SIGNAL_REALTIME_TRANSCRIPT_PREVIEW_CHARS)}…`
    : collapsed;
}
