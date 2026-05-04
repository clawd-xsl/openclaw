import { describe, expect, it, vi } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import { expectPassthroughReplayPolicy } from "../../test/helpers/provider-replay-policy.ts";
import openrouterPlugin from "./index.js";

describe("openrouter provider hooks", () => {
  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    await expectPassthroughReplayPolicy({
      plugin: openrouterPlugin,
      providerId: "openrouter",
      modelId: "gemini-2.5-pro",
      sanitizeThoughtSignatures: true,
    });
    await expectPassthroughReplayPolicy({
      plugin: openrouterPlugin,
      providerId: "openrouter",
      modelId: "openai/gpt-5.4",
    });
  });

  it("owns native reasoning output mode", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "openrouter",
        modelApi: "openai-completions",
        modelId: "openai/gpt-5.4",
      } as never),
    ).toBe("native");
  });

  it("drops OpenClaw delivery-mirror assistant messages for DeepSeek routes only", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    const messages = [
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
    ];

    const deepseekSanitized = provider.sanitizeReplayHistory?.({
      provider: "openrouter",
      modelApi: "openai-completions",
      modelId: "deepseek/deepseek-v4-pro",
      sessionId: "session-1",
      messages,
    } as never);
    expect(deepseekSanitized).toEqual([
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

    const openaiSanitized = provider.sanitizeReplayHistory?.({
      provider: "openrouter",
      modelApi: "openai-completions",
      modelId: "openai/gpt-5.5",
      sessionId: "session-2",
      messages,
    } as never);
    expect(openaiSanitized).toBeUndefined();
  });

  it("injects provider routing into compat before applying stream wrappers", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const baseStreamFn = vi.fn(
      (..._args: Parameters<import("@mariozechner/pi-agent-core").StreamFn>) =>
        ({ async *[Symbol.asyncIterator]() {} }) as never,
    );

    const wrapped = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "openai/gpt-5.4",
      extraParams: {
        provider: {
          order: ["moonshot"],
        },
      },
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);

    void wrapped?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "openai/gpt-5.4",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
    const firstCall = baseStreamFn.mock.calls[0];
    const firstModel = firstCall?.[0];
    expect(firstModel).toMatchObject({
      compat: {
        openRouterRouting: {
          order: ["moonshot"],
        },
      },
    });
  });
});
