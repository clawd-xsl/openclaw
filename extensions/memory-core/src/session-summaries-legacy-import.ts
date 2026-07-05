// Memory Core plugin module safely imports bounded legacy session-summary sidecars.
import type { DatabaseSync } from "node:sqlite";
import {
  buildSessionSummaryPredecessorIndexKey,
  buildSessionSummaryStoreKey,
  SESSION_SUMMARY_LEGACY_IMPORT_FINGERPRINT,
  SESSION_SUMMARY_STORE_MAX_ENTRIES,
  type SessionSummaryRepository,
} from "./session-summaries-store.js";
import {
  sanitizeSessionSummaryForStorage,
  SESSION_SUMMARY_MAX_STORED_BYTES,
} from "./session-summaries-transcript.js";

export const LEGACY_SESSION_SUMMARY_IMPORT_MAX = 2_048;
export const LEGACY_SESSION_SUMMARY_STORE_RESERVE = 512;
export const LEGACY_SESSION_SUMMARY_PLUGIN_STORE_RESERVE = 1_024;
export const LEGACY_SESSION_SUMMARY_PRESELECTION_MAX = 4_096;
export const LEGACY_SESSION_SUMMARY_PRESELECTION_MAX_BYTES =
  LEGACY_SESSION_SUMMARY_PRESELECTION_MAX * SESSION_SUMMARY_MAX_STORED_BYTES;
const LEGACY_SESSION_SUMMARY_READ_MAX_BYTES = SESSION_SUMMARY_MAX_STORED_BYTES;
const MAX_SAFE_SQLITE_INTEGER = Number.MAX_SAFE_INTEGER;

const LEGACY_BASE_COLUMNS = [
  "session_id",
  "previous_session_id",
  "session_key",
  "created_at",
  "ended_at",
  "message_count",
  "summary",
  "model",
  "generated_at",
] as const;

export type LegacySessionSummarySourceScope = {
  agentId: string;
  /** Lower values win when configured and fallback stores contain the same session. */
  priority: number;
};

export type LegacySessionSummarySourceGroup = {
  legacyPath: string;
  scopes: readonly LegacySessionSummarySourceScope[];
};

export type LegacySessionSummarySourceResult = {
  legacyPath: string;
  recognized: boolean;
  archiveReady: boolean;
  retryCopySafe: boolean;
  totalRows: number;
  ownedRows: number;
  importedRows: number;
  existingRows: number;
  duplicateRows: number;
  omittedRows: number;
  sanitizedRows: number;
  invalidRows: number;
  unownedRows: number;
  errors: string[];
};

export type LegacySessionSummaryMigrationResult = {
  sources: LegacySessionSummarySourceResult[];
  storedEntriesBefore: number;
  storedPredecessorEntriesBefore: number;
  importBudget: number;
  materializedCandidates: number;
  materializedSummaryBytes: number;
};

type LegacySchemaKind = "base" | "agent" | "agent-summary-model";

type LegacySessionSummaryCandidate = {
  agentId: string;
  sessionId: string;
  previousSessionId: string | null;
  sessionKey: string;
  createdAt: number;
  endedAt: number;
  messageCount: number;
  summary: string;
  summaryModel: string | null;
  generatedAt: number;
  sourcePath: string;
  sourcePriority: number;
  sourceResultIndex: number;
};

type LegacySqlRow = Record<string, unknown>;

export type LegacySessionSummaryOwnerInspection =
  | { kind: "absent" | "unscoped" }
  | { kind: "tagged"; owners: string[] }
  | { kind: "unsafe"; reason: string };

function normalizeScopedAgentId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeRequiredString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength && !normalized.includes("\u0000")
    ? normalized
    : undefined;
}

function normalizeOptionalString(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length > maxLength || value.includes("\u0000")) {
    return undefined;
  }
  return value.trim() || null;
}

function asSafeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readCount(db: DatabaseSync, sql: string, ...values: Array<string | number>): number {
  const row = db.prepare(sql).get(...values) as { count?: unknown } | undefined;
  const count = Number(row?.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("legacy session summary count is outside the supported range");
  }
  return count;
}

function tableExists(db: DatabaseSync): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'")
      .get(),
  );
}

function readSchemaKind(db: DatabaseSync): LegacySchemaKind | undefined {
  const columns = db.prepare("PRAGMA table_info(session_summaries)").all() as Array<{
    name?: unknown;
  }>;
  const names = new Set(
    columns.flatMap((column) => (typeof column.name === "string" ? [column.name] : [])),
  );
  const exact = (extra: readonly string[]) =>
    names.size === LEGACY_BASE_COLUMNS.length + extra.length &&
    LEGACY_BASE_COLUMNS.every((column) => names.has(column)) &&
    extra.every((column) => names.has(column));
  if (exact([])) {
    return "base";
  }
  if (exact(["agent_id"])) {
    return "agent";
  }
  if (exact(["agent_id", "summary_model"])) {
    return "agent-summary-model";
  }
  return undefined;
}

