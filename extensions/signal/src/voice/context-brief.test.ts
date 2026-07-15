import { describe, expect, it, vi } from "vitest";
import { formatTranscriptForBrief, generateSignalVoiceContextBrief } from "./context-brief.js";

const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "message",
  message: { role, content },
  ...extra,
});

describe("formatTranscriptForBrief", () => {
  it("renders user/assistant turns with string and part-array content", () => {
    const out = formatTranscriptForBrief([
      msg("user", "book me a table"),
      msg("assistant", [
        { type: "text", text: "for when" },
        { type: "text", text: "and where" },
      ]),
    ]);
    expect(out).toBe("User: book me a table\nAssistant: for when and where");
  });

  it("skips non-message events, side appends, and non-user/assistant roles", () => {
    const out = formatTranscriptForBrief([
      { type: "session", id: "x" },
      msg("system", "ignored"),
      msg("assistant", "sidebar", { appendMode: "side" }),
      msg("user", "kept"),
    ]);
    expect(out).toBe("User: kept");
  });

  it("returns empty string for no usable content", () => {
    expect(formatTranscriptForBrief([])).toBe("");
    expect(formatTranscriptForBrief([msg("user", "")])).toBe("");
  });

  it("keeps only the most recent maxMessages messages", () => {
    const events = [msg("user", "one"), msg("assistant", "two"), msg("user", "three")];
    expect(formatTranscriptForBrief(events, { maxMessages: 2 })).toBe(
      "Assistant: two\nUser: three",
    );
  });
});

// A runtime whose model call would throw if reached — proves the disabled path
// short-circuits before any agent/model work on the call-setup hot path.
const explodingRuntime = {
  runEmbeddedAgent: vi.fn(() => {
    throw new Error("model call must not run when contextBrief is disabled");
  }),
} as never;

const baseParams = {
  cfg: {} as never,
  agentRuntime: explodingRuntime,
  route: { agentId: "main", sessionKey: "agent:main:signal:direct:abc" },
  peerAci: "abc-123",
};

describe("generateSignalVoiceContextBrief", () => {
  it("returns undefined and does no work when contextBrief is absent", async () => {
    const result = await generateSignalVoiceContextBrief({
      ...baseParams,
      voiceConfig: {},
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when contextBrief is explicitly disabled", async () => {
    const result = await generateSignalVoiceContextBrief({
      ...baseParams,
      voiceConfig: { contextBrief: { enabled: false } },
    });
    expect(result).toBeUndefined();
  });
});
