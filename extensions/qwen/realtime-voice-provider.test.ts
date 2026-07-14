// Qwen tests cover the DashScope realtime voice provider plugin behavior.
import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildQwenRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const { FakeWebSocket } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class MockWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readonly listeners = new Map<string, Listener[]>();
    readyState = 0;
    sent: string[] = [];
    args: unknown[];

    constructor(...args: unknown[]) {
      this.args = args;
      MockWebSocket.instances.push(this);
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }

    send(payload: string): void {
      this.sent.push(payload);
    }

    close(code?: number, reason?: string): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
    }

    terminate(): void {
      this.close(1006, "terminated");
    }
  }

  return { FakeWebSocket: MockWebSocket };
});

vi.mock("ws", () => ({
  default: FakeWebSocket,
}));

type FakeWebSocketInstance = InstanceType<typeof FakeWebSocket>;

type SentEvent = {
  type: string;
  audio?: string;
  session?: {
    modalities?: string[];
    voice?: string;
    instructions?: string;
    input_audio_format?: string;
    output_audio_format?: string;
    turn_detection?: {
      type?: string;
      threshold?: number;
      silence_duration_ms?: number;
    };
    tools?: RealtimeVoiceTool[];
    tool_choice?: string;
  };
};

const SAMPLE_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: "lookup_weather",
  description: "Look up the weather",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

type BridgeOverrides = {
  providerConfig?: Record<string, unknown>;
  tools?: RealtimeVoiceTool[];
  audioFormat?: typeof REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ;
};

function openBridge(overrides: BridgeOverrides = {}): FakeWebSocketInstance {
  const provider = buildQwenRealtimeVoiceProvider();
  const bridge = provider.createBridge({
    providerConfig: overrides.providerConfig ?? {
      apiKey: "test-key", // pragma: allowlist secret
      workspaceId: "ws1",
    },
    audioFormat: overrides.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    tools: overrides.tools,
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
  });
  void bridge.connect();
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) {
    throw new Error("expected qwen realtime websocket instance");
  }
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  return socket;
}

function sentEvents(socket: FakeWebSocketInstance): SentEvent[] {
  return socket.sent.map((payload) => JSON.parse(payload) as SentEvent);
}

function socketUrl(socket: FakeWebSocketInstance): string {
  return socket.args[0] as string;
}

function socketHeaders(socket: FakeWebSocketInstance): Record<string, string> {
  const options = socket.args[1] as { headers?: Record<string, string> } | undefined;
  return options?.headers ?? {};
}