function invalidBoundedTextPredicate(column: string, maxLength: number): string {
  // UTF-8 byte length is always at least the JavaScript UTF-16 code-unit
  // length. The byte cap is deliberately conservative so the SQL-wide gate
  // cannot miss a value that the bounded JavaScript parser would reject.
  return `substr(${column}, ${maxLength + 1}, 1) <> '' OR instr(CAST(${column} AS BLOB), X'00') > 0 OR length(CAST(${column} AS BLOB)) > ${maxLength}`;
}

function invalidRowPredicate(kind: LegacySchemaKind): string {
  const optionalAgent =
    kind === "base"
      ? ""
      : ` OR typeof(agent_id) <> 'text' OR length(trim(substr(agent_id, 1, 129))) = 0 OR ${invalidBoundedTextPredicate("agent_id", 128)} OR substr(agent_id, 1, 129) <> lower(trim(substr(agent_id, 1, 129)))`;
  const optionalSummaryModel =
    kind === "agent-summary-model"
      ? ` OR (summary_model IS NOT NULL AND (typeof(summary_model) <> 'text' OR ${invalidBoundedTextPredicate("summary_model", 512)}))`
      : "";
  return `
    typeof(session_id) <> 'text' OR length(trim(substr(session_id, 1, 513))) = 0 OR ${invalidBoundedTextPredicate("session_id", 512)}
    OR (previous_session_id IS NOT NULL AND (typeof(previous_session_id) <> 'text' OR ${invalidBoundedTextPredicate("previous_session_id", 512)}))
    OR typeof(session_key) <> 'text' OR length(trim(substr(session_key, 1, 2049))) = 0 OR ${invalidBoundedTextPredicate("session_key", 2_048)}
    OR typeof(created_at) <> 'integer' OR created_at < 0 OR created_at > ${MAX_SAFE_SQLITE_INTEGER}
    OR typeof(ended_at) <> 'integer' OR ended_at < created_at OR ended_at > ${MAX_SAFE_SQLITE_INTEGER}
    OR typeof(message_count) <> 'integer' OR message_count < 0 OR message_count > ${MAX_SAFE_SQLITE_INTEGER}
    OR typeof(summary) <> 'text' OR length(trim(substr(summary, 1, 256))) = 0 OR instr(CAST(summary AS BLOB), X'00') > 0
    OR typeof(generated_at) <> 'integer' OR generated_at < 0 OR generated_at > ${MAX_SAFE_SQLITE_INTEGER}
    ${optionalAgent}
    ${optionalSummaryModel}
  `;
}

function selectSql(kind: LegacySchemaKind, filterByAgent: boolean): string {
  const summaryModelColumn =
    kind === "agent-summary-model"
      ? "substr(summary_model, 1, 512) AS summary_model, substr(summary_model, 513, 1) AS summary_model_has_more"
      : "NULL AS summary_model, NULL AS summary_model_has_more";
  const summaryModelBlobInvalidColumn =
    kind === "agent-summary-model"
      ? `(${invalidBoundedTextPredicate("summary_model", 512)}) AS summary_model_blob_invalid`
      : "NULL AS summary_model_blob_invalid";
  const validRowPredicate = `NOT (${invalidRowPredicate(kind)})`;
  return `
    SELECT substr(session_id, 1, 512) AS session_id,
           substr(session_id, 513, 1) AS session_id_has_more,
           (${invalidBoundedTextPredicate("session_id", 512)}) AS session_id_blob_invalid,
           substr(previous_session_id, 1, 512) AS previous_session_id,
           substr(previous_session_id, 513, 1) AS previous_session_id_has_more,
           (${invalidBoundedTextPredicate("previous_session_id", 512)}) AS previous_session_id_blob_invalid,
           substr(session_key, 1, 2048) AS session_key,
           substr(session_key, 2049, 1) AS session_key_has_more,
           (${invalidBoundedTextPredicate("session_key", 2_048)}) AS session_key_blob_invalid,
           created_at, ended_at, message_count,
           substr(CAST(summary AS BLOB), 1, ${LEGACY_SESSION_SUMMARY_READ_MAX_BYTES}) AS summary_bytes,
           length(substr(CAST(summary AS BLOB), ${LEGACY_SESSION_SUMMARY_READ_MAX_BYTES + 1}, 1)) > 0 AS summary_has_more,
           ${summaryModelColumn}, ${summaryModelBlobInvalidColumn}, generated_at
    FROM session_summaries
    ${filterByAgent ? `WHERE agent_id = ? AND ${validRowPredicate}` : `WHERE ${validRowPredicate}`}
    ORDER BY ended_at DESC, generated_at DESC, substr(session_id, 1, 512) ASC
    LIMIT ?
  `;
}

