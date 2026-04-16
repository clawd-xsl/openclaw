import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { ensureSessionSummariesSchema } from "./session-summary-schema.js";
import {
  extractFullTranscript,
  resolveSessionSummaryDbPath,
  sliceMessages,
  type TranscriptMessage,
} from "./session-summary.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeTempJsonl(lines: unknown[]): string {
  const dir = makeTempDir("session-summary-test-");
  const filePath = path.join(dir, "session.jsonl");
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join("\n"));
  return filePath;
}

function makeMessage(role: string, content: unknown) {
  return { type: "message", message: { role, content } };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveSessionSummaryDbPath", () => {
  it("uses agent-specific memorySearch store paths when configured", () => {
    const homeDir = makeTempDir("session-summary-home-");
    vi.stubEnv("HOME", homeDir);
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            store: {
              path: "~/memory/{agentId}.sqlite",
            },
          },
        },
        list: [
          {
            id: "worker",
            memorySearch: {
              store: {
                path: "~/custom/{agentId}.sqlite",
              },
            },
          },
        ],
      },
    } as OpenClawConfig;

    expect(resolveSessionSummaryDbPath("main", config)).toBe(
      path.join(homeDir, "memory", "main.sqlite"),
    );
    expect(resolveSessionSummaryDbPath("worker", config)).toBe(
      path.join(homeDir, "custom", "worker.sqlite"),
    );
  });
});

describe("extractFullTranscript", () => {
  it("keeps user and assistant text while dropping tool-only content", () => {
    const filePath = writeTempJsonl([
      { type: "compaction", summary: "older summary" },
      makeMessage("user", "Hello"),
      makeMessage("assistant", [
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "tool-1", name: "read", input: {} },
      ]),
      makeMessage("assistant", [{ type: "tool_result", tool_use_id: "tool-1", content: "data" }]),
      makeMessage("assistant", "Done."),
    ]);

    const result = extractFullTranscript(filePath);
    expect(result.messageCount).toBe(3);
    expect(result.messages.map((message) => message.text)).toEqual(["Hello", "Checking.", "Done."]);
  });

  it("truncates long message bodies", () => {
    const filePath = writeTempJsonl([makeMessage("user", "x".repeat(5_000))]);
    const result = extractFullTranscript(filePath);

    expect(result.messages[0]?.text.length).toBeLessThan(5_000);
    expect(result.messages[0]?.text).toContain("...[truncated]");
  });
});

describe("sliceMessages", () => {
  it("preserves message order while chunking by character budget", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", text: "a".repeat(80), index: 0 },
      { role: "assistant", text: "b".repeat(80), index: 1 },
      { role: "user", text: "c".repeat(80), index: 2 },
    ];

    const slices = sliceMessages(messages, 120);
    expect(slices).toHaveLength(3);
    expect(slices.flat().map((message) => message.index)).toEqual([0, 1, 2]);
  });
});

describe("ensureSessionSummariesSchema", () => {
  it("creates the table with the expected columns", () => {
    const sqlitePath = path.join(makeTempDir("session-summary-sqlite-"), "summary.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(sqlitePath);

    ensureSessionSummariesSchema(db);
    ensureSessionSummariesSchema(db);

    const columns = db.prepare("PRAGMA table_info(session_summaries)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["session_id", "agent_id", "summary_model", "summary"]),
    );

    db.close();
  });
});
