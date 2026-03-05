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
}): SessionSummaryRecord[] {
  const days = params.days ?? 7;
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

    // Cap total injected summary size to avoid bloating the system prompt.
    const MAX_SUMMARY_CHARS = 8000;
    const capped: SessionSummaryRecord[] = [];
    let totalChars = 0;
    for (const row of rows) {
      const len = row.summary.length;
      if (totalChars + len > MAX_SUMMARY_CHARS && capped.length > 0) {
        break;
      }
      capped.push(row);
      totalChars += len;
    }
    return capped;
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
}): SessionSummaryRecord[] {
  const dbPath = resolveMemoryDbPath(params.agentId);
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const limit = params.limit ?? 20;
    if (params.sessionKey) {
      const useLike = params.sessionKey.includes("%");
      const stmt = db.prepare(`
        SELECT * FROM session_summaries
        WHERE session_key ${useLike ? "LIKE" : "="} ? AND ended_at >= ? AND ended_at <= ?
        ORDER BY ended_at DESC
        LIMIT ?
      `);
      return stmt.all(
        params.sessionKey,
        params.from,
        params.to,
        limit,
      ) as unknown as SessionSummaryRecord[];
    } else {
      const stmt = db.prepare(`
        SELECT * FROM session_summaries
        WHERE agent_id = ? AND ended_at >= ? AND ended_at <= ?
        ORDER BY ended_at DESC
        LIMIT ?
      `);
      return stmt.all(
        params.agentId,
        params.from,
        params.to,
        limit,
      ) as unknown as SessionSummaryRecord[];
    }
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
