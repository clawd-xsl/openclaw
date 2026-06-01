import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { upsertAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import * as jsonFiles from "../../infra/json-files.js";
import { createSuiteTempRootTracker, withTempDirSync } from "../../test-helpers/temp-dir.js";
import type { OpenClawConfig } from "../config.js";
import type { SessionConfig } from "../types.base.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPathInDir,
  validateSessionId,
} from "./paths.js";
import { evaluateSessionFreshness, resolveSessionResetPolicy } from "./reset.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import { clearSessionStoreCacheForTest, loadSessionStore, updateSessionStore } from "./store.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { mergeSessionEntry, type SessionEntry } from "./types.js";

describe("session path safety", () => {
  it("rejects unsafe session IDs", () => {
    const unsafeSessionIds = ["../etc/passwd", "a/b", "a\\b", "/abs"];
    for (const sessionId of unsafeSessionIds) {
      expect(() => validateSessionId(sessionId), sessionId).toThrow(/Invalid session ID/);
    }
  });

  it("resolves transcript path inside an explicit sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";
    const resolved = resolveSessionTranscriptPathInDir("sess-1", sessionsDir, "topic/a+b");

    expect(resolved).toBe(path.resolve(sessionsDir, "sess-1-topic-topic%2Fa%2Bb.jsonl"));
  });

  it("falls back to derived path when sessionFile is outside known agent sessions dirs", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: "/tmp/openclaw/agents/work/not-sessions/abc-123.jsonl" },
      { sessionsDir },
    );
    expect(resolved).toBe(path.resolve(sessionsDir, "sess-1.jsonl"));
  });

  it("ignores multi-store sentinel paths when deriving session file options", () => {
    expect(resolveSessionFilePathOptions({ agentId: "worker", storePath: "(multiple)" })).toEqual({
      agentId: "worker",
    });
    expect(resolveSessionFilePathOptions({ storePath: "(multiple)" })).toBeUndefined();
  });

  it("accepts symlink-alias session paths that resolve under the sessions dir", () => {
    if (process.platform === "win32") {
      return;
    }
    withTempDirSync({ prefix: "openclaw-symlink-session-" }, (tmpDir) => {
      const realRoot = path.join(tmpDir, "real-state");
      const aliasRoot = path.join(tmpDir, "alias-state");
      const sessionsDir = path.join(realRoot, "agents", "main", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.symlinkSync(realRoot, aliasRoot, "dir");
      const viaAlias = path.join(aliasRoot, "agents", "main", "sessions", "sess-1.jsonl");
      fs.writeFileSync(path.join(sessionsDir, "sess-1.jsonl"), "");
      const resolved = resolveSessionFilePath("sess-1", { sessionFile: viaAlias }, { sessionsDir });
      expect(fs.realpathSync(resolved)).toBe(
        fs.realpathSync(path.join(sessionsDir, "sess-1.jsonl")),
      );
    });
  });

  it("falls back when sessionFile is a symlink that escapes sessions dir", () => {
    if (process.platform === "win32") {
      return;
    }
    withTempDirSync({ prefix: "openclaw-symlink-escape-" }, (tmpDir) => {
      const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
      const outsideDir = path.join(tmpDir, "outside");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });
      const outsideFile = path.join(outsideDir, "escaped.jsonl");
      fs.writeFileSync(outsideFile, "");
      const symlinkPath = path.join(sessionsDir, "escaped.jsonl");
      fs.symlinkSync(outsideFile, symlinkPath, "file");

      const resolved = resolveSessionFilePath(
        "sess-1",
        { sessionFile: symlinkPath },
        { sessionsDir },
      );
      expect(fs.realpathSync(path.dirname(resolved))).toBe(fs.realpathSync(sessionsDir));
      expect(path.basename(resolved)).toBe("sess-1.jsonl");
    });
  });
});

describe("resolveSessionResetPolicy", () => {
  describe("backward compatibility: resetByType.dm -> direct", () => {
    it("does not use dm fallback for group/thread types", () => {
      const sessionCfg = {
        resetByType: {
          dm: { mode: "idle" as const, idleMinutes: 45 },
        },
      } as unknown as SessionConfig;

      const groupPolicy = resolveSessionResetPolicy({
        sessionCfg,
        resetType: "group",
      });

      expect(groupPolicy.mode).toBe("daily");
    });
  });

  it("defaults to daily resets at 4am local time", () => {
    const policy = resolveSessionResetPolicy({
      resetType: "direct",
    });

    expect(policy).toMatchObject({
      mode: "daily",
      atHour: 4,
    });
  });

  it("treats idleMinutes=0 as never expiring by inactivity", () => {
    const freshness = evaluateSessionFreshness({
      updatedAt: 1_000,
      now: 60 * 60 * 1_000,
      policy: {
        mode: "idle",
        atHour: 4,
        idleMinutes: 0,
      },
    });

    expect(freshness).toEqual({
      fresh: true,
      dailyResetAt: undefined,
      idleExpiresAt: undefined,
    });
  });
});

