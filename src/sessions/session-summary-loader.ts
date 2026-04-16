import fs from "node:fs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  DEFAULT_SESSION_SUMMARY_MAX_CHARS,
  DEFAULT_SESSION_SUMMARY_DAYS,
  resolveSessionSummaryDbPath,
  resolveSessionSummarySettings,
  type SessionSummaryRecord,
} from "./session-summary.js";

function resolvePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.trunc(value);
}

function openReadOnlySummaryDb(agentId: string, config?: OpenClawConfig) {
  const dbPath = resolveSessionSummaryDbPath(agentId, config);
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  const { DatabaseSync } = requireNodeSqlite();
  return new DatabaseSync(dbPath, { readOnly: true });
}

/**
 * Load recent summaries for a specific session key.
 */
export function loadRecentSummaries(params: {
  sessionKey: string;
  agentId: string;
  days?: number;
  maxChars?: number;
  config?: OpenClawConfig;
}): SessionSummaryRecord[] {
  const db = openReadOnlySummaryDb(params.agentId, params.config);
  if (!db) {
    return [];
  }

  const settings = resolveSessionSummarySettings(params.config);
  const days =
    resolvePositiveInteger(params.days) ?? settings.summaryDays ?? DEFAULT_SESSION_SUMMARY_DAYS;
  const maxChars =
    resolvePositiveInteger(params.maxChars) ??
    settings.summaryMaxChars ??
    DEFAULT_SESSION_SUMMARY_MAX_CHARS;

  try {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows = db
      .prepare(`
        SELECT * FROM session_summaries
        WHERE agent_id = ? AND session_key = ? AND ended_at > ?
        ORDER BY ended_at DESC
        LIMIT 20
      `)
      .all(params.agentId, params.sessionKey, cutoff) as SessionSummaryRecord[];

    const capped: SessionSummaryRecord[] = [];
    let totalChars = 0;
    for (const row of rows) {
      const length = row.summary.length;
      if (totalChars + length > maxChars && capped.length > 0) {
        break;
      }
      capped.push(row);
      totalChars += length;
    }
    return capped;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * Query summaries for the current agent with optional session filters and keyword search.
 */
export function querySummaries(params: {
  agentId: string;
  sessionKey?: string;
  from: number;
  to: number;
  limit?: number;
  query?: string;
  config?: OpenClawConfig;
}): SessionSummaryRecord[] {
  const db = openReadOnlySummaryDb(params.agentId, params.config);
  if (!db) {
    return [];
  }

  try {
    const keywords = params.query
      ? params.query
          .trim()
          .split(/\s+/)
          .map((keyword) => keyword.trim())
          .filter(Boolean)
      : [];
    const limit = Math.max(1, Math.trunc(params.limit ?? 20));
    const conditions = ["agent_id = ?", "ended_at >= ?", "ended_at <= ?"];
    const bindings: Array<string | number> = [params.agentId, params.from, params.to];

    if (params.sessionKey) {
      const operator =
        params.sessionKey.includes("%") || params.sessionKey.includes("_") ? "LIKE" : "=";
      conditions.push(`session_key ${operator} ?`);
      bindings.push(params.sessionKey);
    }
    for (const keyword of keywords) {
      conditions.push("summary LIKE ? COLLATE NOCASE");
      bindings.push(`%${keyword}%`);
    }
    bindings.push(limit);

    return db
      .prepare(`
        SELECT * FROM session_summaries
        WHERE ${conditions.join(" AND ")}
        ORDER BY ended_at DESC
        LIMIT ?
      `)
      .all(...bindings) as SessionSummaryRecord[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * Format recent summaries for prompt injection.
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

  for (const summary of summaries) {
    const startedAt = summary.created_at ? new Date(summary.created_at).toISOString() : "unknown";
    const endedAt = new Date(summary.ended_at).toISOString();
    const meta = [
      `session: ${summary.session_id}`,
      `key: ${summary.session_key}`,
      summary.model ? `model: ${summary.model}` : null,
      `messages: ${summary.message_count}`,
      `started: ${startedAt}`,
      `ended: ${endedAt}`,
      summary.summary_model ? `summary_model: ${summary.summary_model}` : null,
    ].filter(Boolean);

    lines.push(
      `### Session ${summary.session_id.slice(0, 8)} (${endedAt.split("T")[0]})`,
      meta.join(" | "),
      "",
      summary.summary,
      "",
    );
  }

  return lines.join("\n");
}
