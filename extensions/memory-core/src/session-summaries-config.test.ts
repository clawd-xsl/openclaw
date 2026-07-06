import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_SUMMARIES_CONFIG,
  resolveSessionSummariesConfig,
} from "./session-summaries-config.js";

describe("resolveSessionSummariesConfig", () => {
  it("defaults to bounded continuity behavior", () => {
    expect(resolveSessionSummariesConfig()).toEqual(DEFAULT_SESSION_SUMMARIES_CONFIG);
    expect(DEFAULT_SESSION_SUMMARIES_CONFIG).toMatchObject({
      enabled: true,
      autoInject: true,
      model: "anthropic/claude-sonnet-4-6",
    });
  });

  it("documents the preferred model and the host trust fallback", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { uiHints?: Record<string, { help?: string }> };
    const help = manifest.uiHints?.["summaries.model"]?.help ?? "";

    expect(help).toContain("default: anthropic/claude-sonnet-4-6");
    expect(help).toContain("allowModelOverride is true");
    expect(help).toContain("otherwise generation uses the target agent's configured model");
  });

  it("resolves every supported summaries field", () => {
    expect(
      resolveSessionSummariesConfig({
        pluginConfig: {
          summaries: {
            enabled: true,
            model: " anthropic/claude-sonnet-4-6 ",
            autoInject: true,
            lookbackDays: 14,
            maxPromptTokens: 8_000,
            minMessages: 5,
          },
        },
      }),
    ).toEqual({
      enabled: true,
      model: "anthropic/claude-sonnet-4-6",
      autoInject: true,
      lookbackDays: 14,
      maxPromptTokens: 8_000,
      minMessages: 5,
    });
  });

  it("falls back instead of accepting out-of-range numbers", () => {
    expect(
      resolveSessionSummariesConfig({
        pluginConfig: {
          summaries: {
            lookbackDays: 0,
            maxPromptTokens: 100,
            minMessages: 10_000,
          },
        },
      }),
    ).toMatchObject({
      lookbackDays: DEFAULT_SESSION_SUMMARIES_CONFIG.lookbackDays,
      maxPromptTokens: DEFAULT_SESSION_SUMMARIES_CONFIG.maxPromptTokens,
      minMessages: DEFAULT_SESSION_SUMMARIES_CONFIG.minMessages,
    });
  });
});
