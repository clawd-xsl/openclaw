import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReplyUsageState,
  clearReplyUsageStateForTest,
  consumeReplyUsageState,
  recordReplyUsageState,
} from "./reply-usage-state.js";

afterEach(() => {
  vi.useRealTimers();
  clearReplyUsageStateForTest();
});

describe("reply usage state handoff", () => {
  it("derives cache-inclusive totals for Claude CLI turn and final-call usage", () => {
    const snapshot = buildReplyUsageState({
      config: {},
      provider: "claude-cli",
      model: "claude-sonnet-5",
      agentId: "main",
      sessionId: "session",
      usage: { input: 4, output: 87, cacheRead: 14_393, cacheWrite: 22_829 },
      usageIsContextSnapshot: false,
      lastCallUsage: { input: 2, output: 6, cacheRead: 9_914, cacheWrite: 17_394 },
    });

    expect(snapshot.usage?.total).toBe(37_313);
    expect(snapshot.lastUsage?.total).toBe(27_316);
    expect(snapshot.contextUsedTokens).toBe(27_310);
  });

  it("does not use aggregate Claude CLI usage as a missing context snapshot", () => {
    const snapshot = buildReplyUsageState({
      config: {},
      provider: "claude-cli",
      model: "claude-sonnet-5",
      agentId: "main",
      sessionId: "session",
      usage: { input: 4, output: 87, cacheRead: 14_393, cacheWrite: 22_829 },
      usageIsContextSnapshot: false,
    });

    expect(snapshot.usage?.total).toBe(37_313);
    expect(snapshot.contextUsedTokens).toBeUndefined();
  });

  it("requires exact run correlation", () => {
    const snapshot = { provider: "openai", model: "gpt-5.5" };

    recordReplyUsageState("run-a", snapshot);

    expect(consumeReplyUsageState()).toBeUndefined();
    expect(consumeReplyUsageState("run-b")).toBeUndefined();
    expect(consumeReplyUsageState("run-a")).toBe(snapshot);
  });

  it("ignores snapshots without a run id", () => {
    recordReplyUsageState(undefined, { provider: "openai" });

    expect(consumeReplyUsageState()).toBeUndefined();
  });

  it("expires snapshots", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    recordReplyUsageState("run-a", { provider: "openai" });

    vi.setSystemTime(5 * 60_000 + 1);

    expect(consumeReplyUsageState("run-a")).toBeUndefined();
  });
});