function rowHasOverflow(row: LegacySqlRow): boolean {
  const textOverflow = [
    row.session_id_has_more,
    row.previous_session_id_has_more,
    row.session_key_has_more,
    row.summary_model_has_more,
  ].some((value) => typeof value === "string" && value.length > 0);
  const blobInvalid = [
    row.session_id_blob_invalid,
    row.previous_session_id_blob_invalid,
    row.session_key_blob_invalid,
    row.summary_model_blob_invalid,
  ].some((value) => value === 1 || value === 1n);
  return textOverflow || blobInvalid;
}

function parseCandidate(params: {
  row: LegacySqlRow;
  agentId: string;
  sourcePath: string;
  sourcePriority: number;
  sourceResultIndex: number;
}): { candidate?: LegacySessionSummaryCandidate; sanitized: boolean } {
  if (rowHasOverflow(params.row)) {
    return { sanitized: false };
  }
  const sessionId = normalizeRequiredString(params.row.session_id, 512);
  const previousSessionId = normalizeOptionalString(params.row.previous_session_id, 512);
  const sessionKey = normalizeRequiredString(params.row.session_key, 2_048);
  const createdAt = asSafeNonNegativeInteger(params.row.created_at);
  const endedAt = asSafeNonNegativeInteger(params.row.ended_at);
  const messageCount = asSafeNonNegativeInteger(params.row.message_count);
  const generatedAt = asSafeNonNegativeInteger(params.row.generated_at);
  const summaryModel = normalizeOptionalString(params.row.summary_model, 512);
  const summaryBytes =
    params.row.summary_bytes instanceof Uint8Array
      ? Buffer.from(params.row.summary_bytes)
      : undefined;
  if (
    !sessionId ||
    previousSessionId === undefined ||
    !sessionKey ||
    createdAt === undefined ||
    endedAt === undefined ||
    endedAt < createdAt ||
    messageCount === undefined ||
    generatedAt === undefined ||
    summaryModel === undefined ||
    !summaryBytes
  ) {
    return { sanitized: false };
  }
  const rawSummary = summaryBytes.toString("utf8");
  const summary = sanitizeSessionSummaryForStorage(rawSummary);
  if (!summary) {
    return { sanitized: false };
  }
  return {
    candidate: {
      agentId: params.agentId,
      sessionId,
      previousSessionId,
      sessionKey,
      createdAt,
      endedAt,
      messageCount,
      summary,
      summaryModel,
      generatedAt,
      sourcePath: params.sourcePath,
      sourcePriority: params.sourcePriority,
      sourceResultIndex: params.sourceResultIndex,
    },
    sanitized:
      summary !== rawSummary ||
      params.row.summary_has_more === 1 ||
      params.row.summary_has_more === 1n,
  };
}

/**
 * Read the complete owner set without materializing unbounded legacy values.
 * Unsafe or oversized owner sets must keep the original source in place.
 */
export function inspectLegacySessionSummaryOwners(
  db: DatabaseSync,
  maxOwners: number,
): LegacySessionSummaryOwnerInspection {
  if (!tableExists(db)) {
    return { kind: "absent" };
  }
  const schema = readSchemaKind(db);
  if (schema === "base") {
    return { kind: "unscoped" };
  }
  if (schema !== "agent" && schema !== "agent-summary-model") {
    return { kind: "unsafe", reason: "session_summaries uses an unsupported column layout" };
  }
  if (!Number.isSafeInteger(maxOwners) || maxOwners < 1) {
    return { kind: "unsafe", reason: "owner inspection limit is invalid" };
  }
  const rows = db
    .prepare(
      `SELECT typeof(agent_id) AS agent_type,
              substr(agent_id, 1, 128) AS agent_id,
              substr(agent_id, 129, 1) AS agent_id_has_more,
              (${invalidBoundedTextPredicate("agent_id", 128)}) AS agent_id_blob_invalid
       FROM session_summaries
       GROUP BY typeof(agent_id), substr(agent_id, 1, 128), substr(agent_id, 129, 1), (${invalidBoundedTextPredicate("agent_id", 128)})
       ORDER BY substr(agent_id, 1, 128)
       LIMIT ?`,
    )
    .all(maxOwners + 1) as Array<{
    agent_id?: unknown;
    agent_id_blob_invalid?: unknown;
    agent_id_has_more?: unknown;
    agent_type?: unknown;
  }>;
  if (rows.length > maxOwners) {
    return { kind: "unsafe", reason: `session_summaries has more than ${maxOwners} owners` };
  }
  const owners: string[] = [];
  for (const row of rows) {
    const owner = normalizeRequiredString(row.agent_id, 128);
    if (
      row.agent_type !== "text" ||
      !owner ||
      owner !== normalizeScopedAgentId(owner) ||
      (typeof row.agent_id_has_more === "string" && row.agent_id_has_more.length > 0) ||
      row.agent_id_blob_invalid === 1 ||
      row.agent_id_blob_invalid === 1n
    ) {
      return { kind: "unsafe", reason: "session_summaries contains an invalid owner" };
    }
    owners.push(owner);
  }
  return { kind: "tagged", owners: [...new Set(owners)].toSorted() };
}

