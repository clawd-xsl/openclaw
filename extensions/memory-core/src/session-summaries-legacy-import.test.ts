import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  importLegacySessionSummarySources,
  LEGACY_SESSION_SUMMARY_IMPORT_MAX,
  LEGACY_SESSION_SUMMARY_PRESELECTION_MAX,
  LEGACY_SESSION_SUMMARY_PRESELECTION_MAX_BYTES,
  type LegacySessionSummarySourceGroup,
} from "./session-summaries-legacy-import.js";
import {
  buildSessionSummaryPredecessorIndexKey,
  SESSION_SUMMARY_LEGACY_IMPORT_FINGERPRINT,
  SessionSummaryRepository,
  type SessionSummaryPredecessorIndexRecord,
  type SessionSummaryRecord,
} from "./session-summaries-store.js";

type LegacyRow = {
  sessionId: string;
  previousSessionId?: string | null;
  sessionKey?: string;
  agentId?: string;
  createdAt: number;
  endedAt: number;
  messageCount?: number;
  summary: string;
  summaryModel?: string | null;
  generatedAt?: number;
};

function createMemoryStore<T>(): PluginStateKeyedStore<T> {
  const values = new Map<string, PluginStateEntry<T>>();
  return {
    async register(key, value) {
      values.set(key, { key, value, createdAt: 1 });
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, { key, value, createdAt: 1 });
      return true;
    },
    async update(key, updateValue) {
      const current = values.get(key);
      const next = updateValue(current?.value);
      if (next === undefined) {
        return false;
      }
      values.set(key, { key, value: next, createdAt: current?.createdAt ?? 1 });
      return true;
    },
    async lookup(key) {
      return values.get(key)?.value;
    },
    async consume(key) {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.values()];
    },
    async clear() {
      values.clear();
    },
  };
}

function createRepository(
  params: {
    store?: PluginStateKeyedStore<SessionSummaryRecord>;
    predecessorStore?: PluginStateKeyedStore<SessionSummaryPredecessorIndexRecord>;
  } = {},
) {
  const store = params.store ?? createMemoryStore<SessionSummaryRecord>();
  const predecessorStore =
    params.predecessorStore ?? createMemoryStore<SessionSummaryPredecessorIndexRecord>();
  return {
    repository: new SessionSummaryRepository({
      now: () => 10_000,
      openStore: () => store,
      openPredecessorIndexStore: () => predecessorStore,
    }),
    predecessorStore,
    store,
  };
}

