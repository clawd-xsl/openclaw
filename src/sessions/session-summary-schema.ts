import type { DatabaseSync } from "node:sqlite";

function hasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
  return rows.some((row) => row.name === columnName);
}

/**
 * Ensure the session_summaries table exists in the backing SQLite database.
 */
export function ensureSessionSummariesSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      session_id TEXT PRIMARY KEY,
      previous_session_id TEXT,
      session_key TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'main',
      created_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL,
      model TEXT,
      summary_model TEXT,
      generated_at INTEGER NOT NULL
    );
  `);

  if (!hasColumn(db, "session_summaries", "agent_id")) {
    db.exec("ALTER TABLE session_summaries ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'");
  }
  if (!hasColumn(db, "session_summaries", "summary_model")) {
    db.exec("ALTER TABLE session_summaries ADD COLUMN summary_model TEXT");
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_summaries_agent_ended
      ON session_summaries(agent_id, ended_at);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_summaries_agent_key_ended
      ON session_summaries(agent_id, session_key, ended_at);
  `);
}