describe("session store lock (Promise chain mutex)", () => {
  const lockFixtureRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-lock-test-" });
  let lockTmpDirs: string[] = [];

  async function makeTmpStore(
    initial: Record<string, unknown> = {},
  ): Promise<{ dir: string; storePath: string }> {
    const dir = await lockFixtureRootTracker.make("case");
    lockTmpDirs.push(dir);
    const storePath = path.join(dir, "sessions.json");
    if (Object.keys(initial).length > 0) {
      await fsPromises.writeFile(storePath, JSON.stringify(initial, null, 2), "utf-8");
    }
    return { dir, storePath };
  }

  beforeAll(async () => {
    await lockFixtureRootTracker.setup();
  });

  afterAll(async () => {
    await lockFixtureRootTracker.cleanup();
  });

  afterEach(async () => {
    clearSessionStoreCacheForTest();
    lockTmpDirs = [];
  });

  it("serializes concurrent updateSessionStore calls without data loss", async () => {
    const key = "agent:main:test";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100, counter: 0 },
    });

    const N = 4;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        updateSessionStore(storePath, async (store) => {
          const entry = store[key] as Record<string, unknown>;
          await Promise.resolve();
          entry.counter = (entry.counter as number) + 1;
          entry.tag = `writer-${i}`;
        }),
      ),
    );

    const store = loadSessionStore(storePath);
    expect((store[key] as Record<string, unknown>).counter).toBe(N);
  });

  it("skips session store disk writes when payload is unchanged", async () => {
    const key = "agent:main:no-op-save";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s-noop", updatedAt: Date.now() },
    });

    await updateSessionStore(
      storePath,
      async () => {
        // Warm the hot projection; the assertion below is about repeated no-op saves.
      },
      { skipMaintenance: true },
    );

    const writeSpy = vi.spyOn(jsonFiles, "writeTextAtomic");
    await updateSessionStore(
      storePath,
      async () => {
        // Intentionally no-op mutation.
      },
      { skipMaintenance: true },
    );
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it("compacts prompt snapshots only in persisted session store JSON", async () => {
    const key = "agent:main:prompt-snapshot-bloat";
    const { storePath } = await makeTmpStore();
    let liveEntry: SessionEntry | undefined;

    await updateSessionStore(
      storePath,
      async (store) => {
        store[key] = {
          sessionId: "sess-prompt-snapshot-bloat",
          updatedAt: Date.now(),
          skillsSnapshot: {
            prompt: "large rendered skills prompt payload that should not persist",
            skills: [{ name: "large-skill", primaryEnv: "LARGE_SKILL_API_KEY" }],
            resolvedSkills: [{ name: "large-skill" }] as never,
            version: 7,
          },
          systemPromptReport: {
            source: "run",
            generatedAt: Date.now(),
            bootstrapTruncation: {
              warningMode: "once",
              warningSignaturesSeen: ["sig-a"],
            },
            systemPrompt: {
              chars: 12_000,
              projectContextChars: 8_000,
              nonProjectContextChars: 4_000,
            },
            injectedWorkspaceFiles: [
              {
                name: "AGENTS.md",
                path: "/workspace/AGENTS.md",
                missing: false,
                rawChars: 6_000,
                injectedChars: 3_000,
                truncated: true,
              },
            ],
            skills: {
              promptChars: 5_000,
              entries: [{ name: "large-skill", blockChars: 5_000 }],
            },
            tools: {
              listChars: 10_000,
              schemaChars: 20_000,
              entries: [
                {
                  name: "large_tool",
                  summaryChars: 1_000,
                  schemaChars: 9_000,
                },
              ],
            },
          },
        };
        liveEntry = store[key];
      },
      { skipMaintenance: true },
    );

    expect(liveEntry?.skillsSnapshot?.prompt).toContain("large rendered skills prompt");
    expect(liveEntry?.skillsSnapshot?.resolvedSkills).toHaveLength(1);
    expect(liveEntry?.systemPromptReport?.injectedWorkspaceFiles).toHaveLength(1);

    const raw = await fsPromises.readFile(storePath, "utf8");
    expect(raw).not.toContain("large rendered skills prompt payload");
    expect(raw).not.toContain("resolvedSkills");
    expect(raw).not.toContain("/workspace/AGENTS.md");
    expect(raw).not.toContain("large_tool");

    const persisted = loadSessionStore(storePath, { skipCache: true })[key];
    expect(persisted?.skillsSnapshot).toMatchObject({
      prompt: "",
      skills: [{ name: "large-skill", primaryEnv: "LARGE_SKILL_API_KEY" }],
      version: 7,
    });
    expect(persisted?.skillsSnapshot?.resolvedSkills).toBeUndefined();
    expect(persisted?.systemPromptReport?.bootstrapTruncation?.warningSignaturesSeen).toEqual([
      "sig-a",
    ]);
    expect(persisted?.systemPromptReport?.systemPrompt.chars).toBe(12_000);
    expect(persisted?.systemPromptReport?.injectedWorkspaceFiles).toEqual([]);
    expect(persisted?.systemPromptReport?.skills.entries).toEqual([]);
    expect(persisted?.systemPromptReport?.tools.entries).toEqual([]);
  });

  it("multiple consecutive errors do not permanently poison the queue", async () => {
    const key = "agent:main:multi-err";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100 },
    });

    const errors = Array.from({ length: 3 }, (_, i) =>
      updateSessionStore(storePath, async () => {
        throw new Error(`fail-${i}`);
      }),
    );

    const success = updateSessionStore(storePath, async (store) => {
      store[key] = { ...store[key], modelOverride: "recovered" } as unknown as SessionEntry;
    });

    for (const p of errors) {
      await expect(p).rejects.toThrow();
    }
    await success;

    const store = loadSessionStore(storePath);
    expect(store[key]?.modelOverride).toBe("recovered");
  });

  it("clears stale runtime provider when model is patched without provider", () => {
    const merged = mergeSessionEntry(
      {
        sessionId: "sess-runtime",
        updatedAt: 100,
        modelProvider: "anthropic",
        model: "claude-opus-4-6",
      },
      {
        model: "gpt-5.4",
      },
    );
    expect(merged.model).toBe("gpt-5.4");
    expect(merged.modelProvider).toBeUndefined();
  });

  it("normalizes orphan modelProvider fields at store write boundary", async () => {
    const key = "agent:main:orphan-provider";
    const { storePath } = await makeTmpStore({
      [key]: {
        sessionId: "sess-orphan",
        updatedAt: 100,
        modelProvider: "anthropic",
      },
    });

    await updateSessionStore(storePath, async (store) => {
      const entry = store[key];
      entry.updatedAt = Date.now();
    });

    const store = loadSessionStore(storePath);
    expect(store[key]?.modelProvider).toBeUndefined();
    expect(store[key]?.model).toBeUndefined();
  });

  it("preserves ACP metadata when replacing a session entry wholesale", async () => {
    const key = "agent:codex:acp:binding:discord:default:feedface";
    const acp = {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "codex-discord",
      mode: "persistent" as const,
      state: "idle" as const,
      lastActivityAt: 100,
    };
    const { storePath } = await makeTmpStore({
      [key]: {
        sessionId: "sess-acp",
        updatedAt: 100,
        acp,
      },
    });

    await updateSessionStore(storePath, (store) => {
      store[key] = {
        sessionId: "sess-acp",
        updatedAt: 200,
        modelProvider: "openai-codex",
        model: "gpt-5.4",
      };
    });

    const store = loadSessionStore(storePath);
    expect(store[key]?.acp).toEqual(acp);
    expect(store[key]?.modelProvider).toBe("openai-codex");
    expect(store[key]?.model).toBe("gpt-5.4");
  });

  it("allows explicit ACP metadata removal through the ACP session helper", async () => {
    const key = "agent:codex:acp:binding:discord:default:deadbeef";
    const { storePath } = await makeTmpStore({
      [key]: {
        sessionId: "sess-acp-clear",
        updatedAt: 100,
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-discord",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 100,
        },
      },
    });
    const cfg = {
      session: {
        store: storePath,
      },
    } as OpenClawConfig;

    const result = await upsertAcpSessionMeta({
      cfg,
      sessionKey: key,
      mutate: () => null,
    });

    expect(result?.acp).toBeUndefined();
    const store = loadSessionStore(storePath);
    expect(store[key]?.acp).toBeUndefined();
  });
});

