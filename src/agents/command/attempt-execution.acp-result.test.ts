// Covers canonical terminal metadata emitted by ACP attempts.
import { describe, expect, it } from "vitest";
import { buildAcpResult } from "./attempt-execution.js";

describe("buildAcpResult", () => {
  it("publishes run-owned terminal reply text", () => {
    const result = buildAcpResult({
      payloadText: "visible ACP reply",
      rawPayloadText: " visible ACP reply\n",
      startedAt: Date.now(),
      stopReason: "end_turn",
    });

    expect(result.payloads).toEqual([{ text: "visible ACP reply" }]);
    expect(result.meta).toMatchObject({
      finalAssistantVisibleText: "visible ACP reply",
      finalAssistantRawText: "visible ACP reply",
      stopReason: "end_turn",
    });
  });

  it("publishes a silent ACP terminal token without creating a payload", () => {
    const result = buildAcpResult({
      payloadText: "NO_REPLY",
      startedAt: Date.now(),
    });

    expect(result.payloads).toEqual([]);
    expect(result.meta.finalAssistantVisibleText).toBeUndefined();
    expect(result.meta.finalAssistantRawText).toBe("NO_REPLY");
  });
});
