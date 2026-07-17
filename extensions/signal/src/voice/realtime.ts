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

// Provider PCM arrives faster than real time; drain it into the Pulse mic sink
// at real-time pace (one ~20ms chunk per tick) so barge-in can drop everything
// still queued instead of playing seconds of already-buffered audio. 48kHz
// stereo s16 => 48000 * 2ch * 2B * 0.02s = 3840 bytes / 20ms.
const PLAYBACK_TICK_MS = 20;
const PLAYBACK_CHUNK_BYTES = 3840;
// Safety un-suppress: if no new response starts after a barge-in, stop dropping
// assistant audio so the call can never wedge silent.
const AUDIO_SUPPRESS_MAX_MS = 3_000;

export type SignalRealtimeVoiceSession = {
  // Connect the provider socket with the (already-built) instructions. Runs
  // BEFORE the call is answered so the voice model is fully prepared; no audio
  // flows yet. Throws on failure so the caller can decline the call.
  connect(): Promise<void>;
  // Wire the RingRTC audio path once the call is connected. Only after this does
  // the model hear the caller and speak.
  attachAudio(audio: SignalCallAudioBridge): void;
  close(): void;
};

type SignalRealtimeVoiceSessionParams = {
  cfg: OpenClawConfig;
  voiceConfig: SignalVoiceCallConfig; // resolved channels.signal.voiceCall
  peer: SignalCallPeer;
  route: { agentId: string; sessionKey: string };
  // Delegates substantive turns to consultRealtimeVoiceAgent / the main agent.
  runAgentTurn: (p: { message: string }) => Promise<string>;
  // Pre-call briefing distilled from the caller's session (already resolved by
  // the caller). Injected into the realtime instructions so the front-end is not
  // context-blind. Undefined only when the brief feature is disabled.
  contextBrief?: string;
};

/**
 * Builds a realtime voice bridge session for one Signal call. connect() prepares
 * the provider socket + instructions before the call is answered; attachAudio()
 * wires the RingRTC audio path once connected; close() tears both down.
 */
export function createSignalRealtimeVoiceSession(
  params: SignalRealtimeVoiceSessionParams,
): SignalRealtimeVoiceSession {
  return new SignalRealtimeVoiceSessionImpl(params);
}

class SignalRealtimeVoiceSessionImpl implements SignalRealtimeVoiceSession {
  private bridge: RealtimeVoiceBridgeSession | null = null;
  private stopped = false;
  // The RingRTC audio bridge, wired only once the call is answered (attachAudio).
  private audio: SignalCallAudioBridge | undefined;
  private consultToolPolicy: RealtimeVoiceAgentConsultToolPolicy =
    SIGNAL_REALTIME_DEFAULT_TOOL_POLICY;
  // Sub-frame remainders carried across arbitrarily-chunked stream reads/writes.
  private earResidual: Buffer = Buffer.alloc(0);
  private micResidual: Buffer = Buffer.alloc(0);
  // Real-time-paced playback queue (48k stereo s16) feeding the Pulse mic sink.
  private playbackQueue: Buffer = Buffer.alloc(0);
  private playbackTimer: ReturnType<typeof setInterval> | undefined;
  // True from barge-in until the next response starts: drop the interrupted
  // response's late audio deltas so they don't resume playing over the caller.
  private audioSuppressed = false;
  private audioSuppressTimer: ReturnType<typeof setTimeout> | undefined;
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
    const contextBrief = this.params.contextBrief;
    const resolved = resolveConfiguredRealtimeVoiceProvider({
      configuredProviderId: voiceConfig.realtimeProvider,
      // Provider-specific config (e.g. Qwen workspaceId/baseUrl/apiKey) comes
      // from voiceCall.providers; model/voice stay thin per-call overrides.
      providerConfigs: voiceConfig.providers,
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
      contextBrief,
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
        clearAudio: () => this.handleBargeIn(),
      },
      onTranscript: (role, text, isFinal) => this.handleTranscript(role, text, isFinal),
      onToolCall: (event, session) => this.handleToolCall(event, session),
      // Response-lifecycle evidence trail (created/done/cancelled, errors, VAD
      // boundaries, tool submits) for diagnosing wedged calls. Per-frame audio
      // appends and streaming deltas are noise and skipped.
      onEvent: (event) => {
        // A new response means the interrupted one is fully superseded; let its
        // audio play again.
        if (event.type === "response.created") {
          this.resumeAudioAfterBargeIn();
        }
        if (event.type === "input_audio_buffer.append" || event.type.includes(".delta")) {
          return;
        }
        logger.info(
          `signal voice: realtime ${event.direction} ${event.type}` +
            `${event.detail ? ` ${event.detail}` : ""}` +
            `${event.responseId ? ` responseId=${event.responseId}` : ""}`,
        );
      },
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
    logger.info(
      `signal voice: realtime bridge ready (awaiting audio) peer=${this.params.peer.aci} provider=${resolved.provider.id}`,
    );
  }

