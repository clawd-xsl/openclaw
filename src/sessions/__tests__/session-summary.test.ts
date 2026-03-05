import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractFullTranscript,
  sliceMessages,
  type TranscriptMessage,
} from "../session-summary.js";
import { ensureSessionSummariesSchema } from "../session-summary-schema.js";
import { buildSessionHistorySection } from "../session-summary-loader.js";
import type { SessionSummaryRecord } from "../session-summary.js";

function writeTempJsonl(lines: unknown[]): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-test-"));
  const filePath = path.join(tmpDir, "test.jsonl");
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"));
  return filePath;
}

function makeMsg(role: string, content: unknown) {
  return { type: "message", message: { role, content } };
}

describe("extractFullTranscript", () => {
  it("extracts user and assistant text messages", () => {
    const fp = writeTempJsonl([
      makeMsg("user", "Hello"),
      makeMsg("assistant", "Hi there!"),
      makeMsg("user", "How are you?"),
    ]);
    const r = extractFullTranscript(fp);
    expect(r.messageCount).toBe(3);
    expect(r.messages).toHaveLength(3);
    expect(r.messages[0]).toMatchObject({ role: "user", text: "Hello" });
    expect(r.messages[1]).toMatchObject({ role: "assistant", text: "Hi there!" });
    expect(r.messages[2]).toMatchObject({ role: "user", text: "How are you?" });
  });

  it("filters out tool-only messages", () => {
    const fp = writeTempJsonl([
      makeMsg("user", "Do something"),
      makeMsg("assistant", [
        { type: "tool_use", id: "t1", name: "exec", input: { command: "ls" } },
      ]),
      makeMsg("user", [
        { type: "tool_result", tool_use_id: "t1", content: "file1.txt" },
      ]),
      makeMsg("assistant", "Done!"),
    ]);
    const r = extractFullTranscript(fp);
    expect(r.messageCount).toBe(2);
    expect(r.messages[0]).toMatchObject({ role: "user", text: "Do something" });
    expect(r.messages[1]).toMatchObject({ role: "assistant", text: "Done!" });
  });

  it("keeps mixed messages but extracts only text blocks", () => {
    const fp = writeTempJsonl([
      makeMsg("assistant", [
        { type: "text", text: "Let me check that." },
        { type: "tool_use", id: "t1", name: "read", input: {} },
      ]),
    ]);
    const r = extractFullTranscript(fp);
    expect(r.messageCount).toBe(1);
    expect(r.messages[0].text).toBe("Let me check that.");
  });

  it("skips compaction entries", () => {
    const fp = writeTempJsonl([
      { type: "compaction", summary: "Previous conversation about X" },
      makeMsg("user", "Continue"),
      makeMsg("assistant", "OK"),
    ]);
    const r = extractFullTranscript(fp);
    expect(r.messageCount).toBe(2);
  });

  it("extracts session metadata", () => {
    const fp = writeTempJsonl([
      { type: "session", createdAt: 1700000000000 },
      makeMsg("user", "Hi"),
    ]);
    const r = extractFullTranscript(fp);
    expect(r.sessionMeta?.createdAt).toBe(1700000000000);
  });

  it("returns empty for nonexistent file", () => {
    const r = extractFullTranscript("/nonexistent/path.jsonl");
    expect(r.messages).toHaveLength(0);
    expect(r.messageCount).toBe(0);
  });

  it("handles empty file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-test-"));
    const fp = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(fp, "");
    const r = extractFullTranscript(fp);
    expect(r.messages).toHaveLength(0);
  });

  it("handles malformed JSONL lines gracefully", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-test-"));
    const fp = path.join(tmpDir, "bad.jsonl");
    fs.writeFileSync(
      fp,
      [
        "not json",
        JSON.stringify(makeMsg("user", "Valid")),
        "{broken",
        JSON.stringify(makeMsg("assistant", "Also valid")),
      ].join("\n"),
    );
    const r = extractFullTranscript(fp);
    expect(r.messageCount).toBe(2);
  });

  it("truncates long messages", () => {
    const longText = "x".repeat(5000);
    const fp = writeTempJsonl([makeMsg("user", longText)]);
    const r = extractFullTranscript(fp);
    expect(r.messages[0].text.length).toBeLessThan(5000);
    expect(r.messages[0].text).toContain("...[truncated]");
  });

  it("skips messages with empty/whitespace text", () => {
    const fp = writeTempJsonl([
      makeMsg("user", ""),
      makeMsg("assistant", "   "),
      makeMsg("user", "Real message"),
    ]);
    const r = extractFullTranscript(fp);
    expect(r.messageCount).toBe(1);
    expect(r.messages[0].text).toBe("Real message");
  });

  it("skips non-user/assistant roles", () => {
    const fp = writeTempJsonl([
      makeMsg("system", "You are helpful"),
      makeMsg("user", "Hi"),
      makeMsg("tool", "result"),
    ]);
    const r = extractFullTranscript(fp);
    expect(r.messageCount).toBe(1);
  });

  it("calculates totalChars correctly", () => {
    const fp = writeTempJsonl([
      makeMsg("user", "abc"),
      makeMsg("assistant", "defgh"),
    ]);
    const r = extractFullTranscript(fp);
    expect(r.totalChars).toBe(8);
  });

  it("handles content as array of text blocks", () => {
    const fp = writeTempJsonl([
      makeMsg("user", [
        { type: "text", text: "Part 1" },
        { type: "text", text: "Part 2" },
      ]),
    ]);
    const r = extractFullTranscript(fp);
    expect(r.messages[0].text).toBe("Part 1\nPart 2");
  });
});

