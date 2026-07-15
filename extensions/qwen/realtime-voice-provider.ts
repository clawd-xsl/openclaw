// Qwen provider module implements the DashScope Qwen-Omni realtime voice bridge.
import { randomUUID } from "node:crypto";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import {
  captureWsEvent,
  createDebugProxyWebSocketAgent,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceTool,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  convertPcmToMulaw8k,
  mulawToPcm,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resamplePcm,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asFiniteNumber,
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import WebSocket from "ws";

const QWEN_REALTIME_DEFAULT_MODEL = "qwen3.5-omni-plus-realtime";
const QWEN_REALTIME_DEFAULT_REGION = "cn-beijing";
const QWEN_REALTIME_DEFAULT_VOICE = "Ethan";
const QWEN_REALTIME_DEFAULT_VAD_THRESHOLD = 0.5;
const QWEN_REALTIME_DEFAULT_SILENCE_MS = 800;
// DashScope realtime input-transcription model (per the Model Studio realtime docs).
const QWEN_REALTIME_TRANSCRIPTION_MODEL = "qwen3-asr-flash-realtime";
const QWEN_REALTIME_WS_PATH = "/api-ws/v1/realtime";
// DashScope Qwen-Omni-Realtime speaks/hears fixed sample rates regardless of the
// OpenClaw sink format, so the bridge always transcodes to/from these.
const QWEN_INPUT_SAMPLE_RATE = 16_000;
const QWEN_OUTPUT_SAMPLE_RATE = 24_000;
const QWEN_REALTIME_API_KEY_REQUIRED = "Qwen realtime voice requires a DashScope API key";
const QWEN_REALTIME_ENDPOINT_REQUIRED =
  "Qwen realtime voice requires a workspaceId (or a baseUrl/wsUrl override)";
const MAX_PENDING_AUDIO_CHUNKS = 320;

type QwenRealtimeVoiceProviderConfig = {
  apiKey?: string;
  workspaceId?: string;
  region?: string;
  baseUrl?: string;
  wsUrl?: string;
  model?: string;
  voice?: string;
  instructions?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
};

type QwenRealtimeVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  apiKey: string;
  workspaceId?: string;
  region?: string;
  baseUrl?: string;
  wsUrl?: string;
  model?: string;
  voice?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
};

type QwenRealtimeSessionUpdate = {
  type: "session.update";
  session: {
    modalities: string[];
    voice: string;
    instructions?: string;
    input_audio_format: "pcm";
    output_audio_format: "pcm";
    turn_detection: {
      type: "semantic_vad";
      threshold: number;
      silence_duration_ms: number;
    };
    input_audio_transcription: { model: string };
    tools?: RealtimeVoiceTool[];
  };
};

type QwenRealtimeEvent = {
  type: string;
  delta?: string;
  audio?: string;
  text?: string;
  transcript?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  error?: unknown;
};

function trimToUndefined(value: unknown): string | undefined {
  return normalizeOptionalString(value);
}