describe("resolveAndPersistSessionFile", () => {
  const fixture = useTempSessionsFixture("session-file-test-");

  it("persists fallback topic transcript paths for sessions without sessionFile", async () => {
    const sessionId = "topic-session-id";
    const sessionKey = "agent:main:telegram:group:123:topic:456";
    const store = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");
    const sessionStore = loadSessionStore(fixture.storePath(), { skipCache: true });
    const fallbackSessionFile = resolveSessionTranscriptPathInDir(
      sessionId,
      fixture.sessionsDir(),
      456,
    );

    const result = await resolveAndPersistSessionFile({
      sessionId,
      sessionKey,
      sessionStore,
      storePath: fixture.storePath(),
      sessionEntry: sessionStore[sessionKey],
      fallbackSessionFile,
    });

    expect(result.sessionFile).toBe(fallbackSessionFile);

    const saved = loadSessionStore(fixture.storePath(), { skipCache: true });
    expect(saved[sessionKey]?.sessionFile).toBe(fallbackSessionFile);
  });

  it("creates and persists entry when session is not yet present", async () => {
    const sessionId = "new-session-id";
    const sessionKey = "agent:main:telegram:group:123";
    fs.writeFileSync(fixture.storePath(), JSON.stringify({}), "utf-8");
    const sessionStore = loadSessionStore(fixture.storePath(), { skipCache: true });
    const fallbackSessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());

    const result = await resolveAndPersistSessionFile({
      sessionId,
      sessionKey,
      sessionStore,
      storePath: fixture.storePath(),
      fallbackSessionFile,
    });

    expect(result.sessionFile).toBe(fallbackSessionFile);
    expect(result.sessionEntry.sessionId).toBe(sessionId);
    const saved = loadSessionStore(fixture.storePath(), { skipCache: true });
    expect(saved[sessionKey]?.sessionFile).toBe(fallbackSessionFile);
  });
});
