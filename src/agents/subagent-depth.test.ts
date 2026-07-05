// Subagent depth tests cover depth recovery from persisted session metadata and
// timer-safe timeout normalization for spawned agent runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import { clearSessionStoreCaches } from "../config/sessions/store-cache.js";
import {
  closeSessionStoreSqliteDatabasesForTest,
  getSessionStoreSqliteStatsForTest,
  resetSessionStoreSqliteStatsForTest,
} from "../config/sessions/store-sqlite.js";
import { saveSessionStore } from "../config/sessions/store.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { resolveAgentTimeoutMs } from "./timeout.js";

describe("getSubagentDepthFromSessionStore", () => {
  it("uses spawnDepth from the session store when available", () => {
    const key = "agent:main:subagent:flat";
    const depth = getSubagentDepthFromSessionStore(key, {
      store: {
        [key]: { spawnDepth: 2 },
      },
    });
    expect(depth).toBe(2);
  });

  it("normalizes signed decimal stored spawnDepth strings", () => {
    const key = "agent:main:subagent:flat";
    const depth = getSubagentDepthFromSessionStore(key, {
      store: {
        [key]: { spawnDepth: "+02" },
      },
    });
    expect(depth).toBe(2);
  });

  it("ignores non-decimal and unsafe stored spawnDepth strings", () => {
    const key = "agent:main:subagent:flat";
    for (const spawnDepth of ["1e3", "0x10", "1.5", "9007199254740993"]) {
      const depth = getSubagentDepthFromSessionStore(key, {
        store: {
          [key]: { spawnDepth },
        },
      });
      expect(depth).toBe(1);
    }
  });

  it("derives depth from spawnedBy ancestry when spawnDepth is missing", () => {
    // Ancestry fallback keeps restored sessions useful when old stores predate
    // the explicit spawnDepth field.
    const key1 = "agent:main:subagent:one";
    const key2 = "agent:main:subagent:two";
    const key3 = "agent:main:subagent:three";
    const depth = getSubagentDepthFromSessionStore(key3, {
      store: {
        [key1]: { spawnedBy: "agent:main:main" },
        [key2]: { spawnedBy: key1 },
        [key3]: { spawnedBy: key2 },
      },
    });
    expect(depth).toBe(3);
  });

  it("resolves depth when caller is identified by sessionId", () => {
    const key1 = "agent:main:subagent:one";
    const key2 = "agent:main:subagent:two";
    const key3 = "agent:main:subagent:three";
    const depth = getSubagentDepthFromSessionStore("subagent-three-session", {
      store: {
        [key1]: { sessionId: "subagent-one-session", spawnedBy: "agent:main:main" },
        [key2]: { sessionId: "subagent-two-session", spawnedBy: key1 },
        [key3]: { sessionId: "subagent-three-session", spawnedBy: key2 },
      },
    });
    expect(depth).toBe(3);
  });

  it("resolves prefixed store keys when caller key omits the agent prefix", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-depth-"));
    const storeTemplate = path.join(tmpDir, "sessions-{agentId}.json");
    const prefixedKey = "agent:main:subagent:flat";
    const storePath = storeTemplate.replaceAll("{agentId}", "main");
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [prefixedKey]: {
            sessionId: "subagent-flat",
            updatedAt: Date.now(),
            spawnDepth: 2,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const depth = getSubagentDepthFromSessionStore("subagent:flat", {
      cfg: {
        session: {
          store: storeTemplate,
        },
      },
    });

    expect(depth).toBe(2);
  });

  it("accepts JSON5 syntax in the on-disk depth store for backward compatibility", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-depth-json5-"));
    const storeTemplate = path.join(tmpDir, "sessions-{agentId}.json");
    const storePath = storeTemplate.replaceAll("{agentId}", "main");
    fs.writeFileSync(
      storePath,
      `{
        // hand-edited legacy store
        "agent:main:subagent:flat": {
          sessionId: "subagent-flat",
          spawnDepth: 2,
        },
      }`,
      "utf-8",
    );

    const depth = getSubagentDepthFromSessionStore("subagent:flat", {
      cfg: {
        session: {
          store: storeTemplate,
        },
      },
    });

    expect(depth).toBe(2);
  });

  it("recovers persisted lineage from the default SQLite store with point reads", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-depth-sqlite-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const parentKey = "agent:main:subagent:parent";
      const childKey = "agent:main:subagent:child";
      const storePath = resolveDefaultSessionStorePath("main");
      await saveSessionStore(
        storePath,
        {
          [parentKey]: {
            sessionId: "subagent-parent-session",
            updatedAt: 1,
            spawnDepth: 1,
          },
          [childKey]: {
            sessionId: "subagent-child-session",
            updatedAt: 2,
            spawnedBy: parentKey,
          },
        },
        { skipMaintenance: true },
      );

      // Drop both database handles and metadata caches to model a fresh process.
      closeSessionStoreSqliteDatabasesForTest();
      clearSessionStoreCaches();
      resetSessionStoreSqliteStatsForTest();

      expect(getSubagentDepthFromSessionStore(childKey, { cfg: {} })).toBe(2);
      expect(getSessionStoreSqliteStatsForTest()).toMatchObject({
        selectAll: 0,
        selectByKey: 2,
      });
    } finally {
      closeSessionStoreSqliteDatabasesForTest();
      clearSessionStoreCaches();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("falls back to session-key segment counting when metadata is missing", () => {
    const key = "agent:main:subagent:flat";
    const depth = getSubagentDepthFromSessionStore(key, {
      store: {
        [key]: {},
      },
    });
    expect(depth).toBe(1);
  });
});

describe("resolveAgentTimeoutMs", () => {
  it("defaults to 48 hours when config does not override the timeout", () => {
    expect(resolveAgentTimeoutMs({})).toBe(48 * 60 * 60 * 1000);
  });

  it("uses a timer-safe sentinel for no-timeout overrides", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 0 })).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs({ overrideMs: 0 })).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("clamps very large timeout overrides to timer-safe values", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 9_999_999 })).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs({ overrideMs: 9_999_999_999 })).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
