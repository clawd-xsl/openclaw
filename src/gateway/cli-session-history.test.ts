import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  augmentChatHistoryWithCliSessionImports,
  mergeImportedChatHistoryMessages,
  readClaudeCliSessionMessages,
  resolveClaudeCliSessionFilePath,
} from "./cli-session-history.js";

const ORIGINAL_HOME = process.env.HOME;

function createClaudeHistoryLines(sessionId: string) {
  return [
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-03-26T16:29:54.722Z",
      sessionId,
      content: "[Thu 2026-03-26 16:29 GMT] Reply with exactly: AGENT CLI OK.",
    }),
    JSON.stringify({
      type: "user",
      uuid: "user-1",
      timestamp: "2026-03-26T16:29:54.800Z",
      message: {
        role: "user",
        content:
          'Sender (untrusted metadata):\n```json\n{"label":"openclaw-control-ui"}\n```\n\n[Thu 2026-03-26 16:29 GMT] hi',
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "assistant-1",
      timestamp: "2026-03-26T16:29:55.500Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "hello from Claude" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cache_read_input_tokens: 22,
        },
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "assistant-2",
      timestamp: "2026-03-26T16:29:56.000Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "tool_use",
            id: "toolu_123",
            name: "Bash",
            input: {
              command: "pwd",
            },
          },
        ],
        stop_reason: "tool_use",
      },
    }),
    JSON.stringify({
      type: "user",
      uuid: "user-2",
      timestamp: "2026-03-26T16:29:56.400Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_123",
            content: "/tmp/demo",
          },
        ],
      },
    }),
    JSON.stringify({
      type: "last-prompt",
      sessionId,
      lastPrompt: "ignored",
    }),
  ].join("\n");
}