  attachAudio(audio: SignalCallAudioBridge): void {
    if (this.stopped || this.audio) {
      return;
    }
    this.audio = audio;
    // Attach the ear pump only now: the provider socket + instructions are ready,
    // and the RingRTC audio path exists, so caller audio can start flowing.
    audio.ear.on("data", this.earListener);
    // Start real-time-paced playback: enqueued provider audio drains one chunk
    // per tick so barge-in can drop the rest.
    this.playbackTimer = setInterval(() => this.drainPlaybackChunk(), PLAYBACK_TICK_MS);
    const greeting = this.params.voiceConfig.greeting?.trim();
    if (greeting) {
      this.bridge?.triggerGreeting(greeting);
    }
    logger.info(`signal voice: realtime audio wired peer=${this.params.peer.aci}`);
  }

  close(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.audio?.ear.removeListener("data", this.earListener);
    this.audio = undefined;
    this.earResidual = Buffer.alloc(0);
    this.micResidual = Buffer.alloc(0);
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = undefined;
    }
    if (this.audioSuppressTimer) {
      clearTimeout(this.audioSuppressTimer);
      this.audioSuppressTimer = undefined;
    }
    this.playbackQueue = Buffer.alloc(0);
    this.bridge?.close();
    this.bridge = null;
  }

  // Barge-in: drop everything still queued and stop accepting the interrupted
  // response's late audio until the next response starts.
  private handleBargeIn(): void {
    this.playbackQueue = Buffer.alloc(0);
    this.audioSuppressed = true;
    if (this.audioSuppressTimer) {
      clearTimeout(this.audioSuppressTimer);
    }
    this.audioSuppressTimer = setTimeout(() => {
      this.audioSuppressed = false;
      this.audioSuppressTimer = undefined;
    }, AUDIO_SUPPRESS_MAX_MS);
  }

  private resumeAudioAfterBargeIn(): void {
    this.audioSuppressed = false;
    if (this.audioSuppressTimer) {
      clearTimeout(this.audioSuppressTimer);
      this.audioSuppressTimer = undefined;
    }
  }

  // Writes at most one real-time chunk from the playback queue to the mic sink.
  private drainPlaybackChunk(): void {
    const mic = this.audio?.mic;
    if (this.stopped || !mic || !mic.writable || this.playbackQueue.length === 0) {
      return;
    }
    const take = Math.min(PLAYBACK_CHUNK_BYTES, this.playbackQueue.length);
    const chunk = this.playbackQueue.subarray(0, take);
    this.playbackQueue = this.playbackQueue.subarray(take);
    try {
      mic.write(chunk);
    } catch (error) {
      logger.warn(`signal voice: mic write failed: ${formatErrorMessage(error)}`);
    }
  }

  private writeMicAudio(realtimePcm24kMono: Buffer): void {
    if (this.stopped || !this.audio) {
      // Model output before the audio path is wired (pre-answer) is dropped: the
      // model has no input yet, so this should not carry real speech.
      return;
    }
    if (this.audioSuppressed) {
      // Interrupted response's late audio: drop instead of queueing it behind
      // the caller's speech.
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
    // Enqueue for real-time-paced playback; drainPlaybackChunk feeds the sink.
    this.playbackQueue = Buffer.concat([this.playbackQueue, signalPcm]);
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

export function buildSignalRealtimeInstructions(params: {
  instructions?: string;
  toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
  consultPolicy: "auto" | "always";
  contextBrief?: string;
}): string {
  const base =
    params.instructions ??
    [
      "You are OpenClaw's Signal voice interface, speaking on a live 1:1 phone call.",
      "Keep spoken replies concise, natural, and suitable for a real-time call.",
    ].join("\n");
  const briefBlock = params.contextBrief?.trim()
    ? [
        "Briefing for this call (your own context — do not read it aloud or mention it exists):",
        params.contextBrief.trim(),
      ].join("\n")
    : undefined;
  return [
    base,
    "You are the realtime voice surface for the same OpenClaw agent the caller can message directly.",
    "Do not mention a backend, supervisor, helper, or separate system. Present the result as your own work.",
    // Consulting costs seconds of silence; the briefing already carries persona,
    // the caller relationship, and the recent conversation, so answer those
    // from it directly and reserve the consult for what the briefing lacks.
    "Answer directly from your briefing and the current call for greetings, small talk, who the caller is, your relationship, and what you two were just discussing.",
    "Delegate with openclaw_agent_consult only when you need something the briefing does not cover: a real action or tool call, current/live facts, or specific memory and details beyond the recent conversation.",
    'While waiting for OpenClaw data, use at most one short natural backchannel such as "one sec" or "mm-hmm"; do not treat it as the final answer.',
    briefBlock,
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
