import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { ensureSessionSummariesSchema } from "../sessions/session-summary-schema.js";
import {
  extractFullTranscript,
  extractSessionTimestamps,
  generateSessionSummary,
} from "../sessions/session-summary.js";

const log = createSubsystemLogger("summary-cli");

function resolveMemoryDbPath(agentId: string): string {
  const stateDir = resolveStateDir(process.env, os.homedir);
  return path.join(stateDir, "memory", `${agentId}.sqlite`);
}

function getExistingSummaryIds(agentId: string): Set<string> {
  const dbPath = resolveMemoryDbPath(agentId);
  if (!fs.existsSync(dbPath)) {
    return new Set();
  }

  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);
  ensureSessionSummariesSchema(db);
  try {
    const rows = db.prepare("SELECT session_id FROM session_summaries").all() as Array<{
      session_id: string;
    }>;
    return new Set(rows.map((r) => r.session_id));
  } finally {
    db.close();
  }
}

/** Extract sessionId from a session file name like {uuid}.jsonl or {uuid}.jsonl.reset.{ts} */
function extractSessionIdFromFileName(fileName: string): string | null {
  // Match UUID pattern at the start
  const match = fileName.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1] : null;
}

/** Build sessionId → sessionKey mapping from sessions.json */
function buildSessionKeyMap(agentId: string): Map<string, string> {
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const sessionsJsonPath = path.join(sessionsDir, "sessions.json");
  const map = new Map<string, string>();

  if (!fs.existsSync(sessionsJsonPath)) {
    return map;
  }

  try {
    const data = JSON.parse(fs.readFileSync(sessionsJsonPath, "utf-8"));
    // sessions.json: { [sessionKey]: { sessionId, previousSessionId, ... } }
    for (const [sessionKey, entry] of Object.entries(data)) {
      const e = entry as Record<string, unknown>;
      if (typeof e.sessionId === "string") {
        map.set(e.sessionId, sessionKey);
      }
      // Walk previousSessionId chain
      let prevId = e.previousSessionId;
      while (typeof prevId === "string" && prevId) {
        map.set(prevId, sessionKey);
        // Can't follow the chain further without more data
        break;
      }
    }
  } catch {
    // best-effort
  }

  return map;
}

export function registerSummaryCli(program: Command): void {
  const summary = program.command("summary").description("Manage session summaries");

  summary
    .command("generate [sessionId]")
    .description("Generate summary for session(s)")
    .option("--all", "Process all historical sessions (only those without summaries)")
    .option("--force", "Force regeneration even if summary exists")
    .option("--dry-run", "List sessions to process without generating")
    .option("--agent <agentId>", "Agent ID")
    .action(
      async (
        sessionId: string | undefined,
        opts: {
          all?: boolean;
          force?: boolean;
          dryRun?: boolean;
          agent: string;
        },
      ) => {
        const config = loadConfig();
        const agentId = opts.agent || resolveDefaultAgentId(config);

        if (!sessionId && !opts.all) {
          console.error("Error: provide a sessionId or use --all");
          process.exit(1);
        }

        if (sessionId && opts.all) {
          console.error("Error: cannot use both sessionId and --all");
          process.exit(1);
        }

        const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
        if (!fs.existsSync(sessionsDir)) {
          console.error(`Sessions directory not found: ${sessionsDir}`);
          process.exit(1);
        }

        // Collect session files to process
        const filesToProcess: Array<{
          filePath: string;
          sessionId: string;
          fileName: string;
        }> = [];

        if (opts.all) {
          const files = fs.readdirSync(sessionsDir);
          for (const fileName of files) {
            if (
              !fileName.endsWith(".jsonl") &&
              !fileName.includes(".jsonl.reset.") &&
              !fileName.includes(".jsonl.deleted.")
            ) {
              continue;
            }
            const sid = extractSessionIdFromFileName(fileName);
            if (!sid) {
              continue;
            }
            filesToProcess.push({
              filePath: path.join(sessionsDir, fileName),
              sessionId: sid,
              fileName,
            });
          }
        } else if (sessionId) {
          // Find matching file
          const files = fs.readdirSync(sessionsDir);
          const matching = files.filter((f) => f.startsWith(sessionId));
          if (matching.length === 0) {
            console.error(`No session file found for ${sessionId}`);
            process.exit(1);
          }
          for (const fileName of matching) {
            filesToProcess.push({
              filePath: path.join(sessionsDir, fileName),
              sessionId,
              fileName,
            });
          }
        }

        // Filter out existing summaries unless --force
        const existingIds = opts.force ? new Set<string>() : getExistingSummaryIds(agentId);
        const sessionKeyMap = buildSessionKeyMap(agentId);

        let skippedExisting = 0;
        let skippedShort = 0;
        let successCount = 0;
        let failCount = 0;
        const total = filesToProcess.length;

        console.log(`Found ${total} session file(s) to evaluate`);

        for (let i = 0; i < filesToProcess.length; i++) {
          const entry = filesToProcess[i];
          const progress = `[${i + 1}/${total}]`;

          // Skip if already has summary
          if (existingIds.has(entry.sessionId)) {
            skippedExisting++;
            if (opts.dryRun) {
              console.log(`${progress} ⏭ ${entry.sessionId} (already has summary)`);
            }
            continue;
          }

          // Quick check message count
          const transcript = extractFullTranscript(entry.filePath);
          if (transcript.messageCount < 3 || transcript.totalChars < 500) {
            skippedShort++;
            if (opts.dryRun) {
              console.log(
                `${progress} ⏭ ${entry.sessionId} (${transcript.messageCount} msgs, ${transcript.totalChars} chars)`,
              );
            }
            continue;
          }

          const sessionKey = sessionKeyMap.get(entry.sessionId) ?? `unknown:${agentId}`;

          if (opts.dryRun) {
            console.log(
              `${progress} 📝 ${entry.sessionId} (${transcript.messageCount} msgs, ${transcript.totalChars} chars) → ${sessionKey}`,
            );
            continue;
          }

          try {
            console.log(
              `${progress} Processing ${entry.sessionId} (${transcript.messageCount} msgs, ${transcript.totalChars} chars)...`,
            );
            const timestamps = extractSessionTimestamps(entry.filePath);
            await generateSessionSummary({
              sessionFilePath: entry.filePath,
              sessionId: entry.sessionId,
              sessionKey,
              agentId,
              config,
              createdAt: timestamps.createdAt,
              endedAt: timestamps.endedAt,
            });
            successCount++;
            console.log(`${progress} ✓ ${entry.sessionId} → summary saved`);
          } catch (err) {
            failCount++;
            console.error(`${progress} ✗ ${entry.sessionId}: ${String(err)}`);
            log.error(`Failed to generate summary for ${entry.sessionId}: ${String(err)}`);
          }
        }

        console.log(
          `\nDone. Success: ${successCount}, Failed: ${failCount}, Skipped (existing): ${skippedExisting}, Skipped (short): ${skippedShort}`,
        );
      },
    );
}
