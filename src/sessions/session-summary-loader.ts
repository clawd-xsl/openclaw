import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import type { SessionSummaryRecord } from "./session-summary.js";

function resolveMemoryDbPath(agentId: string): string {
  const stateDir = resolveStateDir(process.env, os.homedir);
  return path.join(stateDir, "memory", `${agentId}.sqlite`);
}

/**
 * Load recent session summaries for system prompt injection.
 */
export function loadRecentSummaries(params: {
  sessionKey: string;
  agentId: string;
  days?: number;
  maxChars?: number;
}): SessionSummaryRecord[] {
  const days = params.days ?? 5;
  const dbPath = resolveMemoryDbPath(params.agentId);
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const stmt = db.prepare(`
      SELECT * FROM session_summaries
      WHERE session_key = ? AND agent_id = ? AND ended_at > ?
      ORDER BY ended_at DESC
      LIMIT 20
    `);
    const rows = stmt.all(
      params.sessionKey,
      params.agentId,
      cutoff,
    ) as unknown as SessionSummaryRecord[];

    if (params.maxChars != null) {
      const capped: SessionSummaryRecord[] = [];
      let totalChars = 0;
      for (const row of rows) {
        const len = row.summary.length;
        if (totalChars + len > params.maxChars && capped.length > 0) {
          break;
        }
        capped.push(row);
        totalChars += len;
      }
      return capped;
    }
    return rows;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * Query session summaries by time range (for the tool).
 */
export function querySummaries(params: {
  agentId: string;
  sessionKey?: string;
  from: number;
  to: number;
  limit?: number;
  query?: string;
}): SessionSummaryRecord[] {
  const dbPath = resolveMemoryDbPath(params.agentId);
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const limit = params.limit ?? 20;

    // Build keyword conditions for query parameter
    const keywords = params.query
      ? params.query
          .trim()
          .split(/\s+/)
          .filter((k) => k.length > 0)
      : [];

    // Build WHERE clause parts and bindings
    const conditions: string[] = [];
    const bindings: (string | number)[] = [];

    if (params.sessionKey) {
      const useLike = params.sessionKey.includes("%");
      conditions.push(`session_key ${useLike ? "LIKE" : "="} ?`);
      bindings.push(params.sessionKey);
    } else {
      conditions.push("agent_id = ?");
      bindings.push(params.agentId);
    }

    conditions.push("ended_at >= ?");
    bindings.push(params.from);
    conditions.push("ended_at <= ?");
    bindings.push(params.to);

    for (const keyword of keywords) {
      conditions.push("summary LIKE ? COLLATE NOCASE");
      bindings.push(`%${keyword}%`);
    }

    const sql = `
      SELECT * FROM session_summaries
      WHERE ${conditions.join(" AND ")}
      ORDER BY ended_at DESC
      LIMIT ?
    `;
    bindings.push(limit);

    const stmt = db.prepare(sql);
    return stmt.all(...bindings) as unknown as SessionSummaryRecord[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * Build the session history section for system prompt injection.
 */
export function buildSessionHistorySection(summaries: SessionSummaryRecord[]): string {
  if (summaries.length === 0) {
    return "";
  }

  const lines = [
    "## Recent Session History",
    "Summaries of your recent sessions (most recent first):",
    "",
  ];

  for (const s of summaries) {
    const started = s.created_at ? new Date(s.created_at).toISOString() : "unknown";
    const ended = new Date(s.ended_at).toISOString();
    const meta: string[] = [];
    meta.push(`session: ${s.session_id}`);
    meta.push(`key: ${s.session_key}`);
    if (s.model) {
      meta.push(`model: ${s.model}`);
    }
    meta.push(`messages: ${s.message_count}`);
    meta.push(`started: ${started}`);
    meta.push(`ended: ${ended}`);
    if (s.summary_model) {
      meta.push(`summary_model: ${s.summary_model}`);
    }
    lines.push(
      `### Session ${s.session_id.slice(0, 8)} (${new Date(s.ended_at).toISOString().split("T")[0]})`,
    );
    lines.push(meta.join(" | "));
    lines.push("");
    lines.push(s.summary);
    lines.push("");
  }

  return lines.join("\n");
}
