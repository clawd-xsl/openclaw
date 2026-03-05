import type { DatabaseSync } from "node:sqlite";

/**
 * Ensure the session_summaries table exists in the memory SQLite database.
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
  // Migration: add summary_model column if missing
  try {
    db.exec(`ALTER TABLE session_summaries ADD COLUMN summary_model TEXT`);
  } catch {
    // Column already exists
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_summaries_key_ended
      ON session_summaries(session_key, ended_at);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_summaries_agent_ended
      ON session_summaries(agent_id, ended_at);
  `);
}