async function writeLegacySummaryDatabase(params: {
  databasePath: string;
  rows: LegacyRow[];
  schema?: "base" | "agent" | "agent-summary-model" | "unsupported";
}) {
  await fs.mkdir(path.dirname(params.databasePath), { recursive: true });
  const schema = params.schema ?? "agent-summary-model";
  const db = new DatabaseSync(params.databasePath);
  try {
    const agentColumn = schema === "base" ? "" : ", agent_id TEXT NOT NULL";
    const summaryModelColumn = schema === "agent-summary-model" ? ", summary_model TEXT" : "";
    const unsupportedColumn = schema === "unsupported" ? ", future_column TEXT" : "";
    db.exec(`
      CREATE TABLE session_summaries (
        session_id TEXT PRIMARY KEY,
        previous_session_id TEXT,
        session_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        summary TEXT NOT NULL,
        model TEXT,
        generated_at INTEGER NOT NULL
        ${agentColumn}${summaryModelColumn}${unsupportedColumn}
      )
    `);
    if (schema !== "base") {
      db.exec(
        "CREATE INDEX idx_session_summaries_agent_ended ON session_summaries(agent_id, ended_at)",
      );
    }
    db.exec("BEGIN");
    for (const row of params.rows) {
      const columns = [
        "session_id",
        "previous_session_id",
        "session_key",
        "created_at",
        "ended_at",
        "message_count",
        "summary",
        "model",
        "generated_at",
      ];
      const values: Array<string | number | null> = [
        row.sessionId,
        row.previousSessionId ?? null,
        row.sessionKey ?? "agent:main:main",
        row.createdAt,
        row.endedAt,
        row.messageCount ?? 3,
        row.summary,
        "conversation-model",
        row.generatedAt ?? row.endedAt + 1,
      ];
      if (schema !== "base") {
        columns.push("agent_id");
        values.push(row.agentId ?? "main");
      }
      if (schema === "agent-summary-model") {
        columns.push("summary_model");
        values.push(row.summaryModel ?? null);
      }
      db.prepare(
        `INSERT INTO session_summaries (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      ).run(...values);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

function source(legacyPath: string, scopes: LegacySessionSummarySourceGroup["scopes"]) {
  return { legacyPath, scopes };
}

function openReadOnlyDatabase(databasePath: string) {
  return new DatabaseSync(databasePath, { readOnly: true });
}

function importLegacySources(params: Parameters<typeof importLegacySessionSummarySources>[0]) {
  return importLegacySessionSummarySources({
    ...params,
    getPluginStateCapacity:
      params.getPluginStateCapacity ?? (() => ({ liveEntries: 0, maxEntries: 50_000 })),
  });
}

describe("legacy session summary import", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-summaries-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("sanitizes summaries and reverses only a trusted linear lineage", async () => {
    const databasePath = path.join(rootDir, "main.sqlite");
    await writeLegacySummaryDatabase({
      databasePath,
      rows: [
        {
          sessionId: "a",
          createdAt: 100,
          endedAt: 200,
          summary: "A <|im_start|> apiKey=super-secret-value",
          summaryModel: "anthropic/claude-sonnet-4-6",
        },
        {
          sessionId: "b",
          previousSessionId: "a",
          createdAt: 200,
          endedAt: 300,
          summary: "B",
        },
        {
          sessionId: "c",
          previousSessionId: "b",
          createdAt: 300,
          endedAt: 400,
          summary: "C",
        },
      ],
    });
    const { repository } = createRepository();

    const result = await importLegacySources({
      sources: [source(databasePath, [{ agentId: "main", priority: 0 }])],
      openReadOnlyDatabase,
      repository,
    });

    expect(result.sources[0]).toMatchObject({
      recognized: true,
      archiveReady: true,
      importedRows: 3,
      sanitizedRows: 1,
      invalidRows: 0,
      unownedRows: 0,
    });
    const records = await repository.readAllRecords();
    expect(records.find((record) => record.sessionId === "a")).toMatchObject({
      nextSessionId: "b",
      model: "anthropic/claude-sonnet-4-6",
    });
    expect(records.find((record) => record.sessionId === "b")?.nextSessionId).toBe("c");
    expect(records.find((record) => record.sessionId === "c")?.nextSessionId).toBeNull();
    const firstSummary = records.find((record) => record.sessionId === "a")?.summary ?? "";
    expect(firstSummary).not.toContain("<|im_start|>");
    expect(firstSummary).not.toContain("super-secret-value");
    expect(firstSummary).not.toContain("\u0000");
  });

  it("does not create lineage for forks, session-key changes, or reversed time", async () => {
    const databasePath = path.join(rootDir, "main.sqlite");
    await writeLegacySummaryDatabase({
      databasePath,
      rows: [
        { sessionId: "fork-parent", createdAt: 10, endedAt: 20, summary: "parent" },
        {
          sessionId: "fork-a",
          previousSessionId: "fork-parent",
          createdAt: 20,
          endedAt: 30,
          summary: "a",
        },
        {
          sessionId: "fork-b",
          previousSessionId: "fork-parent",
          createdAt: 21,
          endedAt: 31,
          summary: "b",
        },
        { sessionId: "key-parent", createdAt: 40, endedAt: 50, summary: "parent" },
        {
          sessionId: "key-child",
          previousSessionId: "key-parent",
          sessionKey: "agent:main:other",
          createdAt: 50,
          endedAt: 60,
          summary: "child",
        },
        { sessionId: "time-parent", createdAt: 70, endedAt: 90, summary: "parent" },
        {
          sessionId: "time-child",
          previousSessionId: "time-parent",
          createdAt: 80,
          endedAt: 100,
          summary: "child",
        },
      ],
    });
    const { repository } = createRepository();

    await importLegacySources({
      sources: [source(databasePath, [{ agentId: "main", priority: 0 }])],
      openReadOnlyDatabase,
      repository,
    });

    const records = await repository.readAllRecords();
    for (const sessionId of ["fork-parent", "key-parent", "time-parent"]) {
      expect(records.find((record) => record.sessionId === sessionId)?.nextSessionId).toBeNull();
    }
  });

  it("isolates agent-tagged shared databases and rejects ambiguous old schemas", async () => {
    const taggedPath = path.join(rootDir, "tagged.sqlite");
    await writeLegacySummaryDatabase({
      databasePath: taggedPath,
      rows: [
        { sessionId: "main-1", agentId: "main", createdAt: 10, endedAt: 20, summary: "main" },
        { sessionId: "work-1", agentId: "work", createdAt: 11, endedAt: 21, summary: "work" },
      ],
    });
    const { repository } = createRepository();
    const tagged = await importLegacySources({
      sources: [
        source(taggedPath, [
          { agentId: "main", priority: 0 },
          { agentId: "work", priority: 0 },
        ]),
      ],
      openReadOnlyDatabase,
      repository,
    });
    expect(tagged.sources[0]).toMatchObject({
      archiveReady: true,
      importedRows: 2,
      retryCopySafe: true,
      unownedRows: 0,
    });
    expect(
      (await repository.readAllRecords()).map((record) => [record.agentId, record.sessionId]),
    ).toEqual([
      ["main", "main-1"],
      ["work", "work-1"],
    ]);

    const ambiguousPath = path.join(rootDir, "ambiguous.sqlite");
    await writeLegacySummaryDatabase({
      databasePath: ambiguousPath,
      schema: "base",
      rows: [{ sessionId: "unknown", createdAt: 10, endedAt: 20, summary: "unknown" }],
    });
    const ambiguous = await importLegacySources({
      sources: [
        source(ambiguousPath, [
          { agentId: "main", priority: 0 },
          { agentId: "work", priority: 0 },
        ]),
      ],
      openReadOnlyDatabase,
      repository: createRepository().repository,
    });
    expect(ambiguous.sources[0]).toMatchObject({
      recognized: true,
      archiveReady: false,
      retryCopySafe: false,
      importedRows: 0,
      unownedRows: 1,
    });
  });

  it("prefers configured stores over fallback duplicates and is idempotent", async () => {
    const configuredPath = path.join(rootDir, "configured.sqlite");
    const fallbackPath = path.join(rootDir, "fallback.sqlite");
    await writeLegacySummaryDatabase({
      databasePath: configuredPath,
      rows: [{ sessionId: "same", createdAt: 10, endedAt: 20, summary: "configured wins" }],
    });
    await writeLegacySummaryDatabase({
      databasePath: fallbackPath,
      rows: [
        {
          sessionId: "same",
          createdAt: 10,
          endedAt: 30,
          generatedAt: 40,
          summary: "newer fallback loses",
        },
      ],
    });
    const { repository } = createRepository();
    const sources = [
      source(configuredPath, [{ agentId: "main", priority: 0 }]),
      source(fallbackPath, [{ agentId: "main", priority: 100 }]),
    ];

    const first = await importLegacySources({
      sources,
      openReadOnlyDatabase,
      repository,
    });
    const second = await importLegacySources({
      sources,
      openReadOnlyDatabase,
      repository,
    });

    expect(first.sources[0]?.importedRows).toBe(1);
    expect(first.sources[1]?.duplicateRows).toBe(1);
    expect(second.sources[0]?.existingRows).toBe(1);
    expect((await repository.readAllRecords())[0]?.summary).toBe("configured wins");
  });

  it("keeps a 512-entry reserve and selects recent rows fairly across agents", async () => {
    const databasePath = path.join(rootDir, "shared.sqlite");
    await writeLegacySummaryDatabase({
      databasePath,
      rows: [
        { sessionId: "main-old", agentId: "main", createdAt: 10, endedAt: 20, summary: "old" },
        { sessionId: "main-new", agentId: "main", createdAt: 30, endedAt: 40, summary: "new" },
        { sessionId: "work-old", agentId: "work", createdAt: 11, endedAt: 21, summary: "old" },
        { sessionId: "work-new", agentId: "work", createdAt: 31, endedAt: 41, summary: "new" },
      ],
    });
    const { repository, predecessorStore, store } = createRepository();
    for (let index = 0; index < 3_582; index += 1) {
      const sessionId = `current-${index}`;
      const record: SessionSummaryRecord = {
        recordVersion: 1,
        agentId: "seed",
        sessionId,
        sessionKey: "agent:seed:main",
        status: "complete",
        promptVersion: 1,
        summaryVersion: 1,
        transcriptFingerprint: "seed",
        attemptCount: 1,
        revision: 1,
        generationConfigFingerprint: "current:v1",
        lastError: null,
        nextAttemptAt: null,
        nextSessionId: null,
        endedAt: index,
        messageCount: 1,
        extractedMessageCount: 1,
        model: null,
        generatedAt: index,
        summary: "seed",
        skipReason: null,
        processingAt: null,
        leaseExpiresAt: null,
        updatedAt: index,
        sessionFile: null,
        transcriptArchived: false,
      };
      await store.register(`seed:${index}`, record);
      await predecessorStore.register(`seed:${index}`, {
        indexVersion: 1,
        agentId: "seed",
        currentSessionId: sessionId,
        predecessorEndedAt: null,
        predecessorSessionId: null,
        summaryKey: null,
        updatedAt: index,
      });
    }

    const result = await importLegacySources({
      sources: [
        source(databasePath, [
          { agentId: "main", priority: 0 },
          { agentId: "work", priority: 0 },
        ]),
      ],
      openReadOnlyDatabase,
      repository,
    });

    expect(result).toMatchObject({
      storedEntriesBefore: 3_582,
      storedPredecessorEntriesBefore: 3_582,
      importBudget: 2,
    });
    expect(result.sources[0]).toMatchObject({
      archiveReady: true,
      importedRows: 2,
      omittedRows: 2,
    });
    const imported = (await repository.readAllRecords())
      .filter(
        (record) =>
          record.generationConfigFingerprint === SESSION_SUMMARY_LEGACY_IMPORT_FINGERPRINT,
      )
      .map((record) => record.sessionId)
      .toSorted();
    expect(imported).toEqual(["main-new", "work-new"]);
  });

  it("hard-bounds preselection across many agents and source paths", async () => {
    const agentIds = ["alpha", "bravo", "charlie", "delta"];
    const sources: LegacySessionSummarySourceGroup[] = [];
    for (let sourceIndex = 0; sourceIndex < 3; sourceIndex += 1) {
      const databasePath = path.join(rootDir, `source-${sourceIndex}.sqlite`);
      await writeLegacySummaryDatabase({
        databasePath,
        rows: agentIds.flatMap((agentId) =>
          Array.from({ length: 400 }, (_, rowIndex) => ({
            sessionId: `${agentId}-${sourceIndex}-${rowIndex}`,
            previousSessionId:
              sourceIndex === 0 && rowIndex === 399 ? `${agentId}-${sourceIndex}-398` : undefined,
            sessionKey: `agent:${agentId}:main`,
            agentId,
            createdAt: rowIndex * 10,
            endedAt: rowIndex * 10 + 5,
            summary:
              sourceIndex === 0 && rowIndex === 399
                ? "x".repeat(20_000)
                : `${agentId} source ${sourceIndex} row ${rowIndex}`,
          })),
        ),
      });
      sources.push(
        source(
          databasePath,
          agentIds.map((agentId) => ({ agentId, priority: sourceIndex * 100 })),
        ),
      );
    }
    const { repository } = createRepository();

    const result = await importLegacySources({
      sources,
      openReadOnlyDatabase,
      repository,
    });

    expect(result.materializedCandidates).toBe(LEGACY_SESSION_SUMMARY_PRESELECTION_MAX);
    expect(result.materializedSummaryBytes).toBeLessThanOrEqual(
      LEGACY_SESSION_SUMMARY_PRESELECTION_MAX_BYTES,
    );
    expect(result.sources.reduce((total, entry) => total + entry.importedRows, 0)).toBe(2_048);
    const importedByAgent = new Map<string, number>();
    for (const record of await repository.readAllRecords()) {
      importedByAgent.set(record.agentId, (importedByAgent.get(record.agentId) ?? 0) + 1);
    }
    for (const agentId of agentIds) {
      expect(importedByAgent.get(agentId)).toBe(512);
    }
    expect(
      (await repository.readAllRecords()).find((record) => record.sessionId === "alpha-0-398")
        ?.nextSessionId,
    ).toBeNull();
    expect(
      (await repository.readAllRecords()).every(
        (record) => Buffer.byteLength(record.summary ?? "", "utf8") <= 8 * 1_024,
      ),
    ).toBe(true);
  });

  it("fails closed when plugin-state preflight fails while preserving shared ownership", async () => {
    const databasePath = path.join(rootDir, "shared-preflight.sqlite");
    await writeLegacySummaryDatabase({
      databasePath,
      rows: [
        { sessionId: "main", agentId: "main", createdAt: 10, endedAt: 20, summary: "main" },
        { sessionId: "work", agentId: "work", createdAt: 11, endedAt: 21, summary: "work" },
      ],
    });
    const { repository } = createRepository();
    vi.spyOn(repository, "readAllRecordEntries").mockRejectedValueOnce(
      new Error("state database unavailable"),
    );

    const result = await importLegacySources({
      sources: [
        source(databasePath, [
          { agentId: "main", priority: 0 },
          { agentId: "work", priority: 0 },
        ]),
      ],
      openReadOnlyDatabase,
      repository,
    });

    expect(result.sources[0]).toMatchObject({
      recognized: true,
      retryCopySafe: true,
      archiveReady: false,
      importedRows: 0,
    });
    expect(result.sources[0]?.errors.join("\n")).toContain("state database unavailable");
  });

  it("does not import when the plugin-wide reserve has no headroom", async () => {
    const databasePath = path.join(rootDir, "plugin-cap.sqlite");
    await writeLegacySummaryDatabase({
      databasePath,
      rows: [{ sessionId: "legacy", createdAt: 10, endedAt: 20, summary: "legacy" }],
    });
    const { repository } = createRepository();

    const result = await importLegacySources({
      sources: [source(databasePath, [{ agentId: "main", priority: 0 }])],
      openReadOnlyDatabase,
      repository,
      getPluginStateCapacity: () => ({ liveEntries: 49_000, maxEntries: 50_000 }),
    });

    expect(result).toMatchObject({ importBudget: 0 });
    expect(result.sources[0]).toMatchObject({ archiveReady: false, importedRows: 0 });
    expect(result.sources[0]?.errors.join("\n")).toContain("no legacy session-summary headroom");
    await expect(repository.readAllRecords()).resolves.toEqual([]);
  });

  it("repairs a crash-separated predecessor index before allowing archival", async () => {
    const databasePath = path.join(rootDir, "crash-repair.sqlite");
    await writeLegacySummaryDatabase({
      databasePath,
      rows: [
        { sessionId: "a", createdAt: 10, endedAt: 20, summary: "a" },
        {
          sessionId: "b",
          previousSessionId: "a",
          createdAt: 20,
          endedAt: 30,
          summary: "b",
        },
      ],
    });
    const store = createMemoryStore<SessionSummaryRecord>();
    const predecessorStore = createMemoryStore<SessionSummaryPredecessorIndexRecord>();
    const update = predecessorStore.update;
    if (!update) {
      throw new Error("expected predecessor test store to support updates");
    }
    let failNextIndexWrite = true;
    predecessorStore.update = async (...args) => {
      if (failNextIndexWrite) {
        failNextIndexWrite = false;
        throw new Error("simulated index write crash");
      }
      return await update(...args);
    };
    const { repository } = createRepository({ store, predecessorStore });
    const params = {
      sources: [source(databasePath, [{ agentId: "main", priority: 0 }])],
      openReadOnlyDatabase,
      repository,
    };

    const first = await importLegacySources(params);
    expect(first.sources[0]).toMatchObject({ archiveReady: false });
    expect(first.sources[0]?.errors.join("\n")).toContain("simulated index write crash");

    const second = await importLegacySources(params);
    expect(second.sources[0]).toMatchObject({ archiveReady: true, existingRows: 2 });
    await expect(
      repository.findDirectPredecessor({
        agentId: "main",
        currentSessionId: "b",
        lookbackDays: 365_000,
      }),
    ).resolves.toMatchObject({ sessionId: "a" });
  });

  it("redacts a private key that crosses the bounded SQLite read prefix", async () => {
    const databasePath = path.join(rootDir, "partial-private-key.sqlite");
    const secretFragment = "private-material-fragment";
    await writeLegacySummaryDatabase({
      databasePath,
      rows: [
        {
          sessionId: "secret",
          createdAt: 10,
          endedAt: 20,
          summary: `safe\n-----BEGIN PRIVATE KEY-----\n${secretFragment.repeat(600)}\n-----END PRIVATE KEY-----`,
        },
      ],
    });
    const { repository } = createRepository();

    const result = await importLegacySources({
      sources: [source(databasePath, [{ agentId: "main", priority: 0 }])],
      openReadOnlyDatabase,
      repository,
    });

    expect(result.sources[0]).toMatchObject({ archiveReady: true, sanitizedRows: 1 });
    const summary = (await repository.readAllRecords())[0]?.summary ?? "";
    expect(summary).toContain("[REDACTED PARTIAL PRIVATE KEY]");
    expect(summary).not.toContain(secretFragment);
    expect(summary).not.toContain("-----BEGIN PRIVATE KEY-----");
  });

  it("bounds corrupt metadata reads and blocks archival on every parser rejection", async () => {
    const databasePath = path.join(rootDir, "bounded-metadata.sqlite");
    await writeLegacySummaryDatabase({
      databasePath,
      rows: [
        { sessionId: "oversized", createdAt: 10, endedAt: 20, summary: "oversized" },
        { sessionId: "nul", createdAt: 50, endedAt: 60, summary: "nul" },
        { sessionId: "dynamic-type", createdAt: 70, endedAt: 80, summary: "dynamic" },
        {
          sessionId: "summary-nul",
          createdAt: 90,
          endedAt: 100,
          summary: "safe\u0000important-tail",
        },
      ],
    });
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare("UPDATE session_summaries SET session_key = ? WHERE session_id = 'oversized'").run(
        "x".repeat(2 * 1_024 * 1_024),
      );
      db.prepare("UPDATE session_summaries SET session_key = ? WHERE session_id = 'nul'").run(
        "agent:main:\u0000main",
      );
      db.prepare(
        "UPDATE session_summaries SET generated_at = ? WHERE session_id = 'dynamic-type'",
      ).run(Buffer.alloc(2 * 1_024 * 1_024, 1));
    } finally {
      db.close();
    }

    const { repository } = createRepository();
    const result = await importLegacySources({
      sources: [source(databasePath, [{ agentId: "main", priority: 0 }])],
      openReadOnlyDatabase,
      repository,
    });

    expect(result.sources[0]).toMatchObject({
      archiveReady: false,
      importedRows: 0,
      invalidRows: 4,
      ownedRows: 4,
    });
    await expect(repository.readAllRecords()).resolves.toEqual([]);
  });

  it("blocks archival when UTF-8 metadata exceeds the conservative SQL-wide limit", async () => {
    const databasePath = path.join(rootDir, "unicode-metadata.sqlite");
    await writeLegacySummaryDatabase({
      databasePath,
      rows: [{ sessionId: "unicode", createdAt: 30, endedAt: 40, summary: "unicode" }],
    });
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare("UPDATE session_summaries SET session_id = ? WHERE session_id = 'unicode'").run(
        "😀".repeat(300),
      );
    } finally {
      db.close();
    }

    const { repository } = createRepository();
    const result = await importLegacySources({
      sources: [source(databasePath, [{ agentId: "main", priority: 0 }])],
      openReadOnlyDatabase,
      repository,
    });

    expect(result.sources[0]).toMatchObject({
      archiveReady: false,
      importedRows: 0,
      invalidRows: 1,
      ownedRows: 1,
    });
    await expect(repository.readAllRecords()).resolves.toEqual([]);
  });

  it("repairs every importer-owned index even when its source row falls outside preselection", async () => {
    const databasePath = path.join(rootDir, "crash-repair-outside-window.sqlite");
    const rows = Array.from({ length: LEGACY_SESSION_SUMMARY_IMPORT_MAX + 1 }, (_, index) => ({
      sessionId: index === 0 ? "outside-window" : `recent-${index}`,
      createdAt: index * 10,
      endedAt: index * 10 + 5,
      summary: `summary ${index}`,
    }));
    await writeLegacySummaryDatabase({ databasePath, rows });
    const { repository, predecessorStore } = createRepository();
    await repository.importLegacyComplete({
      agentId: "main",
      sessionId: "outside-window",
      sessionKey: "agent:main:main",
      nextSessionId: "after-outside-window",
      endedAt: 5,
      messageCount: 1,
      summary: "already imported",
      model: null,
      generatedAt: 6,
    });
    await predecessorStore.delete(
      buildSessionSummaryPredecessorIndexKey("main", "after-outside-window"),
    );

    const result = await importLegacySources({
      sources: [source(databasePath, [{ agentId: "main", priority: 0 }])],
      openReadOnlyDatabase,
      repository,
    });

    expect(result.sources[0]).toMatchObject({ archiveReady: true });
    await expect(
      repository.findDirectPredecessor({
        agentId: "main",
        currentSessionId: "after-outside-window",
        lookbackDays: 365_000,
      }),
    ).resolves.toMatchObject({ sessionId: "outside-window" });
  });

  it("blocks archival for unsupported schemas and when no import headroom remains", async () => {
    const unsupportedPath = path.join(rootDir, "unsupported.sqlite");
    await writeLegacySummaryDatabase({
      databasePath: unsupportedPath,
      schema: "unsupported",
      rows: [{ sessionId: "future", createdAt: 10, endedAt: 20, summary: "future" }],
    });
    const unsupported = await importLegacySources({
      sources: [source(unsupportedPath, [{ agentId: "main", priority: 0 }])],
      openReadOnlyDatabase,
      repository: createRepository().repository,
    });
    expect(unsupported.sources[0]).toMatchObject({ recognized: true, archiveReady: false });
    expect(unsupported.sources[0]?.errors.join("\n")).toContain("unsupported column layout");

    const fullPath = path.join(rootDir, "full.sqlite");
    await writeLegacySummaryDatabase({
      databasePath: fullPath,
      rows: [{ sessionId: "legacy", createdAt: 10, endedAt: 20, summary: "legacy" }],
    });
    const { repository, store } = createRepository();
    for (let index = 0; index < 3_584; index += 1) {
      await store.register(`occupied:${index}`, null as unknown as SessionSummaryRecord);
    }
    const noHeadroom = await importLegacySources({
      sources: [source(fullPath, [{ agentId: "main", priority: 0 }])],
      openReadOnlyDatabase,
      repository,
    });
    expect(noHeadroom).toMatchObject({ importBudget: 0 });
    expect(noHeadroom.sources[0]).toMatchObject({ archiveReady: false, importedRows: 0 });
    expect(noHeadroom.sources[0]?.errors.join("\n")).toContain(
      "no legacy session-summary headroom",
    );
  });
});
