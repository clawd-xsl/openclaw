import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
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

function getExistingSummaryIds(
  agentId: string,
  ensureSchema: typeof ensureSessionSummariesSchema,
): Set<string> {
  const dbPath = resolveMemoryDbPath(agentId);
  if (!fs.existsSync(dbPath)) {
    return new Set();
  }

  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);
  try {
    ensureSchema(db);
    const rows = db.prepare("SELECT session_id FROM session_summaries").all() as Array<{
      session_id: string;
    }>;
    return new Set(rows.map((row) => row.session_id));
  } finally {
    db.close();
  }
}

function extractSessionIdFromFileName(fileName: string): string | null {
  const match = fileName.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1] : null;
}

function buildSessionKeyMap(agentId: string): Map<string, string> {
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const sessionsJsonPath = path.join(sessionsDir, "sessions.json");
  const map = new Map<string, string>();

  if (!fs.existsSync(sessionsJsonPath)) {
    return map;
  }

  try {
    const raw = fs.readFileSync(sessionsJsonPath, "utf-8");
    const store = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    for (const [sessionKey, entry] of Object.entries(store)) {
      const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : "";
      if (sessionId) {
        map.set(sessionId, sessionKey);
      }
      const previousSessionId =
        typeof entry.previousSessionId === "string" ? entry.previousSessionId : "";
      if (previousSessionId) {
        map.set(previousSessionId, sessionKey);
      }
    }
  } catch {
    // Best-effort mapping for deleted or older stores.
  }

  return map;
}

function resolveFallbackSessionKey(agentId: string, sessionId: string): string {
  return `agent:${agentId}:${sessionId}`;
}

export function registerSummaryCli(program: Command): void {
  const summary = program.command("summary").description("Generate historical session summaries");

  summary
    .command("generate [sessionId]")
    .description("Generate summary records for one session or all historical sessions")
    .option("--all", "Process all historical sessions that do not already have summaries")
    .option("--force", "Regenerate summaries even when a summary already exists")
    .option("--dry-run", "List the sessions that would be summarized without generating them")
    .option("--agent <agentId>", "Agent ID")
    .action(
      async (
        sessionId: string | undefined,
        opts: {
          all?: boolean;
          force?: boolean;
          dryRun?: boolean;
          agent?: string;
        },
      ) => {
        const config = loadConfig();
        const agentId = opts.agent?.trim() || resolveDefaultAgentId(config);

        if (!sessionId && !opts.all) {
          console.error("Error: provide a sessionId or use --all");
          process.exitCode = 1;
          return;
        }

        if (sessionId && opts.all) {
          console.error("Error: cannot use both sessionId and --all");
          process.exitCode = 1;
          return;
        }

        const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
        if (!fs.existsSync(sessionsDir)) {
          console.error(`Sessions directory not found: ${sessionsDir}`);
          process.exitCode = 1;
          return;
        }

        const filesToProcess: Array<{
          filePath: string;
          sessionId: string;
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
            const parsedSessionId = extractSessionIdFromFileName(fileName);
            if (!parsedSessionId) {
              continue;
            }
            filesToProcess.push({
              filePath: path.join(sessionsDir, fileName),
              sessionId: parsedSessionId,
            });
          }
        } else if (sessionId) {
          const files = fs.readdirSync(sessionsDir);
          const matchingFiles = files.filter((fileName) => fileName.startsWith(sessionId));
          if (matchingFiles.length === 0) {
            console.error(`No session file found for ${sessionId}`);
            process.exitCode = 1;
            return;
          }
          for (const fileName of matchingFiles) {
            filesToProcess.push({
              filePath: path.join(sessionsDir, fileName),
              sessionId,
            });
          }
        }

        const existingIds = opts.force
          ? new Set<string>()
          : getExistingSummaryIds(agentId, ensureSessionSummariesSchema);
        const sessionKeyMap = buildSessionKeyMap(agentId);

        let skippedExisting = 0;
        let skippedShort = 0;
        let successCount = 0;
        let failCount = 0;

        console.log(`Found ${filesToProcess.length} session file(s) to evaluate`);

        for (const [index, entry] of filesToProcess.entries()) {
          const progress = `[${index + 1}/${filesToProcess.length}]`;
          if (existingIds.has(entry.sessionId)) {
            skippedExisting += 1;
            if (opts.dryRun) {
              console.log(`${progress} skip ${entry.sessionId} (already summarized)`);
            }
            continue;
          }

          const transcript = extractFullTranscript(entry.filePath);
          if (transcript.messageCount < 3 || transcript.totalChars < 500) {
            skippedShort += 1;
            if (opts.dryRun) {
              console.log(
                `${progress} skip ${entry.sessionId} (${transcript.messageCount} msgs, ${transcript.totalChars} chars)`,
              );
            }
            continue;
          }

          const sessionKey =
            sessionKeyMap.get(entry.sessionId) ??
            resolveFallbackSessionKey(agentId, entry.sessionId);
          if (opts.dryRun) {
            console.log(
              `${progress} plan ${entry.sessionId} (${transcript.messageCount} msgs, ${transcript.totalChars} chars) -> ${sessionKey}`,
            );
            continue;
          }

          try {
            console.log(
              `${progress} processing ${entry.sessionId} (${transcript.messageCount} msgs, ${transcript.totalChars} chars)`,
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
            successCount += 1;
            console.log(`${progress} saved ${entry.sessionId}`);
          } catch (error) {
            failCount += 1;
            const message = error instanceof Error ? error.message : String(error);
            console.error(`${progress} failed ${entry.sessionId}: ${message}`);
            log.error(`Failed to generate summary for ${entry.sessionId}: ${message}`);
          }
        }

        console.log(
          [
            "Done.",
            `Success: ${successCount}`,
            `Failed: ${failCount}`,
            `Skipped (existing): ${skippedExisting}`,
            `Skipped (short): ${skippedShort}`,
          ].join(" "),
        );
      },
    );
}
