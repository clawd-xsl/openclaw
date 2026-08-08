// Source-reply metadata coverage for exact run-owned agent.wait results.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  makeAttemptResult,
  makeCompactionSuccess,
  makeOverflowError,
} from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedCompactDirect,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

function assistantWithText(text: string) {
  return {
    role: "assistant",
    stopReason: "stop",
    provider: "openai",
    model: "gpt-5.5",
    content: [{ type: "text", text }],
    usage: { input: 100, output: 2, totalTokens: 102 },
  } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
}

describe("runEmbeddedAgent source-reply metadata", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("publishes the internal-ui mirror instead of the silent model final", async () => {
    const assistant = assistantWithText("NO_REPLY");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["NO_REPLY"],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        didSendViaMessagingTool: true,
        didDeliverSourceReplyViaMessageTool: true,
        messagingToolSourceReplyPayloads: [{ text: "Visible source reply" }],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-source-reply-metadata",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(result.meta.finalAssistantVisibleText).toBe("Visible source reply");
    expect(result.meta.finalAssistantRawText).toBe("NO_REPLY");
  });

  it("publishes the internal-ui mirror when an automatic final is directive-wrapped silence", async () => {
    const assistant = assistantWithText("[[reply_to_current]] [[audio_as_voice]] NO_REPLY");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["[[reply_to_current]] [[audio_as_voice]] NO_REPLY"],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        didSendViaMessagingTool: true,
        didDeliverSourceReplyViaMessageTool: true,
        messagingToolSourceReplyPayloads: [{ text: "Visible source reply" }],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-automatic-directive-silent-source-reply-metadata",
    });

    expect(result.meta.finalAssistantVisibleText).toBe("Visible source reply");
    expect(result.meta.finalAssistantRawText).toBe(
      "[[reply_to_current]] [[audio_as_voice]] NO_REPLY",
    );
  });

  it("preserves a later automatic final answer over an internal-ui mirror", async () => {
    const assistant = assistantWithText("Final answer");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Final answer"],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        didSendViaMessagingTool: true,
        didDeliverSourceReplyViaMessageTool: true,
        messagingToolSourceReplyPayloads: [{ text: "Earlier tool progress" }],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-automatic-source-reply-metadata",
    });

    expect(result.meta.finalAssistantVisibleText).toBe("Final answer");
    expect(result.meta.finalAssistantRawText).toBe("Final answer");
  });

  it("does not publish a prior transcript assistant as the current run result", async () => {
    const priorAssistant = assistantWithText("Prior run answer");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: priorAssistant,
        currentAttemptAssistant: undefined,
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-with-prior-transcript-assistant-only",
      allowEmptyAssistantReplyAsSilent: true,
    });

    expect(result.meta.finalAssistantVisibleText).toBeUndefined();
    expect(result.meta.finalAssistantRawText).toBeUndefined();
  });

  it("clears terminal reply metadata when a retry produces no current assistant", async () => {
    const firstAttemptAssistant = assistantWithText("First attempt text");
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: makeOverflowError(),
          assistantTexts: ["First attempt text"],
          lastAssistant: firstAttemptAssistant,
          currentAttemptAssistant: firstAttemptAssistant,
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          lastAssistant: firstAttemptAssistant,
          currentAttemptAssistant: undefined,
        }),
      );
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({ summary: "Compacted for retry", tokensAfter: 100 }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-retry-without-current-assistant",
      allowEmptyAssistantReplyAsSilent: true,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.meta.finalAssistantVisibleText).toBeUndefined();
    expect(result.meta.finalAssistantRawText).toBeUndefined();
  });
});