function hasAgentIdLookupIndex(db: DatabaseSync): boolean {
  const indexes = db
    .prepare("SELECT name FROM pragma_index_list('session_summaries')")
    .all() as Array<{
    name?: unknown;
  }>;
  for (const index of indexes) {
    if (typeof index.name !== "string") {
      continue;
    }
    const columns = db
      .prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
      .all(index.name) as Array<{ name?: unknown }>;
    if (columns[0]?.name === "agent_id") {
      return true;
    }
  }
  return false;
}

function normalizedScopes(
  scopes: readonly LegacySessionSummarySourceScope[],
): LegacySessionSummarySourceScope[] {
  const byAgent = new Map<string, LegacySessionSummarySourceScope>();
  for (const scope of scopes) {
    const agentId = normalizeScopedAgentId(scope.agentId);
    if (!agentId) {
      continue;
    }
    const current = byAgent.get(agentId);
    if (!current || scope.priority < current.priority) {
      byAgent.set(agentId, { agentId, priority: scope.priority });
    }
  }
  return [...byAgent.values()].toSorted((left, right) => left.agentId.localeCompare(right.agentId));
}

function allocateSourceReadBudgets(
  sources: readonly LegacySessionSummarySourceGroup[],
): Array<Map<string, number>> {
  const budgets = sources.map(() => new Map<string, number>());
  const scopesByAgent = new Map<
    string,
    Array<{ resultIndex: number; legacyPath: string; priority: number }>
  >();
  for (const [resultIndex, source] of sources.entries()) {
    for (const scope of normalizedScopes(source.scopes)) {
      const refs = scopesByAgent.get(scope.agentId) ?? [];
      refs.push({ resultIndex, legacyPath: source.legacyPath, priority: scope.priority });
      scopesByAgent.set(scope.agentId, refs);
    }
  }
  const agents = [...scopesByAgent.keys()].toSorted((left, right) => left.localeCompare(right));
  let remaining = LEGACY_SESSION_SUMMARY_PRESELECTION_MAX;
  for (const [agentIndex, agentId] of agents.entries()) {
    const refs = (scopesByAgent.get(agentId) ?? []).toSorted(
      (left, right) =>
        left.priority - right.priority ||
        left.legacyPath.localeCompare(right.legacyPath) ||
        left.resultIndex - right.resultIndex,
    );
    if (refs.length === 0) {
      continue;
    }
    const remainingAgents = agents.length - agentIndex;
    const fairShare = Math.floor(remaining / remainingAgents);
    const agentBudget = Math.min(fairShare, refs.length * LEGACY_SESSION_SUMMARY_IMPORT_MAX);
    remaining -= agentBudget;
    const perSource = Math.floor(agentBudget / refs.length);
    let remainder = agentBudget % refs.length;
    for (const ref of refs) {
      const readLimit = perSource + (remainder > 0 ? 1 : 0);
      remainder = Math.max(0, remainder - 1);
      budgets[ref.resultIndex].set(agentId, readLimit);
    }
  }
  return budgets;
}

