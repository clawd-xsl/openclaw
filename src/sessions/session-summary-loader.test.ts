import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  buildSessionHistorySection,
  loadRecentSummaries,
  querySummaries,
} from "./session-summary-loader.js";
import { ensureSessionSummariesSchema } from "./session-summary-schema.js";

const AGENT_ID = "main";

async function createStateDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-summary-"));
}

function resolveDbPath(stateDir: string): string {
  return path.join(stateDir, "memory", `${AGENT_ID}.sqlite`);
}

function seedSummaries(
  dbPath: string,
  rows: Array<{
    sessionId: string;
    sessionKey: string;
    endedAt: number;
    summary: string;
    messageCount?: number;
  }>,
): void {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);
  ensureSessionSummariesSchema(db);
  try {
    const stmt = db.prepare(`
      INSERT INTO session_summaries (
        session_id,
        previous_session_id,
        session_key,
        agent_id,
        created_at,
        ended_at,
        message_count,
        summary,
        model,
        summary_model,
        generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      stmt.run(
        row.sessionId,
        null,
        row.sessionKey,
        AGENT_ID,
        row.endedAt - 60_000,
        row.endedAt,
        row.messageCount ?? 5,
        row.summary,
        "openai/gpt-5.4",
        "anthropic/claude-sonnet-4-6",
        row.endedAt + 1_000,
      );
    }
  } finally {
    db.close();
  }
}

describe("session summary loader", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await createStateDir();
    await fs.mkdir(path.join(stateDir, "memory"), { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
    stateDir = "";
  });

  it("loads recent summaries and respects configured char caps", () => {
    const now = Date.now();
    seedSummaries(resolveDbPath(stateDir), [
      {
        sessionId: "session-new",
        sessionKey: "agent:main:dm:123",
        endedAt: now - 10_000,
        summary: "Newest summary with enough text",
      },
      {
        sessionId: "session-old",
        sessionKey: "agent:main:dm:123",
        endedAt: now - 20_000,
        summary: "Older summary that should be trimmed by char budget",
      },
      {
        sessionId: "session-other",
        sessionKey: "agent:ops:dm:999",
        endedAt: now - 30_000,
        summary: "Different session key",
      },
    ]);

    const config = {
      agents: {
        session: {
          summaryDays: 7,
          summaryMaxChars: 35,
        },
      },
    } as OpenClawConfig;

    const summaries = loadRecentSummaries({
      sessionKey: "agent:main:dm:123",
      agentId: AGENT_ID,
      config,
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.session_id).toBe("session-new");
  });

  it("queries summaries with wildcard session filters and keyword AND matching", () => {
    const now = Date.now();
    seedSummaries(resolveDbPath(stateDir), [
      {
        sessionId: "session-a",
        sessionKey: "agent:main:dm:123",
        endedAt: now - 10_000,
        summary: "Discussed deploy plan and fix strategy",
      },
      {
        sessionId: "session-b",
        sessionKey: "agent:main:dm:456",
        endedAt: now - 20_000,
        summary: "Discussed deploy plan only",
      },
      {
        sessionId: "session-c",
        sessionKey: "agent:ops:dm:999",
        endedAt: now - 30_000,
        summary: "Discussed fix strategy only",
      },
    ]);

    const results = querySummaries({
      agentId: AGENT_ID,
      sessionKey: "%main%",
      from: now - 86_400_000,
      to: now,
      query: "deploy fix",
    });

    expect(results.map((row) => row.session_id)).toEqual(["session-a"]);
  });

  it("formats summaries into a prompt-ready history section", () => {
    const section = buildSessionHistorySection([
      {
        session_id: "session-12345678",
        previous_session_id: "session-previous",
        session_key: "agent:main:dm:123",
        agent_id: AGENT_ID,
        created_at: Date.UTC(2026, 2, 14, 18, 0, 0),
        ended_at: Date.UTC(2026, 2, 14, 19, 0, 0),
        message_count: 12,
        summary: "Worked through the port plan and identified the next batch.",
        model: "openai/gpt-5.4",
        summary_model: "anthropic/claude-sonnet-4-6",
        generated_at: Date.UTC(2026, 2, 14, 19, 1, 0),
      },
    ]);

    expect(section).toContain("## Recent Session History");
    expect(section).toContain("session: session-12345678");
    expect(section).toContain("messages: 12");
    expect(section).toContain("Worked through the port plan");
  });
});