function asUnitInterval(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && number >= 0 && number <= 1 ? number : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

// Mirror the OpenAI/Google config precedence: providers.<id> -> <id> -> root.
function resolveQwenProviderConfigRecord(
  config: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providers = asOptionalRecord(config.providers);
  return (
    asOptionalRecord(providers?.qwen) ?? asOptionalRecord(config.qwen) ?? asOptionalRecord(config)
  );
}

function readModelStudioApiKey(cfg: OpenClawConfig | undefined): unknown {
  const providers = cfg?.models?.providers as
    | Record<string, { apiKey?: unknown } | undefined>
    | undefined;
  return providers?.qwen?.apiKey ?? providers?.modelstudio?.apiKey;
}

function resolveQwenEnvApiKey(): string | undefined {
  return (
    trimToUndefined(process.env.QWEN_API_KEY) ?? trimToUndefined(process.env.DASHSCOPE_API_KEY)
  );
}

function normalizeProviderConfig(
  config: RealtimeVoiceProviderConfig,
  cfg?: OpenClawConfig,
): QwenRealtimeVoiceProviderConfig {
  const raw = resolveQwenProviderConfigRecord(config);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey ?? readModelStudioApiKey(cfg),
      path: "plugins.entries.voice-call.config.realtime.providers.qwen.apiKey",
    }),
    workspaceId: trimToUndefined(raw?.workspaceId),
    region: trimToUndefined(raw?.region),
    baseUrl: trimToUndefined(raw?.baseUrl),
    wsUrl: trimToUndefined(raw?.wsUrl),
    model: trimToUndefined(raw?.model),
    voice: trimToUndefined(raw?.speakerVoice) ?? trimToUndefined(raw?.voice),
    instructions: trimToUndefined(raw?.instructions),
    vadThreshold: asUnitInterval(raw?.vadThreshold),
    silenceDurationMs: asNonNegativeInteger(raw?.silenceDurationMs),
  };
}

function resolveQwenApiKey(configuredApiKey: string | undefined): string | undefined {
  return trimToUndefined(configuredApiKey) ?? resolveQwenEnvApiKey();
}

function hasQwenEndpoint(config: QwenRealtimeVoiceProviderConfig): boolean {
  return Boolean(config.workspaceId || config.baseUrl || config.wsUrl);
}

