import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resolveSessionTranscriptPathMock,
  runCliAgentMock,
  runEmbeddedPiAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — CLI transcript persistence", () => {
  setupRunCronIsolatedAgentTurnSuite();

  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("persists isolated CLI turns to the session transcript file", async () => {
    const hookMessage = "persist this CLI hook transcript";
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-cli-transcript-"));
    const sessionFile = path.join(tempDir, "hook-session.jsonl");
    resolveSessionTranscriptPathMock.mockReturnValue(sessionFile);
    isCliProviderMock.mockReturnValue(true);
    mockRunCronFallbackPassthrough();
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "CLI transcript reply" }],
      meta: {
        finalAssistantVisibleText: "CLI transcript reply",
        stopReason: "stop",
        agentMeta: {
          sessionId: "cli-session-id",
          provider: "claude-cli-streaming",
          model: "claude-opus-4-6",
          usage: {
            input: 10,
            output: 20,
            cacheRead: 30,
            cacheWrite: 40,
            total: 100,
          },
        },
      },
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          payload: {
            kind: "agentTurn",
            message: hookMessage,
          },
        }),
        message: hookMessage,
      }),
    );

    expect(result.status).toBe("ok");
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();

    const raw = await fs.readFile(sessionFile, "utf-8");
    const entries = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; message?: Record<string, unknown> });
    expect(entries[0]?.type).toBe("session");

    const messages = entries.filter((entry) => entry.type === "message");
    expect(messages).toHaveLength(2);
    expect(messages[0]?.message?.role).toBe("user");
    expect(messages[0]?.message?.content).toEqual(expect.stringContaining(hookMessage));
    expect(messages[1]?.message?.role).toBe("assistant");
    expect(messages[1]?.message?.content).toEqual([{ type: "text", text: "CLI transcript reply" }]);
  });
});