function inspectSource(params: {
  db: DatabaseSync;
  group: LegacySessionSummarySourceGroup;
  result: LegacySessionSummarySourceResult;
  resultIndex: number;
  readLimits: ReadonlyMap<string, number>;
  lineageIncompleteAgents: Set<string>;
}): LegacySessionSummaryCandidate[] {
  if (!tableExists(params.db)) {
    // A shared memory-index-only sidecar is safe to copy once per agent. There
    // are no summary rows whose ownership could be made ambiguous by the copy.
    params.result.retryCopySafe = true;
    return [];
  }
  params.result.recognized = true;
  const kind = readSchemaKind(params.db);
  const scopes = normalizedScopes(params.group.scopes);
  params.result.retryCopySafe =
    scopes.length <= 1 || kind === "agent" || kind === "agent-summary-model";
  if (!kind) {
    params.result.archiveReady = false;
    params.result.errors.push("session_summaries uses an unsupported column layout");
    return [];
  }
  params.result.totalRows = readCount(params.db, "SELECT COUNT(*) AS count FROM session_summaries");
  params.result.invalidRows = readCount(
    params.db,
    `SELECT COUNT(*) AS count FROM session_summaries WHERE ${invalidRowPredicate(kind)}`,
  );
  if (params.result.invalidRows > 0) {
    params.result.archiveReady = false;
  }
  if (scopes.length === 0) {
    params.result.unownedRows = params.result.totalRows;
    params.result.archiveReady = params.result.totalRows === 0 && params.result.archiveReady;
    return [];
  }
  if (kind === "base" && scopes.length !== 1) {
    params.result.unownedRows = params.result.totalRows;
    params.result.archiveReady = params.result.totalRows === 0 && params.result.archiveReady;
    if (params.result.totalRows > 0) {
      params.result.errors.push(
        "session_summaries has no agent_id column and the shared sidecar has multiple agent owners",
      );
    }
    return [];
  }
  if (
    kind !== "base" &&
    scopes.length > 1 &&
    params.result.totalRows > LEGACY_SESSION_SUMMARY_PRESELECTION_MAX &&
    !hasAgentIdLookupIndex(params.db)
  ) {
    params.result.archiveReady = false;
    params.result.errors.push("large shared session_summaries table has no agent_id lookup index");
    return [];
  }

  const candidates: LegacySessionSummaryCandidate[] = [];
  let invalidOwnedRows = 0;
  for (const scope of scopes) {
    const readLimit = params.readLimits.get(scope.agentId) ?? 0;
    const ownedRows =
      kind === "base"
        ? params.result.totalRows
        : readCount(
            params.db,
            "SELECT COUNT(*) AS count FROM session_summaries WHERE agent_id = ?",
            scope.agentId,
          );
    params.result.ownedRows += ownedRows;
    const invalidOwnedForScope =
      kind === "base"
        ? params.result.invalidRows
        : readCount(
            params.db,
            `SELECT COUNT(*) AS count FROM session_summaries
             WHERE agent_id = ? AND (${invalidRowPredicate(kind)})`,
            scope.agentId,
          );
    invalidOwnedRows += invalidOwnedForScope;
    if (invalidOwnedForScope > 0 || ownedRows - invalidOwnedForScope > readLimit) {
      params.lineageIncompleteAgents.add(scope.agentId);
    }
    if (readLimit === 0) {
      if (ownedRows - invalidOwnedForScope > 0) {
        params.result.archiveReady = false;
        params.result.errors.push(
          `preselection budget could not inspect session summaries for agent ${scope.agentId}`,
        );
      }
      continue;
    }
    const statement = params.db.prepare(selectSql(kind, kind !== "base"));
    const rows = (
      kind === "base" ? statement.iterate(readLimit) : statement.iterate(scope.agentId, readLimit)
    ) as Iterable<LegacySqlRow>;
    let parserRejectedRows = 0;
    for (const row of rows) {
      const parsed = parseCandidate({
        row,
        agentId: scope.agentId,
        sourcePath: params.group.legacyPath,
        sourcePriority: scope.priority,
        sourceResultIndex: params.resultIndex,
      });
      if (!parsed.candidate) {
        parserRejectedRows += 1;
        continue;
      }
      candidates.push(parsed.candidate);
      if (parsed.sanitized) {
        params.result.sanitizedRows += 1;
      }
    }
    if (parserRejectedRows > 0) {
      params.result.archiveReady = false;
      params.lineageIncompleteAgents.add(scope.agentId);
      params.result.errors.push(
        `${parserRejectedRows} selected session summary row(s) failed bounded validation for agent ${scope.agentId}`,
      );
    }
  }
  params.result.unownedRows = Math.max(0, params.result.totalRows - params.result.ownedRows);
  params.result.omittedRows += Math.max(
    0,
    params.result.ownedRows - candidates.length - invalidOwnedRows,
  );
  if (params.result.unownedRows > 0) {
    params.result.archiveReady = false;
    params.result.errors.push(
      `${params.result.unownedRows} session summary row(s) do not belong to a configured agent`,
    );
  }
  return candidates;
}

function candidateWins(
  candidate: LegacySessionSummaryCandidate,
  current: LegacySessionSummaryCandidate,
): boolean {
  return (
    candidate.sourcePriority < current.sourcePriority ||
    (candidate.sourcePriority === current.sourcePriority &&
      (candidate.generatedAt > current.generatedAt ||
        (candidate.generatedAt === current.generatedAt &&
          candidate.sourcePath.localeCompare(current.sourcePath) < 0)))
  );
}

function compareCandidateRecency(
  left: LegacySessionSummaryCandidate,
  right: LegacySessionSummaryCandidate,
): number {
  return (
    right.endedAt - left.endedAt ||
    right.generatedAt - left.generatedAt ||
    left.sessionId.localeCompare(right.sessionId)
  );
}