function toWebSocketScheme(url: string): string {
  if (/^wss?:\/\//i.test(url)) {
    return url;
  }
  if (/^https:\/\//i.test(url)) {
    return url.replace(/^https:\/\//i, "wss://");
  }
  if (/^http:\/\//i.test(url)) {
    return url.replace(/^http:\/\//i, "ws://");
  }
  return `wss://${url}`;
}

function appendModelQuery(url: string, model: string): string {
  if (/[?&]model=/.test(url)) {
    return url;
  }
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}model=${encodeURIComponent(model)}`;
}

// Endpoint resolution: explicit wsUrl wins, then baseUrl origin + realtime path,
// then the standard workspace host. workspaceId is required without an override.
function buildQwenRealtimeWsUrl(config: {
  workspaceId?: string;
  region?: string;
  baseUrl?: string;
  wsUrl?: string;
  model: string;
}): string {
  if (config.wsUrl) {
    return appendModelQuery(toWebSocketScheme(config.wsUrl), config.model);
  }
  if (config.baseUrl) {
    const origin = toWebSocketScheme(config.baseUrl).replace(/\/+$/, "");
    const withPath = origin.includes(QWEN_REALTIME_WS_PATH)
      ? origin
      : `${origin}${QWEN_REALTIME_WS_PATH}`;
    return appendModelQuery(withPath, config.model);
  }
  if (!config.workspaceId) {
    throw new Error(QWEN_REALTIME_ENDPOINT_REQUIRED);
  }
  const region = config.region ?? QWEN_REALTIME_DEFAULT_REGION;
  const host = `${config.workspaceId}.${region}.maas.aliyuncs.com`;
  return appendModelQuery(`wss://${host}${QWEN_REALTIME_WS_PATH}`, config.model);
}

function base64ToBuffer(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}

function readQwenErrorDetail(error: unknown): string {
  if (typeof error === "string" && error) {
    return error;
  }
  const record = asOptionalRecord(error);
  const message = record?.message;
  if (typeof message === "string" && message) {
    return message;
  }
  return "Unknown error";
}

class QwenRealtimeVoiceBridge implements RealtimeVoiceBridge {
  private static readonly MAX_RECONNECT_ATTEMPTS = 3;
  private static readonly BASE_RECONNECT_DELAY_MS = 500;
  private static readonly CONNECT_TIMEOUT_MS = 10_000;
  readonly supportsToolResultContinuation = true;

  private ws: WebSocket | null = null;
  private connected = false;
  private sessionConfigured = false;
  private intentionallyClosed = false;
  private reconnectAttempts = 0;
  private pendingAudio: Buffer[] = [];
  private responseActive = false;
  // A response.create requested while a response is still active is deferred,
  // then flushed on response.done/cancelled. Qwen requires the prior response
  // to finish before the next one; without this a tool result submitted mid-
  // response (e.g. a malformed tool call OpenClaw rejects immediately) drops
  // its response.create and the call goes silent.
  private responseCreatePending = false;
  private continuingToolCallIds = new Set<string>();
  private toolCallBuffers = new Map<string, { name: string; callId: string; args: string }>();
  private connectionUrl = "";
  private readonly flowId = randomUUID();
  private readonly audioFormat: RealtimeVoiceAudioFormat;

  constructor(private readonly config: QwenRealtimeVoiceBridgeConfig) {
    this.audioFormat = config.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ;
  }

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    this.reconnectAttempts = 0;
    await this.doConnect();
  }

  sendAudio(audio: Buffer): void {
    if (!this.connected || !this.sessionConfigured || this.ws?.readyState !== WebSocket.OPEN) {
      if (this.pendingAudio.length < MAX_PENDING_AUDIO_CHUNKS) {
        this.pendingAudio.push(audio);
      }
      return;
    }
    const pcm16k = this.toQwenInputPcm16k(audio);
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: pcm16k.toString("base64"),
    });
  }

  setMediaTimestamp(_ts: number): void {}

  sendUserMessage(text: string): void {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: normalized }],
      },
    });
    this.requestResponseCreate();
  }

  triggerGreeting(instructions?: string): void {
    if (!this.isConnected()) {
      return;
    }
    this.sendUserMessage(instructions ?? this.config.instructions ?? "Greet the caller.");
  }

  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    // Function calling is undocumented for DashScope Qwen-Omni-Realtime; this uses
    // the OpenAI-compatible envelope and needs live verification (see handleEvent).
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    if (options?.willContinue === true) {
      this.continuingToolCallIds.add(callId);
      return;
    }
    this.continuingToolCallIds.delete(callId);
    if (options?.suppressResponse === true) {
      return;
    }
    this.requestResponseCreate();
  }

  acknowledgeMark(): void {}

  handleBargeIn(_options?: RealtimeVoiceBargeInOptions): void {
    this.config.onClearAudio();
    if (this.responseActive) {
      this.sendEvent({ type: "response.cancel" }, "reason=barge-in");
    }
  }

  close(): void {
    this.intentionallyClosed = true;
    this.connected = false;
    this.sessionConfigured = false;
    this.pendingAudio = [];
    if (this.ws) {
      this.ws.close(1000, "Bridge closed");
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.connected && this.sessionConfigured;
  }

  private async doConnect(): Promise<void> {
    const apiKey = this.config.apiKey;
    const model = this.config.model ?? QWEN_REALTIME_DEFAULT_MODEL;
    const url = buildQwenRealtimeWsUrl({
      workspaceId: this.config.workspaceId,
      region: this.config.region,
      baseUrl: this.config.baseUrl,
      wsUrl: this.config.wsUrl,
      model,
    });
    const headers = resolveProviderRequestHeaders({
      provider: "qwen",
      baseUrl: url,
      capability: "audio",
      transport: "websocket",
      defaultHeaders: { Authorization: `Bearer ${apiKey}` },
    }) ?? { Authorization: `Bearer ${apiKey}` };

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimeout);
        resolve();
      };
      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimeout);
        reject(error);
      };
      const connectTimeout: ReturnType<typeof setTimeout> = setTimeout(() => {
        if (!this.sessionConfigured && !this.intentionallyClosed) {
          this.ws?.terminate();
          settleReject(new Error("Qwen realtime connection timeout"));
        }
      }, QwenRealtimeVoiceBridge.CONNECT_TIMEOUT_MS);

      if (this.intentionallyClosed) {
        settleResolve();
        return;
      }

      this.connectionUrl = url;
      const proxyAgent = createDebugProxyWebSocketAgent(resolveDebugProxySettings());
      const ws = new WebSocket(url, {
        headers,
        ...(proxyAgent ? { agent: proxyAgent } : {}),
      });
      this.ws = ws;

      ws.on("open", () => {
        this.resetSessionState();
        this.connected = true;
        this.sessionConfigured = false;
        this.reconnectAttempts = 0;
        captureWsEvent({
          url,
          direction: "local",
          kind: "ws-open",
          flowId: this.flowId,
          meta: { provider: "qwen", capability: "realtime-voice" },
        });
        this.sendSessionUpdate();
      });

      ws.on("message", (data: Buffer) => {
        captureWsEvent({
          url,
          direction: "inbound",
          kind: "ws-frame",
          flowId: this.flowId,
          payload: data,
          meta: { provider: "qwen", capability: "realtime-voice" },
        });
        try {
          const event = JSON.parse(data.toString()) as QwenRealtimeEvent;
          if (event.type === "error" && !this.sessionConfigured) {
            settleReject(new Error(readQwenErrorDetail(event.error)));
            ws.close(1000, "startup failed");
            return;
          }
          this.handleEvent(event);
          if (event.type === "session.updated") {
            settleResolve();
          }
        } catch (error) {
          console.error("[qwen] realtime event parse failed:", error);
        }
      });

      ws.on("error", (error: unknown) => {
        captureWsEvent({
          url,
          direction: "local",
          kind: "error",
          flowId: this.flowId,
          errorText: error instanceof Error ? error.message : String(error),
          meta: { provider: "qwen", capability: "realtime-voice" },
        });
        if (!this.sessionConfigured) {
          settleReject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      });

      ws.on("close", (code: number, reasonBuffer: Buffer) => {
        captureWsEvent({
          url,
          direction: "local",
          kind: "ws-close",
          flowId: this.flowId,
          closeCode: typeof code === "number" ? code : undefined,
          meta: {
            provider: "qwen",
            capability: "realtime-voice",
            reason:
              Buffer.isBuffer(reasonBuffer) && reasonBuffer.length > 0
                ? reasonBuffer.toString("utf8")
                : undefined,
          },
        });
        const wasSessionConfigured = this.sessionConfigured;
        this.connected = false;
        this.sessionConfigured = false;
        if (this.intentionallyClosed) {
          settleResolve();
          this.config.onClose?.("completed");
          return;
        }
        if (!wasSessionConfigured && !settled) {
          settleReject(new Error("Qwen realtime connection closed before ready"));
          return;
        }
        void this.attemptReconnect("websocket-close");
      });
    });
  }

  private async attemptReconnect(reason: string): Promise<void> {
    if (this.intentionallyClosed) {
      return;
    }
    if (this.reconnectAttempts >= QwenRealtimeVoiceBridge.MAX_RECONNECT_ATTEMPTS) {
      this.config.onClose?.("error");
      return;
    }
    this.reconnectAttempts += 1;
    const delay =
      QwenRealtimeVoiceBridge.BASE_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1);
    await new Promise((resolve) => {
      setTimeout(resolve, delay);
    });
    if (this.intentionallyClosed) {
      return;
    }
    try {
      await this.doConnect();
    } catch (error) {
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      await this.attemptReconnect(reason);
    }
  }

  private sendSessionUpdate(): void {
    this.sendEvent(this.buildSessionUpdate());
  }

  private buildSessionUpdate(): QwenRealtimeSessionUpdate {
    const cfg = this.config;
    return {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: cfg.voice ?? QWEN_REALTIME_DEFAULT_VOICE,
        instructions: cfg.instructions,
        // Qwen-Omni-Realtime uses the legacy top-level PCM string formats; the
        // bridge always feeds 16k in and receives 24k out (see toQwenInputPcm16k).
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        turn_detection: {
          type: "semantic_vad",
          threshold: cfg.vadThreshold ?? QWEN_REALTIME_DEFAULT_VAD_THRESHOLD,
          silence_duration_ms: cfg.silenceDurationMs ?? QWEN_REALTIME_DEFAULT_SILENCE_MS,
        },
        // Without this the server never emits input transcription events and
        // call logs/consults lose the caller's words (model per DashScope docs).
        input_audio_transcription: { model: QWEN_REALTIME_TRANSCRIPTION_MODEL },
        // No tool_choice: Qwen Omni Realtime does not support it; the server
        // currently ignores the field but it is outside the documented contract.
        ...(cfg.tools && cfg.tools.length > 0 ? { tools: cfg.tools } : {}),
      },
    };
  }

  // Sink -> Qwen input: transcode whatever the OpenClaw sink sends to 16k PCM16.
  private toQwenInputPcm16k(audio: Buffer): Buffer {
    const pcm = this.audioFormat.encoding === "pcm16" ? audio : mulawToPcm(audio);
    return resamplePcm(pcm, this.audioFormat.sampleRateHz, QWEN_INPUT_SAMPLE_RATE);
  }

  // Qwen output (24k PCM16) -> sink format: passthrough for pcm16/24k, mu-law 8k for telephony.
  private toSinkOutputAudio(pcm24k: Buffer): Buffer {
    return this.audioFormat.encoding === "pcm16"
      ? resamplePcm(pcm24k, QWEN_OUTPUT_SAMPLE_RATE, this.audioFormat.sampleRateHz)
      : convertPcmToMulaw8k(pcm24k, QWEN_OUTPUT_SAMPLE_RATE);
  }

  private handleEvent(event: QwenRealtimeEvent): void {
    this.config.onEvent?.({
      direction: "server",
      type: event.type,
      ...(event.type === "error" ? { detail: readQwenErrorDetail(event.error) } : {}),
      ...(event.item_id ? { itemId: event.item_id } : {}),
    });
    switch (event.type) {
      case "session.created":
        return;

      case "session.updated":
        this.sessionConfigured = true;
        for (const chunk of this.pendingAudio.splice(0)) {
          this.sendAudio(chunk);
        }
        this.config.onReady?.();
        return;

      case "response.created":
        this.responseActive = true;
        return;

      case "response.audio.delta":
      case "response.output_audio.delta": {
        const audioDelta = event.delta ?? event.audio;
        if (!audioDelta) {
          return;
        }
        const audio = this.toSinkOutputAudio(base64ToBuffer(audioDelta));
        if (audio.length > 0) {
          this.config.onAudio(audio);
          this.config.onMark?.(`audio-${randomUUID()}`);
        }
        this.responseActive = true;
        return;
      }

      case "input_audio_buffer.speech_started":
        // Barge-in: user started talking; drop queued assistant audio and cancel.
        this.handleBargeIn();
        return;

      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        if (event.delta) {
          this.config.onTranscript?.("assistant", event.delta, false);
        }
        return;

      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const transcript = event.transcript ?? event.text;
        if (transcript) {
          this.config.onTranscript?.("assistant", transcript, true);
        }
        return;
      }

      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.config.onTranscript?.("user", event.delta, false);
        }
        return;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.config.onTranscript?.("user", event.transcript, true);
        }
        return;

      case "response.cancelled":
      case "response.done":
        this.responseActive = false;
        this.flushPendingResponseCreate();
        return;

      // Function calling path is undocumented by Alibaba but the event schema is
      // OpenAI-compatible; this needs live verification against DashScope.
      case "response.function_call_arguments.delta": {
        const key = event.item_id ?? "unknown";
        const existing = this.toolCallBuffers.get(key);
        if (existing && event.delta) {
          existing.args += event.delta;
        } else if (event.item_id) {
          this.toolCallBuffers.set(event.item_id, {
            name: event.name ?? "",
            callId: event.call_id ?? "",
            args: event.delta ?? "",
          });
        }
        return;
      }

      case "response.function_call_arguments.done": {
        const key = event.item_id ?? "unknown";
        const buffered = this.toolCallBuffers.get(key);
        this.emitToolCall({
          itemId: event.item_id,
          callId: buffered?.callId || event.call_id,
          name: buffered?.name || event.name,
          rawArgs: buffered?.args || event.arguments,
        });
        this.toolCallBuffers.delete(key);
        return;
      }

      case "error":
        this.config.onError?.(new Error(readQwenErrorDetail(event.error)));
        return;

      default:
    }
  }

  private emitToolCall(fields: {
    itemId?: string;
    callId?: string;
    name?: string;
    rawArgs?: string;
  }): void {
    if (!this.config.onToolCall) {
      return;
    }
    const itemId = fields.itemId || fields.callId || "unknown";
    const callId = fields.callId || itemId;
    const name = fields.name || "";
    let args: unknown = {};
    try {
      args = JSON.parse(fields.rawArgs || "{}");
    } catch {}
    this.config.onToolCall({ itemId, callId, name, args });
  }

  private requestResponseCreate(): void {
    if (this.responseActive || this.continuingToolCallIds.size > 0) {
      // Defer instead of dropping; flushed when the active response finishes.
      this.responseCreatePending = true;
      return;
    }
    this.responseCreatePending = false;
    this.sendEvent({ type: "response.create" });
  }

  private flushPendingResponseCreate(): void {
    if (!this.responseCreatePending) {
      return;
    }
    this.responseCreatePending = false;
    this.requestResponseCreate();
  }

  private resetSessionState(): void {
    this.responseActive = false;
    this.responseCreatePending = false;
    this.continuingToolCallIds.clear();
    this.toolCallBuffers.clear();
  }

  private sendEvent(event: unknown, detail?: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    const type =
      event && typeof event === "object" && typeof (event as { type?: unknown }).type === "string"
        ? (event as { type: string }).type
        : "unknown";
    this.config.onEvent?.({ direction: "client", type, ...(detail ? { detail } : {}) });
    const payload = JSON.stringify(event);
    captureWsEvent({
      url: this.connectionUrl,
      direction: "outbound",
      kind: "ws-frame",
      flowId: this.flowId,
      payload,
      meta: { provider: "qwen", capability: "realtime-voice" },
    });
    this.ws.send(payload);
  }
}

