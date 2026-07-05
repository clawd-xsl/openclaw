// Session store migrations repair legacy field names during load/save normalization.
import type { SessionEntry } from "./types.js";

const LEGACY_CLAUDE_CLI_BACKEND_ID = "claude-cli-streaming";
const CLAUDE_CLI_BACKEND_ID = "claude-cli";

function removeRetiredClaudeCliMapKey<T>(map: Record<string, T> | undefined): boolean {
  if (!map || !Object.hasOwn(map, LEGACY_CLAUDE_CLI_BACKEND_ID)) {
    return false;
  }
  // The retired process did not use the canonical binding fingerprints. Renaming
  // its key could resume an unrelated native thread; dropping it forces safe reseed.
  delete map[LEGACY_CLAUDE_CLI_BACKEND_ID];
  return true;
}

function migrateClaudeCliSessionEntry(entry: SessionEntry): boolean {
  let changed = false;
  for (const key of [
    "modelProvider",
    "providerOverride",
    "agentHarnessId",
    "agentRuntimeOverride",
  ] as const) {
    if (entry[key] === LEGACY_CLAUDE_CLI_BACKEND_ID) {
      entry[key] = CLAUDE_CLI_BACKEND_ID;
      changed = true;
    }
  }
  changed = removeRetiredClaudeCliMapKey(entry.cliSessionIds) || changed;
  changed = removeRetiredClaudeCliMapKey(entry.cliSessionBindings) || changed;
  return changed;
}

/** Applies best-effort in-place migrations for legacy session store entry fields. */
export function applySessionStoreMigrations(store: Record<string, SessionEntry>): boolean {
  let changed = false;
  // Best-effort migration: message provider → channel naming.
  for (const entry of Object.values(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    changed = migrateClaudeCliSessionEntry(entry) || changed;
    const rec = entry as unknown as Record<string, unknown>;
    if (typeof rec.channel !== "string" && typeof rec.provider === "string") {
      rec.channel = rec.provider;
      delete rec.provider;
      changed = true;
    }
    if (typeof rec.lastChannel !== "string" && typeof rec.lastProvider === "string") {
      rec.lastChannel = rec.lastProvider;
      delete rec.lastProvider;
      changed = true;
    }

    // Best-effort migration: legacy `room` field → `groupChannel` (keep value, prune old key).
    if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
      rec.groupChannel = rec.room;
      delete rec.room;
      changed = true;
    } else if ("room" in rec) {
      delete rec.room;
      changed = true;
    }
  }
  return changed;
}
