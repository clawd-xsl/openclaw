import { createAssistantMessageEventStream, type Context, type Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { buildOpenAICompletionsParams } from "../../src/agents/openai-transport-stream.js";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import { createDeepSeekV4ThinkingWrapper } from "./api.js";
import deepseekPlugin from "./index.js";

describe("deepseek provider plugin", () => {
  it("registers DeepSeek with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "deepseek-api-key",
    });

    expect(provider.id).toBe("deepseek");
    expect(provider.label).toBe("DeepSeek");
    expect(provider.envVars).toEqual(["DEEPSEEK_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("deepseek");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("builds the static DeepSeek model catalog", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);
    expect(provider.catalog).toBeDefined();

    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      resolveProviderAuth: () => ({
        apiKey: "test-key",
        mode: "api_key",
        source: "env",
      }),
    } as never);

    expect(catalog && "provider" in catalog).toBe(true);
    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected single-provider catalog");
    }

    expect(catalog.provider.api).toBe("openai-completions");
    expect(catalog.provider.baseUrl).toBe("https://api.deepseek.com");
    expect(catalog.provider.models?.map((model) => model.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner",
    ]);
    expect(
      catalog.provider.models?.find((model) => model.id === "deepseek-reasoner")?.reasoning,
    ).toBe(true);
    expect(
      catalog.provider.models?.find((model) => model.id === "deepseek-v4-pro")?.reasoning,
    ).toBe(true);
  });

  it("publishes configured DeepSeek models through plugin-owned catalog augmentation", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);

    expect(
      provider.augmentModelCatalog?.({
        config: {
          models: {
            providers: {
              deepseek: {
                models: [
                  {
                    id: "deepseek-chat",
                    name: "DeepSeek Chat",
                    input: ["text"],
                    reasoning: false,
                    contextWindow: 65536,
                  },
                ],
              },
            },
          },
        },
      } as never),
    ).toEqual([
      {
        provider: "deepseek",
        id: "deepseek-chat",
        name: "DeepSeek Chat",
        input: ["text"],
        reasoning: false,
        contextWindow: 65536,
      },
    ]);
  });

  it("drops OpenClaw delivery-mirror assistant messages from DeepSeek replay history", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);

    const sanitized = provider.sanitizeReplayHistory?.({
      provider: "deepseek",
      modelApi: "openai-completions",
      modelId: "deepseek-v4-pro",
      sessionId: "session-1",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "⚠️ API rate limit reached. Please try again later." }],
          provider: "openclaw",
          model: "delivery-mirror",
          api: "openai-responses",
          stopReason: "stop",
          timestamp: 2,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "normal assistant turn" }],
          provider: "openrouter",
          model: "deepseek/deepseek-v4-pro",
          api: "openai-completions",
          stopReason: "stop",
          timestamp: 3,
        },
      ],
    } as never);

    expect(sanitized).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "normal assistant turn" }],
        provider: "openrouter",
        model: "deepseek/deepseek-v4-pro",
        api: "openai-completions",
        stopReason: "stop",
        timestamp: 3,
      },
    ]);
  });

  it("adds blank reasoning_content for replayed tool calls from non-DeepSeek turns", () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const model = {
      provider: "deepseek",
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      compat: {
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      },
    } as Model<"openai-completions">;
    const context = {
      messages: [
        { role: "user", content: "hi", timestamp: 1 },
        {
          role: "assistant",
          api: "openai-completions",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 3,
        },
      ],
      tools: [
        {
          name: "read",
          description: "Read data",
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
      ],
    } as Context;
    const baseStreamFn = (
      streamModel: Model<"openai-completions">,
      streamContext: Context,
      options?: { onPayload?: (payload: unknown, model: unknown) => unknown },
    ) => {
      capturedPayload = buildOpenAICompletionsParams(streamModel, streamContext, {
        reasoning: "high",
      } as never);
      options?.onPayload?.(capturedPayload, streamModel);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.end());
      return stream;
    };

    const wrapped = createDeepSeekV4ThinkingWrapper(baseStreamFn as never, "high");
    expect(wrapped).toBeDefined();
    wrapped?.(model, context, {});

    expect((capturedPayload?.messages as Array<Record<string, unknown>>)[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "read",
            arguments: "{}",
          },
        },
      ],
    });
  });

  it("strips replayed reasoning_content when DeepSeek V4 thinking is disabled", () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const model = {
      provider: "deepseek",
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      compat: {
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      },
    } as Model<"openai-completions">;
    const context = {
      messages: [
        { role: "user", content: "hi", timestamp: 1 },
        {
          role: "assistant",
          api: "openai-completions",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          content: [
            { type: "text", text: "tool call" },
            { type: "toolCall", id: "call_1", name: "read", arguments: {} },
          ],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 3,
        },
      ],
      tools: [
        {
          name: "read",
          description: "Read data",
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
      ],
    } as Context;
    const baseStreamFn = (
      streamModel: Model<"openai-completions">,
      streamContext: Context,
      options?: { onPayload?: (payload: unknown, model: unknown) => unknown },
    ) => {
      capturedPayload = buildOpenAICompletionsParams(streamModel, streamContext, {
        reasoning: "high",
      } as never);
      options?.onPayload?.(capturedPayload, streamModel);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.end());
      return stream;
    };

    const wrapped = createDeepSeekV4ThinkingWrapper(baseStreamFn as never, "off");
    expect(wrapped).toBeDefined();
    wrapped?.(model, context, {});

    expect(capturedPayload?.thinking).toEqual({ type: "disabled" });
    expect(capturedPayload?.reasoning_effort).toBeUndefined();
    expect(
      (capturedPayload?.messages as Array<Record<string, unknown>>)[1]?.reasoning_content,
    ).toBeUndefined();
  });
});
