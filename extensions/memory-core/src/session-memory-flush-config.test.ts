import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPLETED_SESSION_MEMORY_FLUSH_CONFIG,
  resolveCompletedSessionMemoryFlushConfig,
} from "./session-memory-flush-config.js";

describe("resolveCompletedSessionMemoryFlushConfig", () => {
  it("enables completed-session flushing by default with a bounded prompt budget", () => {
    expect(resolveCompletedSessionMemoryFlushConfig()).toEqual(
      DEFAULT_COMPLETED_SESSION_MEMORY_FLUSH_CONFIG,
    );
  });

  it("honors an explicit disable", () => {
    expect(
      resolveCompletedSessionMemoryFlushConfig({
        pluginConfig: { completedSessionFlush: { enabled: false } },
      }),
    ).toMatchObject({ enabled: false });
  });

  it("falls back when the prompt budget is outside the schema bounds", () => {
    expect(
      resolveCompletedSessionMemoryFlushConfig({
        pluginConfig: { completedSessionFlush: { maxPromptTokens: 1 } },
      }).maxPromptTokens,
    ).toBe(DEFAULT_COMPLETED_SESSION_MEMORY_FLUSH_CONFIG.maxPromptTokens);
  });
});
