import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { ensureSessionSummariesSchema } from "../../sessions/session-summary-schema.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

import { createSessionSummariesTool } from "./session-summaries-tool.js";

type DatabaseSync = InstanceType<typeof import("node:sqlite").DatabaseSync>;

let tempDir = "";
let sqlitePath = "";
let db: DatabaseSync;

function makeConfig(visibility: "self" | "tree" | "agent" | "all"): OpenClawConfig {
  return {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
    tools: {
      sessions: {
        visibility,
      },
      agentToAgent: {
        enabled: false,
      },
    },
    agents: {
      session: {
        summaryDays: 7,
      },
      defaults: {
        memorySearch: {
          store: {
            path: sqlitePath,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function insertSummary(params: {
  sessionId: string;
  sessionKey: string;
  summary: string;
  agentId?: string;
}) {
  const now = Date.now();
  db.prepare(`
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
  `).run(
    params.sessionId,
    null,
    params.sessionKey,
    params.agentId ?? "main",
    now - 5_000,
    now - 1_000,
    8,
    params.summary,
    "openai/gpt-5.4",
    "anthropic/claude-sonnet-4-6",
    now,
  );
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-summaries-tool-"));
  sqlitePath = path.join(tempDir, "memory.sqlite");
  const { DatabaseSync } = requireNodeSqlite();
  db = new DatabaseSync(sqlitePath);
  ensureSessionSummariesSchema(db);
  callGatewayMock.mockReset().mockRejectedValue(new Error("gateway unavailable"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("createSessionSummariesTool", () => {
  it("defaults to the current agent main session", async () => {
    insertSummary({
      sessionId: "main-session",
      sessionKey: "agent:main:main",
      summary: "alpha beta",
    });
    insertSummary({
      sessionId: "other-session",
      sessionKey: "agent:main:secondary",
      summary: "alpha beta",
    });

    const tool = createSessionSummariesTool({
      agentSessionKey: "agent:main:main",
      config: makeConfig("agent"),
    });
    const result = await tool.execute("call-1", { query: "alpha beta" });

    expect(result.details).toMatchObject({
      count: 1,
      filters: {
        sessionKey: "agent:main:main",
      },
    });
    const details = result.details as { summaries: Array<{ sessionId: string }> };
    expect(details.summaries.map((summary) => summary.sessionId)).toEqual(["main-session"]);
  });

  it("supports wildcard queries for agent-wide visibility", async () => {
    insertSummary({
      sessionId: "main-session",
      sessionKey: "agent:main:main",
      summary: "alpha",
    });
    insertSummary({
      sessionId: "other-session",
      sessionKey: "agent:main:secondary",
      summary: "beta",
    });

    const tool = createSessionSummariesTool({
      agentSessionKey: "agent:main:main",
      config: makeConfig("agent"),
    });
    const result = await tool.execute("call-2", { sessionKey: "*", limit: 10 });

    expect(result.details).toMatchObject({ count: 2 });
  });

  it("rejects wildcard queries from sandboxed child sessions", async () => {
    const tool = createSessionSummariesTool({
      agentSessionKey: "agent:main:subagent:worker",
      sandboxed: true,
      config: makeConfig("agent"),
    });

    await expect(tool.execute("call-3", { sessionKey: "*" })).rejects.toThrow(
      "Wildcard session summary queries require agent-wide session visibility.",
    );
  });
});