describe("sliceMessages", () => {
  function mk(text: string, index: number): TranscriptMessage {
    return { role: "user", text, index };
  }

  it("returns empty array for empty input", () => {
    expect(sliceMessages([])).toEqual([]);
  });

  it("returns single slice when under limit", () => {
    const msgs = [mk("hello", 0), mk("world", 1)];
    const slices = sliceMessages(msgs, 1000);
    expect(slices).toHaveLength(1);
    expect(slices[0]).toHaveLength(2);
  });

  it("splits into multiple slices", () => {
    const msgs = [
      mk("a".repeat(100), 0),
      mk("b".repeat(100), 1),
      mk("c".repeat(100), 2),
    ];
    const slices = sliceMessages(msgs, 150);
    expect(slices).toHaveLength(3);
  });

  it("groups messages that fit together", () => {
    const msgs = [
      mk("a".repeat(50), 0),
      mk("b".repeat(50), 1),
      mk("c".repeat(50), 2),
      mk("d".repeat(50), 3),
    ];
    const slices = sliceMessages(msgs, 120);
    expect(slices).toHaveLength(2);
    expect(slices[0]).toHaveLength(2);
    expect(slices[1]).toHaveLength(2);
  });

  it("handles single message exceeding limit", () => {
    const msgs = [mk("x".repeat(500), 0)];
    const slices = sliceMessages(msgs, 100);
    expect(slices).toHaveLength(1);
    expect(slices[0]).toHaveLength(1);
  });

  it("oversized message followed by normal ones", () => {
    const msgs = [
      mk("x".repeat(500), 0),
      mk("y".repeat(50), 1),
      mk("z".repeat(50), 2),
    ];
    const slices = sliceMessages(msgs, 200);
    expect(slices).toHaveLength(2);
    expect(slices[0]).toHaveLength(1);
    expect(slices[1]).toHaveLength(2);
  });

  it("preserves message order across slices", () => {
    const msgs = [mk("a", 0), mk("b", 1), mk("c", 2), mk("d", 3)];
    const slices = sliceMessages(msgs, 3);
    const flat = slices.flat();
    expect(flat.map((m) => m.text)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("ensureSessionSummariesSchema", () => {
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-schema-test-"));
    dbPath = path.join(tmpDir, "test.sqlite");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates table and is idempotent", async () => {
    let DatabaseSync: new (path: string) => any;
    try {
      const mod = await import("node:sqlite");
      DatabaseSync = (mod as any).DatabaseSync;
    } catch {
      // node:sqlite not available, skip
      return;
    }

    const db = new DatabaseSync(dbPath);
    ensureSessionSummariesSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries'")
      .all();
    expect(tables).toHaveLength(1);

    // Idempotent
    ensureSessionSummariesSchema(db);

    const cols = db.prepare("PRAGMA table_info(session_summaries)").all() as Array<{ name: string }>;
    const colNames = cols.map((c: any) => c.name);
    expect(colNames).toContain("session_id");
    expect(colNames).toContain("summary_model");
    expect(colNames).toContain("summary");
    expect(colNames).toContain("model");
    expect(colNames).toContain("message_count");

    db.close();
  });
});

describe("buildSessionHistorySection", () => {
  it("returns empty string for no summaries", () => {
    expect(buildSessionHistorySection([])).toBe("");
  });

  it("formats summaries correctly", () => {
    const summaries = [
      {
        session_id: "12345678-abcd-1234-5678-abcdef123456",
        previous_session_id: null,
        session_key: "agent:main:main",
        agent_id: "main",
        created_at: 1700000000000,
        ended_at: 1700003600000,
        message_count: 25,
        summary: "Discussed project architecture.",
        model: "anthropic/claude-sonnet-4-6",
        generated_at: 1700003700000,
        summary_model: "anthropic/claude-sonnet-4-6",
      },
    ] as SessionSummaryRecord[];
    const result = buildSessionHistorySection(summaries);
    expect(result).toContain("## Recent Session History");
    expect(result).toContain("12345678");
    expect(result).toContain("Discussed project architecture.");
  });
});