describe("buildQwenRealtimeVoiceProvider", () => {
  beforeEach(() => {
    // Fake timers keep the bridge connect-timeout from lingering as a real handle.
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubEnv("QWEN_API_KEY", "");
    vi.stubEnv("DASHSCOPE_API_KEY", "");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("declares realtime Talk capabilities for catalog selection", () => {
    const provider = buildQwenRealtimeVoiceProvider();

    expect(provider.id).toBe("qwen");
    expect(provider.label).toBe("Qwen Omni Realtime");
    expect(provider.defaultModel).toBe("qwen3.5-omni-plus-realtime");
    expect(provider.capabilities).toEqual({
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
    });
  });

  describe("isConfigured", () => {
    const provider = buildQwenRealtimeVoiceProvider();

    it("is configured with an api key and workspaceId", () => {
      expect(
        provider.isConfigured({
          providerConfig: { apiKey: "k", workspaceId: "ws1" }, // pragma: allowlist secret
        }),
      ).toBe(true);
    });

    it("is not configured without an api key", () => {
      expect(provider.isConfigured({ providerConfig: { workspaceId: "ws1" } })).toBe(false);
    });

    it("is not configured without a workspaceId or endpoint override", () => {
      expect(
        provider.isConfigured({ providerConfig: { apiKey: "k" } }), // pragma: allowlist secret
      ).toBe(false);
    });

    it("accepts a baseUrl override in place of workspaceId", () => {
      expect(
        provider.isConfigured({
          providerConfig: { apiKey: "k", baseUrl: "wss://voice.example.com" }, // pragma: allowlist secret
        }),
      ).toBe(true);
    });

    it("resolves the api key from QWEN_API_KEY / DASHSCOPE_API_KEY", () => {
      expect(provider.isConfigured({ providerConfig: { workspaceId: "ws1" } })).toBe(false);
      vi.stubEnv("DASHSCOPE_API_KEY", "env-key"); // pragma: allowlist secret
      expect(provider.isConfigured({ providerConfig: { workspaceId: "ws1" } })).toBe(true);
    });

    it("reads nested providers.qwen config", () => {
      expect(
        provider.isConfigured({
          providerConfig: { providers: { qwen: { apiKey: "k", workspaceId: "ws1" } } }, // pragma: allowlist secret
        }),
      ).toBe(true);
    });
  });

  describe("websocket URL construction", () => {
    it("builds the workspace host from workspaceId + default region + model", () => {
      const socket = openBridge({ providerConfig: { apiKey: "k", workspaceId: "ws1" } }); // pragma: allowlist secret
      expect(socketUrl(socket)).toBe(
        "wss://ws1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-plus-realtime",
      );
    });

    it("honors an explicit region and model", () => {
      const socket = openBridge({
        providerConfig: {
          apiKey: "k", // pragma: allowlist secret
          workspaceId: "ws1",
          region: "ap-southeast-1",
          model: "qwen3.5-omni-plus-realtime",
        },
      });
      expect(socketUrl(socket)).toBe(
        "wss://ws1.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-plus-realtime",
      );
    });

    it("converts an https baseUrl override to wss and appends the realtime path", () => {
      const socket = openBridge({
        providerConfig: { apiKey: "k", baseUrl: "https://voice.example.com/" }, // pragma: allowlist secret
      });
      expect(socketUrl(socket)).toBe(
        "wss://voice.example.com/api-ws/v1/realtime?model=qwen3.5-omni-plus-realtime",
      );
    });

    it("uses a full wsUrl override verbatim with the model query", () => {
      const socket = openBridge({
        providerConfig: {
          apiKey: "k", // pragma: allowlist secret
          wsUrl: "wss://custom.example.com/api-ws/v1/realtime",
        },
      });
      expect(socketUrl(socket)).toBe(
        "wss://custom.example.com/api-ws/v1/realtime?model=qwen3.5-omni-plus-realtime",
      );
    });

    it("sends a Bearer Authorization header", () => {
      const socket = openBridge({
        providerConfig: { apiKey: "secret-key", workspaceId: "ws1" }, // pragma: allowlist secret
      });
      expect(socketHeaders(socket).Authorization).toBe("Bearer secret-key");
    });
  });

  describe("session.update", () => {
    it("emits the legacy semantic_vad PCM session shape on open", () => {
      const socket = openBridge({
        providerConfig: {
          apiKey: "k", // pragma: allowlist secret
          workspaceId: "ws1",
          voice: "Chelsie",
          instructions: "Be brief.",
          vadThreshold: 0.6,
          silenceDurationMs: 900,
        },
      });
      const update = sentEvents(socket).find((event) => event.type === "session.update");
      expect(update?.session).toEqual({
        modalities: ["text", "audio"],
        voice: "Chelsie",
        instructions: "Be brief.",
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        turn_detection: {
          type: "semantic_vad",
          threshold: 0.6,
          silence_duration_ms: 900,
        },
      });
    });

    it("defaults voice, threshold, and silence when unset", () => {
      const socket = openBridge();
      const update = sentEvents(socket).find((event) => event.type === "session.update");
      expect(update?.session?.voice).toBe("Ethan");
      expect(update?.session?.turn_detection).toEqual({
        type: "semantic_vad",
        threshold: 0.5,
        silence_duration_ms: 800,
      });
    });

    it("maps tools into the session with tool_choice auto", () => {
      const socket = openBridge({ tools: [SAMPLE_TOOL] });
      const update = sentEvents(socket).find((event) => event.type === "session.update");
      expect(update?.session?.tools).toEqual([SAMPLE_TOOL]);
      expect(update?.session?.tool_choice).toBe("auto");
    });

    it("omits tools when none are provided", () => {
      const socket = openBridge();
      const update = sentEvents(socket).find((event) => event.type === "session.update");
      expect(update?.session?.tools).toBeUndefined();
      expect(update?.session?.tool_choice).toBeUndefined();
    });
  });

  it("throws a clear error when creating a bridge without an api key", () => {
    const provider = buildQwenRealtimeVoiceProvider();
    expect(() =>
      provider.createBridge({
        providerConfig: { workspaceId: "ws1" },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
      }),
    ).toThrow("Qwen realtime voice requires a DashScope API key");
  });
});