function selectFairRecentCandidates(
  candidates: readonly LegacySessionSummaryCandidate[],
  limit: number,
  canSelect: (candidate: LegacySessionSummaryCandidate) => boolean = () => true,
): LegacySessionSummaryCandidate[] {
  const byAgent = new Map<string, LegacySessionSummaryCandidate[]>();
  for (const candidate of candidates) {
    const rows = byAgent.get(candidate.agentId) ?? [];
    rows.push(candidate);
    byAgent.set(candidate.agentId, rows);
  }
  const agents = [...byAgent.keys()].toSorted((left, right) => left.localeCompare(right));
  for (const rows of byAgent.values()) {
    rows.sort(compareCandidateRecency);
  }
  const selected: LegacySessionSummaryCandidate[] = [];
  for (let offset = 0; selected.length < limit; offset += 1) {
    let visited = false;
    for (const agentId of agents) {
      const row = byAgent.get(agentId)?.[offset];
      if (!row) {
        continue;
      }
      visited = true;
      if (!canSelect(row)) {
        continue;
      }
      selected.push(row);
      if (selected.length >= limit) {
        break;
      }
    }
    if (!visited) {
      break;
    }
  }
  return selected;
}

function buildTrustedNextSessionIds(
  winners: ReadonlyMap<string, LegacySessionSummaryCandidate>,
  lineageIncompleteAgents: ReadonlySet<string>,
): Map<string, string> {
  const childReferences = new Map<string, LegacySessionSummaryCandidate[]>();
  for (const child of winners.values()) {
    if (
      lineageIncompleteAgents.has(child.agentId) ||
      !child.previousSessionId ||
      child.previousSessionId === child.sessionId
    ) {
      continue;
    }
    const parentKey = buildSessionSummaryStoreKey(child.agentId, child.previousSessionId);
    const references = childReferences.get(parentKey) ?? [];
    references.push(child);
    childReferences.set(parentKey, references);
  }
  const nextSessionIds = new Map<string, string>();
  for (const [parentKey, children] of childReferences) {
    if (children.length !== 1) {
      continue;
    }
    const parent = winners.get(parentKey);
    const child = children[0];
    if (
      !parent ||
      !child ||
      parent.agentId !== child.agentId ||
      parent.sessionKey !== child.sessionKey ||
      child.createdAt < parent.endedAt ||
      child.endedAt < child.createdAt
    ) {
      continue;
    }
    nextSessionIds.set(parentKey, child.sessionId);
  }
  return nextSessionIds;
}

function buildLegacyImportInput(
  candidate: LegacySessionSummaryCandidate,
  nextSessionId: string | undefined,
) {
  return {
    agentId: candidate.agentId,
    sessionId: candidate.sessionId,
    sessionKey: candidate.sessionKey,
    ...(nextSessionId ? { nextSessionId } : {}),
    endedAt: candidate.endedAt,
    messageCount: candidate.messageCount,
    summary: candidate.summary,
    model: candidate.summaryModel,
    generatedAt: candidate.generatedAt,
  };
}

function createSourceResult(
  group: LegacySessionSummarySourceGroup,
): LegacySessionSummarySourceResult {
  return {
    legacyPath: group.legacyPath,
    recognized: false,
    archiveReady: true,
    retryCopySafe: group.scopes.length <= 1,
    totalRows: 0,
    ownedRows: 0,
    importedRows: 0,
    existingRows: 0,
    duplicateRows: 0,
    omittedRows: 0,
    sanitizedRows: 0,
    invalidRows: 0,
    unownedRows: 0,
    errors: [],
  };
}