export function buildQwenRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: "qwen",
    label: "Qwen Omni Realtime",
    defaultModel: QWEN_REALTIME_DEFAULT_MODEL,
    autoSelectOrder: 30,
    capabilities: {
      transports: ["provider-websocket", "gateway-relay"],
      inputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      outputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      supportsBargeIn: true,
      supportsToolCalls: true,
    },
    resolveConfig: ({ cfg, rawConfig }) => normalizeProviderConfig(rawConfig, cfg),
    isConfigured: ({ cfg, providerConfig }) => {
      const config = normalizeProviderConfig(providerConfig, cfg);
      return Boolean(resolveQwenApiKey(config.apiKey)) && hasQwenEndpoint(config);
    },
    createBridge: (req) => {
      const config = normalizeProviderConfig(req.providerConfig, req.cfg);
      const apiKey = resolveQwenApiKey(config.apiKey);
      if (!apiKey) {
        throw new Error(QWEN_REALTIME_API_KEY_REQUIRED);
      }
      if (!hasQwenEndpoint(config)) {
        throw new Error(QWEN_REALTIME_ENDPOINT_REQUIRED);
      }
      return new QwenRealtimeVoiceBridge({
        ...req,
        apiKey,
        workspaceId: config.workspaceId,
        region: config.region,
        baseUrl: config.baseUrl,
        wsUrl: config.wsUrl,
        model: config.model,
        voice: config.voice,
        instructions: req.instructions ?? config.instructions,
        vadThreshold: config.vadThreshold,
        silenceDurationMs: config.silenceDurationMs,
      });
    },
  };
}
