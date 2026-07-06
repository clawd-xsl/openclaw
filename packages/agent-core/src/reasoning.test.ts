import { describe, expect, it } from "vitest";
import type { Model } from "../../llm-core/src/index.js";
import { resolveAgentReasoningOption } from "./reasoning.js";

function makeModel(
  thinkingLevelMap?: Model["thinkingLevelMap"],
  overrides: Partial<Model> = {},
): Model {
  return {
    id: "test-model",
    name: "Test Model",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    thinkingLevelMap,
    ...overrides,
  };
}

describe("resolveAgentReasoningOption", () => {
  it("uses a model's enabled fallback for explicit off", () => {
    expect(resolveAgentReasoningOption(makeModel({ off: "low" }), "off")).toBe("low");
  });

  it.each([undefined, null, "none"])("disables reasoning when off maps to %s", (offFallback) => {
    expect(resolveAgentReasoningOption(makeModel({ off: offFallback }), "off")).toBeUndefined();
  });

  it("preserves enabled thinking levels", () => {
    expect(resolveAgentReasoningOption(makeModel({ off: "low" }), "high")).toBe("high");
  });

  it.each(["anthropic-messages", "bedrock-converse-stream"] as const)(
    "maps explicit off to low for canonical Fable aliases on %s",
    (api) => {
      expect(
        resolveAgentReasoningOption(
          makeModel(undefined, {
            id: "production-deployment",
            api,
            params: { canonicalModelId: "claude-fable-5" },
          }),
          "off",
        ),
      ).toBe("low");
    },
  );

  it("preserves explicit off for Claude Sonnet 5's default-adaptive contract", () => {
    expect(
      resolveAgentReasoningOption(
        makeModel(undefined, {
          id: "prod-sonnet",
          params: { canonicalModelId: "claude-sonnet-5" },
        }),
        "off",
      ),
    ).toBe("off");
  });

  it("maps explicit off to low for Bedrock Claude Sonnet 5", () => {
    expect(
      resolveAgentReasoningOption(
        makeModel(undefined, {
          id: "prod-sonnet",
          api: "bedrock-converse-stream",
          provider: "amazon-bedrock",
          params: { canonicalModelId: "claude-sonnet-5" },
        }),
        "off",
      ),
    ).toBe("low");
  });
});