export async function importLegacySessionSummarySources(params: {
  sources: readonly LegacySessionSummarySourceGroup[];
  openReadOnlyDatabase: (legacyPath: string) => DatabaseSync;
  repository: SessionSummaryRepository;
  getPluginStateCapacity?: () => { liveEntries: number; maxEntries: number };
}): Promise<LegacySessionSummaryMigrationResult> {
  const results = params.sources.map(createSourceResult);
  const readBudgets = allocateSourceReadBudgets(params.sources);
  const lineageIncompleteAgents = new Set<string>();
  const occurrences: LegacySessionSummaryCandidate[] = [];
  for (const [index, source] of params.sources.entries()) {
    let db: DatabaseSync | undefined;
    try {
      db = params.openReadOnlyDatabase(source.legacyPath);
      occurrences.push(
        ...inspectSource({
          db,
          group: source,
          result: results[index],
          resultIndex: index,
          readLimits: readBudgets[index],
          lineageIncompleteAgents,
        }),
      );
    } catch (err) {
      const result = results[index];
      result.archiveReady = false;
      result.errors.push(`could not read session_summaries: ${String(err)}`);
    } finally {
      db?.close();
    }
  }
  const materializedSummaryBytes = occurrences.reduce(
    (total, candidate) => total + Buffer.byteLength(candidate.summary, "utf8"),
    0,
  );
  if (
    occurrences.length > LEGACY_SESSION_SUMMARY_PRESELECTION_MAX ||
    materializedSummaryBytes > LEGACY_SESSION_SUMMARY_PRESELECTION_MAX_BYTES
  ) {
    throw new Error("legacy session summary preselection exceeded its hard bound");
  }

  const occurrencesByIdentity = new Map<string, LegacySessionSummaryCandidate[]>();
  const winners = new Map<string, LegacySessionSummaryCandidate>();
  for (const candidate of occurrences) {
    const key = buildSessionSummaryStoreKey(candidate.agentId, candidate.sessionId);
    const identityOccurrences = occurrencesByIdentity.get(key) ?? [];
    identityOccurrences.push(candidate);
    occurrencesByIdentity.set(key, identityOccurrences);
    const current = winners.get(key);
    if (!current || candidateWins(candidate, current)) {
      winners.set(key, candidate);
    }
  }
  for (const [key, identityOccurrences] of occurrencesByIdentity) {
    const winner = winners.get(key);
    for (const occurrence of identityOccurrences) {
      if (occurrence !== winner) {
        results[occurrence.sourceResultIndex].duplicateRows += 1;
      }
    }
  }

  const markCandidateError = (
    candidates: Iterable<LegacySessionSummaryCandidate>,
    error: string,
  ) => {
    for (const candidate of candidates) {
      const key = buildSessionSummaryStoreKey(candidate.agentId, candidate.sessionId);
      for (const occurrence of occurrencesByIdentity.get(key) ?? []) {
        const result = results[occurrence.sourceResultIndex];
        result.archiveReady = false;
        if (!result.errors.includes(error)) {
          result.errors.push(error);
        }
      }
    }
  };
  const markAllSourceError = (error: string) => {
    for (const result of results) {
      if (!result.recognized) {
        continue;
      }
      result.archiveReady = false;
      if (!result.errors.includes(error)) {
        result.errors.push(error);
      }
    }
  };

  let existingRecordEntries: Awaited<ReturnType<SessionSummaryRepository["readAllRecordEntries"]>>;
  let predecessorEntries: Awaited<
    ReturnType<SessionSummaryRepository["readAllPredecessorIndexEntries"]>
  >;
  let storedEntriesBefore: number;
  let pluginStateCapacity: { liveEntries: number; maxEntries: number };
  try {
    [existingRecordEntries, predecessorEntries, storedEntriesBefore] = await Promise.all([
      params.repository.readAllRecordEntries(),
      params.repository.readAllPredecessorIndexEntries(),
      params.repository.countStoredEntries(),
    ]);
    pluginStateCapacity = params.getPluginStateCapacity?.() ?? {
      liveEntries: Number.NaN,
      maxEntries: Number.NaN,
    };
    if (
      !Number.isSafeInteger(pluginStateCapacity.liveEntries) ||
      pluginStateCapacity.liveEntries < 0 ||
      !Number.isSafeInteger(pluginStateCapacity.maxEntries) ||
      pluginStateCapacity.maxEntries < 1
    ) {
      throw new Error("host did not provide valid plugin-state capacity");
    }
  } catch (err) {
    markAllSourceError(`plugin state could not be prepared: ${String(err)}`);
    return {
      sources: results,
      storedEntriesBefore: 0,
      storedPredecessorEntriesBefore: 0,
      importBudget: 0,
      materializedCandidates: occurrences.length,
      materializedSummaryBytes,
    };
  }

  const storedPredecessorEntriesBefore = predecessorEntries.length;
  const existingRecordsByKey = new Map(
    existingRecordEntries.map((entry) => [
      buildSessionSummaryStoreKey(entry.value.agentId, entry.value.sessionId),
      entry.value,
    ]),
  );
  const predecessorKeys = new Set(predecessorEntries.map((entry) => entry.key));
  for (const [key, winner] of winners) {
    const existing = existingRecordsByKey.get(key);
    if (!existing) {
      continue;
    }
    results[winner.sourceResultIndex].existingRows += 1;
  }

  const nextSessionIds = buildTrustedNextSessionIds(winners, lineageIncompleteAgents);
  const missingRepairEntries = new Map<string, (typeof existingRecordEntries)[number]>();
  for (const entry of existingRecordEntries) {
    const existing = entry.value;
    if (
      existing.generationConfigFingerprint !== SESSION_SUMMARY_LEGACY_IMPORT_FINGERPRINT ||
      !existing.nextSessionId
    ) {
      continue;
    }
    const indexKey = buildSessionSummaryPredecessorIndexKey(
      existing.agentId,
      existing.nextSessionId,
    );
    if (!predecessorKeys.has(indexKey)) {
      missingRepairEntries.set(indexKey, entry);
    }
  }

  const summarySlots = Math.max(
    0,
    SESSION_SUMMARY_STORE_MAX_ENTRIES - LEGACY_SESSION_SUMMARY_STORE_RESERVE - storedEntriesBefore,
  );
  const predecessorSlots = Math.max(
    0,
    SESSION_SUMMARY_STORE_MAX_ENTRIES -
      LEGACY_SESSION_SUMMARY_STORE_RESERVE -
      storedPredecessorEntriesBefore,
  );
  const pluginSlots = Math.max(
    0,
    pluginStateCapacity.maxEntries -
      LEGACY_SESSION_SUMMARY_PLUGIN_STORE_RESERVE -
      pluginStateCapacity.liveEntries,
  );
  if (missingRepairEntries.size > predecessorSlots || missingRepairEntries.size > pluginSlots) {
    markAllSourceError("plugin state has no headroom to repair legacy session-summary indexes");
    return {
      sources: results,
      storedEntriesBefore,
      storedPredecessorEntriesBefore,
      importBudget: 0,
      materializedCandidates: occurrences.length,
      materializedSummaryBytes,
    };
  }

  for (const entry of missingRepairEntries.values()) {
    try {
      await params.repository.repairLegacyPredecessorIndex(entry.key);
    } catch (err) {
      markAllSourceError(
        `session ${entry.value.sessionId} index could not be repaired: ${String(err)}`,
      );
    }
  }

  const newCandidates = [...winners.entries()]
    .filter(([key]) => !existingRecordsByKey.has(key))
    .map(([, candidate]) => candidate);
  let remainingSummarySlots = summarySlots;
  let remainingPredecessorSlots = predecessorSlots - missingRepairEntries.size;
  let remainingPluginSlots = pluginSlots - missingRepairEntries.size;
  const plannedPredecessorKeys = new Set(predecessorKeys);
  const selected = selectFairRecentCandidates(
    newCandidates,
    LEGACY_SESSION_SUMMARY_IMPORT_MAX,
    (candidate) => {
      if (remainingSummarySlots < 1 || remainingPluginSlots < 1) {
        return false;
      }
      const key = buildSessionSummaryStoreKey(candidate.agentId, candidate.sessionId);
      const nextSessionId = nextSessionIds.get(key);
      const predecessorKey = nextSessionId
        ? buildSessionSummaryPredecessorIndexKey(candidate.agentId, nextSessionId)
        : undefined;
      const needsPredecessor = Boolean(
        predecessorKey && !plannedPredecessorKeys.has(predecessorKey),
      );
      if (needsPredecessor && (remainingPredecessorSlots < 1 || remainingPluginSlots < 2)) {
        return false;
      }
      remainingSummarySlots -= 1;
      remainingPluginSlots -= needsPredecessor ? 2 : 1;
      if (predecessorKey) {
        plannedPredecessorKeys.add(predecessorKey);
      }
      if (needsPredecessor) {
        remainingPredecessorSlots -= 1;
      }
      return true;
    },
  );
  const importBudget = selected.length;
  if (newCandidates.length > 0 && selected.length === 0) {
    markCandidateError(newCandidates, "plugin state has no legacy session-summary headroom");
  }
  const selectedKeys = new Set(
    selected.map((candidate) =>
      buildSessionSummaryStoreKey(candidate.agentId, candidate.sessionId),
    ),
  );
  for (const candidate of newCandidates) {
    const key = buildSessionSummaryStoreKey(candidate.agentId, candidate.sessionId);
    if (selectedKeys.has(key)) {
      continue;
    }
    for (const occurrence of occurrencesByIdentity.get(key) ?? []) {
      results[occurrence.sourceResultIndex].omittedRows += 1;
    }
  }

  for (const candidate of selected) {
    const key = buildSessionSummaryStoreKey(candidate.agentId, candidate.sessionId);
    const affectedResults = new Set(
      (occurrencesByIdentity.get(key) ?? []).map((occurrence) => occurrence.sourceResultIndex),
    );
    try {
      const imported = await params.repository.importLegacyComplete(
        buildLegacyImportInput(candidate, nextSessionIds.get(key)),
      );
      if (imported.status === "conflict") {
        throw new Error("the deterministic plugin-state key is occupied by an invalid record");
      }
      results[candidate.sourceResultIndex][
        imported.status === "inserted" ? "importedRows" : "existingRows"
      ] += 1;
    } catch (err) {
      for (const resultIndex of affectedResults) {
        const result = results[resultIndex];
        result.archiveReady = false;
        result.errors.push(`session ${candidate.sessionId} could not be imported: ${String(err)}`);
      }
    }
  }

  return {
    sources: results,
    storedEntriesBefore,
    storedPredecessorEntriesBefore,
    importBudget,
    materializedCandidates: occurrences.length,
    materializedSummaryBytes,
  };
}