async function withClaudeProjectsDir<T>(
  run: (params: { homeDir: string; sessionId: string; filePath: string }) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-history-"));
  const homeDir = path.join(root, "home");
  const sessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
  const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
  const filePath = path.join(projectsDir, `${sessionId}.jsonl`);
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.writeFile(filePath, createClaudeHistoryLines(sessionId), "utf-8");
  process.env.HOME = homeDir;
  try {
    return await run({ homeDir, sessionId, filePath });
  } finally {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("cli session history", () => {
  afterEach(() => {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
  });

  it("reads claude-cli session messages from the Claude projects store", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      expect(resolveClaudeCliSessionFilePath({ cliSessionId: sessionId, homeDir })).toBe(filePath);
      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({
        role: "user",
        content: expect.stringContaining("[Thu 2026-03-26 16:29 GMT] hi"),
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "user-1",
          cliSessionId: sessionId,
        },
      });
      expect(messages[1]).toMatchObject({
        role: "assistant",
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
        stopReason: "end_turn",
        usage: {
          input: 11,
          output: 7,
          cacheRead: 22,
        },
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "assistant-1",
          cliSessionId: sessionId,
        },
      });
      expect(messages[2]).toMatchObject({
        role: "assistant",
        content: [
          {
            type: "toolcall",
            id: "toolu_123",
            name: "Bash",
            arguments: {
              command: "pwd",
            },
          },
          {
            type: "tool_result",
            name: "Bash",
            content: "/tmp/demo",
            tool_use_id: "toolu_123",
          },
        ],
      });
    });
  });

  it("deduplicates imported messages against similar local transcript entries", () => {
    const localMessages = [
      {
        role: "user",
        content: "hi",
        timestamp: Date.parse("2026-03-26T16:29:54.900Z"),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello from Claude" }],
        timestamp: Date.parse("2026-03-26T16:29:55.700Z"),
      },
    ];
    const importedMessages = [
      {
        role: "user",
        content:
          'Sender (untrusted metadata):\n```json\n{"label":"openclaw-control-ui"}\n```\n\n[Thu 2026-03-26 16:29 GMT] hi',
        timestamp: Date.parse("2026-03-26T16:29:54.800Z"),
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "user-1",
          cliSessionId: "session-1",
        },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello from Claude" }],
        timestamp: Date.parse("2026-03-26T16:29:55.500Z"),
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "assistant-1",
          cliSessionId: "session-1",
        },
      },
      {
        role: "user",
        content: "[Thu 2026-03-26 16:31 GMT] follow-up",
        timestamp: Date.parse("2026-03-26T16:31:00.000Z"),
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "user-2",
          cliSessionId: "session-1",
        },
      },
    ];

    const merged = mergeImportedChatHistoryMessages({ localMessages, importedMessages });
    expect(merged).toHaveLength(3);
    expect(merged[2]).toMatchObject({
      role: "user",
      __openclaw: {
        importedFrom: "claude-cli",
        externalId: "user-2",
      },
    });
  });

  it("deduplicates imported assistant messages after stripping display-only directive tags", () => {
    const timestamp = Date.parse("2026-03-26T16:29:55.500Z");
    const localMessages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "hello from Claude" }],
        timestamp,
      },
    ];
    const importedMessages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "[[reply_to_current]] hello from Claude [[audio_as_voice]]" },
        ],
        timestamp,
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "assistant-1",
          cliSessionId: "session-1",
        },
      },
    ];

    const merged = mergeImportedChatHistoryMessages({ localMessages, importedMessages });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(localMessages[0]);
  });

  it("augments chat history when a session has a claude-cli binding", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
          cliSessionBindings: {
            "claude-cli": {
              sessionId,
            },
          },
        },
        provider: "claude-cli",
        localMessages: [],
        homeDir,
      });
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({
        role: "user",
        __openclaw: { cliSessionId: sessionId },
      });
    });
  });

  it("augments chat history when a session uses claude-cli-streaming", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
          cliSessionBindings: {
            "claude-cli-streaming": {
              sessionId,
            },
          },
        },
        provider: "claude-cli-streaming",
        localMessages: [],
        homeDir,
      });
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({
        role: "user",
        __openclaw: { cliSessionId: sessionId },
      });
    });
  });

  it("prefers the active streaming binding when both Claude family bindings exist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-history-dual-"));
    const homeDir = path.join(root, "home");
    const legacySessionId = "11111111-1111-4111-8111-111111111111";
    const streamingSessionId = "22222222-2222-4222-8222-222222222222";
    const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.writeFile(
      path.join(projectsDir, `${legacySessionId}.jsonl`),
      createClaudeHistoryLines(legacySessionId),
      "utf-8",
    );
    await fs.writeFile(
      path.join(projectsDir, `${streamingSessionId}.jsonl`),
      createClaudeHistoryLines(streamingSessionId),
      "utf-8",
    );
    process.env.HOME = homeDir;
    try {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
          cliSessionBindings: {
            "claude-cli": {
              sessionId: legacySessionId,
            },
            "claude-cli-streaming": {
              sessionId: streamingSessionId,
            },
          },
        },
        provider: "claude-cli-streaming",
        localMessages: [],
        homeDir,
      });
      expect(messages[0]).toMatchObject({
        role: "user",
        __openclaw: { cliSessionId: streamingSessionId },
      });
    } finally {
      if (ORIGINAL_HOME === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = ORIGINAL_HOME;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to legacy cliSessionIds when bindings are absent", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
          cliSessionIds: {
            "claude-cli": sessionId,
          },
        },
        provider: "claude-cli",
        localMessages: [],
        homeDir,
      });
      expect(messages).toHaveLength(3);
      expect(messages[1]).toMatchObject({
        role: "assistant",
        __openclaw: { cliSessionId: sessionId },
      });
    });
  });

  it("falls back to legacy claudeCliSessionId when newer fields are absent", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
          claudeCliSessionId: sessionId,
        },
        provider: "claude-cli",
        localMessages: [],
        homeDir,
      });
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({
        role: "user",
        __openclaw: { cliSessionId: sessionId },
      });
    });
  });
});
