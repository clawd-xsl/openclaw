import { describe, expect, it } from "vitest";
import { resolveCliMemoryFlushGate } from "./memory-flush.js";

const basePosition = {
  fingerprint: "runtime-a",
  promptTokens: 176_000,
  transcriptBytes: 2_000_000,
};

describe("resolveCliMemoryFlushGate", () => {
  it("runs the first due CLI pressure flush", () => {
    expect(
      resolveCliMemoryFlushGate({
        entry: {},
        position: basePosition,
        tokenPressureDue: true,
        transcriptPressureDue: false,
        repeatAfterTokens: 20_000,
        repeatAfterTranscriptBytes: 2_097_152,
      }),
    ).toEqual({ kind: "run", reason: "first", resetFailureBudget: false });
  });

  it("waits at the same receipt and reruns after configured token growth", () => {
    const entry = {
      memoryFlushCliFingerprint: "runtime-a",
      memoryFlushCliPromptTokens: 176_000,
      memoryFlushCliTranscriptBytes: 2_000_000,
    };
    expect(
      resolveCliMemoryFlushGate({
        entry,
        position: { ...basePosition, promptTokens: 195_999 },
        tokenPressureDue: true,
        transcriptPressureDue: false,
        repeatAfterTokens: 20_000,
        repeatAfterTranscriptBytes: 2_097_152,
      }),
    ).toEqual({ kind: "wait" });
    expect(
      resolveCliMemoryFlushGate({
        entry,
        position: { ...basePosition, promptTokens: 196_000 },
        tokenPressureDue: true,
        transcriptPressureDue: false,
        repeatAfterTokens: 20_000,
        repeatAfterTranscriptBytes: 2_097_152,
      }),
    ).toEqual({ kind: "run", reason: "tokens", resetFailureBudget: true });
  });

  it("reruns after configured transcript growth and honors zero as disabled", () => {
    const entry = {
      memoryFlushCliFingerprint: "runtime-a",
      memoryFlushCliPromptTokens: 176_000,
      memoryFlushCliTranscriptBytes: 2_000_000,
    };
    const position = {
      ...basePosition,
      promptTokens: 220_000,
      transcriptBytes: 4_097_152,
    };
    expect(
      resolveCliMemoryFlushGate({
        entry,
        position,
        tokenPressureDue: false,
        transcriptPressureDue: true,
        repeatAfterTokens: 0,
        repeatAfterTranscriptBytes: 2_097_152,
      }),
    ).toEqual({ kind: "run", reason: "bytes", resetFailureBudget: true });
    expect(
      resolveCliMemoryFlushGate({
        entry,
        position,
        tokenPressureDue: true,
        transcriptPressureDue: true,
        repeatAfterTokens: 0,
        repeatAfterTranscriptBytes: 0,
      }),
    ).toEqual({ kind: "wait" });
  });

  it.each([
    {
      label: "native token reset",
      entry: {
        memoryFlushCliFingerprint: "runtime-a",
        memoryFlushCliPromptTokens: 176_000,
      },
      position: { ...basePosition, promptTokens: 160_000 },
      reason: "token_reset",
    },
    {
      label: "runtime fingerprint change",
      entry: { memoryFlushCliFingerprint: "runtime-a" },
      position: { ...basePosition, fingerprint: "runtime-b" },
      reason: "fingerprint_changed",
    },
    {
      label: "transcript rotation",
      entry: {
        memoryFlushCliFingerprint: "runtime-a",
        memoryFlushCliTranscriptBytes: 3_000_000,
      },
      position: { ...basePosition, transcriptBytes: 100_000 },
      reason: "file_shrank",
    },
  ])("re-arms after $label", ({ entry, position, reason }) => {
    expect(
      resolveCliMemoryFlushGate({
        entry,
        position,
        tokenPressureDue: false,
        transcriptPressureDue: false,
        repeatAfterTokens: 20_000,
        repeatAfterTranscriptBytes: 2_097_152,
      }),
    ).toEqual({ kind: "rearm", reason, receipt: position });
    expect(
      resolveCliMemoryFlushGate({
        entry,
        position,
        tokenPressureDue: true,
        transcriptPressureDue: true,
        repeatAfterTokens: 20_000,
        repeatAfterTranscriptBytes: 2_097_152,
      }),
    ).toEqual({ kind: "rearm", reason, receipt: position });
  });

  it("does not re-arm for small token accounting jitter", () => {
    expect(
      resolveCliMemoryFlushGate({
        entry: {
          memoryFlushCliFingerprint: "runtime-a",
          memoryFlushCliPromptTokens: 176_000,
          memoryFlushCliTranscriptBytes: 2_000_000,
        },
        position: { ...basePosition, promptTokens: 175_000 },
        tokenPressureDue: true,
        transcriptPressureDue: true,
        repeatAfterTokens: 20_000,
        repeatAfterTranscriptBytes: 2_097_152,
      }),
    ).toEqual({ kind: "wait" });
  });

  it("re-arms a native compaction before starting the next pressure cycle", () => {
    const rearmed = resolveCliMemoryFlushGate({
      entry: {
        memoryFlushCliFingerprint: "runtime-a",
        memoryFlushCliPromptTokens: 176_000,
      },
      position: { ...basePosition, promptTokens: 160_000 },
      tokenPressureDue: false,
      transcriptPressureDue: false,
      repeatAfterTokens: 20_000,
      repeatAfterTranscriptBytes: 2_097_152,
    });
    expect(rearmed).toEqual({
      kind: "rearm",
      reason: "token_reset",
      receipt: { ...basePosition, promptTokens: 160_000 },
    });

    expect(
      resolveCliMemoryFlushGate({
        entry: {
          memoryFlushCliFingerprint: "runtime-a",
          memoryFlushCliPromptTokens: 160_000,
          memoryFlushCliTranscriptBytes: 2_000_000,
        },
        position: { ...basePosition, promptTokens: 180_000 },
        tokenPressureDue: true,
        transcriptPressureDue: false,
        repeatAfterTokens: 20_000,
        repeatAfterTranscriptBytes: 2_097_152,
      }),
    ).toEqual({ kind: "run", reason: "tokens", resetFailureBudget: true });
  });

  it("adopts a post-compaction baseline even while the old transcript exceeds its force threshold", () => {
    const receipt = {
      memoryFlushCliFingerprint: "runtime-a",
      memoryFlushCliPromptTokens: 176_000,
      memoryFlushCliTranscriptBytes: 3_000_000,
    };
    const position = {
      fingerprint: "runtime-a",
      promptTokens: 20_000,
      transcriptBytes: 3_000_000,
    };
    const rearmed = resolveCliMemoryFlushGate({
      entry: receipt,
      position,
      tokenPressureDue: false,
      transcriptPressureDue: true,
      repeatAfterTokens: 20_000,
      repeatAfterTranscriptBytes: 2_097_152,
    });
    expect(rearmed).toEqual({ kind: "rearm", reason: "token_reset", receipt: position });

    expect(
      resolveCliMemoryFlushGate({
        entry: {
          memoryFlushCliFingerprint: position.fingerprint,
          memoryFlushCliPromptTokens: position.promptTokens,
          memoryFlushCliTranscriptBytes: position.transcriptBytes,
        },
        position,
        tokenPressureDue: false,
        transcriptPressureDue: true,
        repeatAfterTokens: 20_000,
        repeatAfterTranscriptBytes: 2_097_152,
      }),
    ).toEqual({ kind: "wait" });
  });

  it("detects a native token reset when upward token repeats are disabled", () => {
    expect(
      resolveCliMemoryFlushGate({
        entry: {
          memoryFlushCliFingerprint: "runtime-a",
          memoryFlushCliPromptTokens: 176_000,
        },
        position: { ...basePosition, promptTokens: 20_000 },
        tokenPressureDue: false,
        transcriptPressureDue: false,
        repeatAfterTokens: 0,
        repeatAfterTranscriptBytes: 2_097_152,
      }),
    ).toEqual({
      kind: "rearm",
      reason: "token_reset",
      receipt: { ...basePosition, promptTokens: 20_000 },
    });
  });

  it("adopts a fingerprint for a migrated token-only receipt", () => {
    expect(
      resolveCliMemoryFlushGate({
        entry: { memoryFlushCliPromptTokens: 176_000 },
        position: basePosition,
        tokenPressureDue: true,
        transcriptPressureDue: false,
        repeatAfterTokens: 20_000,
        repeatAfterTranscriptBytes: 2_097_152,
      }),
    ).toEqual({
      kind: "adopt_fingerprint",
      receipt: basePosition,
    });
  });

  it("runs when a migrated token-only receipt has grown by the repeat interval", () => {
    expect(
      resolveCliMemoryFlushGate({
        entry: { memoryFlushCliPromptTokens: 176_000 },
        position: { ...basePosition, promptTokens: 196_000 },
        tokenPressureDue: true,
        transcriptPressureDue: false,
        repeatAfterTokens: 20_000,
        repeatAfterTranscriptBytes: 2_097_152,
      }),
    ).toEqual({ kind: "run", reason: "tokens", resetFailureBudget: true });
  });

  it("seeds the transcript baseline when adopting a migrated token receipt", () => {
    expect(
      resolveCliMemoryFlushGate({
        entry: { memoryFlushCliPromptTokens: 176_000 },
        position: { ...basePosition, promptTokens: 180_000, transcriptBytes: 7_000_000 },
        tokenPressureDue: true,
        transcriptPressureDue: true,
        repeatAfterTokens: 20_000,
        repeatAfterTranscriptBytes: 2_097_152,
      }),
    ).toEqual({
      kind: "adopt_fingerprint",
      receipt: {
        fingerprint: "runtime-a",
        promptTokens: 176_000,
        transcriptBytes: 7_000_000,
      },
    });
  });

  it("fills a missing receipt dimension even when the fingerprint is already present", () => {
    expect(
      resolveCliMemoryFlushGate({
        entry: {
          memoryFlushCliFingerprint: "runtime-a",
          memoryFlushCliPromptTokens: 176_000,
        },
        position: { ...basePosition, transcriptBytes: 7_000_000 },
        tokenPressureDue: false,
        transcriptPressureDue: true,
        repeatAfterTokens: 20_000,
        repeatAfterTranscriptBytes: 2_097_152,
      }),
    ).toEqual({
      kind: "adopt_fingerprint",
      receipt: {
        fingerprint: "runtime-a",
        promptTokens: 176_000,
        transcriptBytes: 7_000_000,
      },
    });
  });
});
