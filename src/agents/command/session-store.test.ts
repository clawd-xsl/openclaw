import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, type SessionEntry } from "../../config/sessions.js";
import type { EmbeddedPiRunResult } from "../pi-embedded.js";
import { updateSessionStoreAfterAgentRun } from "./session-store.js";

describe("updateSessionStoreAfterAgentRun", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists claude-cli session bindings when the backend is configured", async () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
            },
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:explicit:test-claude-cli";
    const sessionId = "test-openclaw-session";
    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: 1,
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

    const result: EmbeddedPiRunResult = {
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "cli-session-123",
          provider: "claude-cli",
          model: "claude-sonnet-4-6",
          cliSessionBinding: {
            sessionId: "cli-session-123",
          },
        },
      },
    };

    await updateSessionStoreAfterAgentRun({
      cfg,
      sessionId,
      sessionKey,
      storePath,
      sessionStore,
      defaultProvider: "claude-cli",
      defaultModel: "claude-sonnet-4-6",
      result,
    });

    expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]).toEqual({
      sessionId: "cli-session-123",
    });
    expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe("cli-session-123");
    expect(sessionStore[sessionKey]?.claudeCliSessionId).toBe("cli-session-123");

    const persisted = loadSessionStore(storePath);
    expect(persisted[sessionKey]?.cliSessionBindings?.["claude-cli"]).toEqual({
      sessionId: "cli-session-123",
    });
    expect(persisted[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe("cli-session-123");
    expect(persisted[sessionKey]?.claudeCliSessionId).toBe("cli-session-123");
  });

  it("persists claude-cli-streaming session bindings under the streaming provider key", async () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli-streaming": {
              command: "claude",
            },
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:explicit:test-claude-cli-streaming";
    const sessionId = "test-openclaw-session";
    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: 1,
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

    const result: EmbeddedPiRunResult = {
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "stream-session-123",
          provider: "claude-cli-streaming",
          model: "claude-sonnet-4-6",
          cliSessionBinding: {
            sessionId: "stream-session-123",
          },
        },
      },
    };

    await updateSessionStoreAfterAgentRun({
      cfg,
      sessionId,
      sessionKey,
      storePath,
      sessionStore,
      defaultProvider: "claude-cli-streaming",
      defaultModel: "claude-sonnet-4-6",
      result,
    });

    expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli-streaming"]).toEqual({
      sessionId: "stream-session-123",
    });
    expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli-streaming"]).toBe(
      "stream-session-123",
    );
    expect(sessionStore[sessionKey]?.claudeCliSessionId).toBeUndefined();

    const persisted = loadSessionStore(storePath);
    expect(persisted[sessionKey]?.cliSessionBindings?.["claude-cli-streaming"]).toEqual({
      sessionId: "stream-session-123",
    });
    expect(persisted[sessionKey]?.cliSessionIds?.["claude-cli-streaming"]).toBe(
      "stream-session-123",
    );
    expect(persisted[sessionKey]?.claudeCliSessionId).toBeUndefined();
  });

  it("clears cli session bindings when the runner marks the session unusable", async () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli-streaming": {
              command: "claude",
            },
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:explicit:test-clear-cli-session";
    const sessionId = "test-openclaw-session";
    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: 1,
        cliSessionIds: { "claude-cli-streaming": "old-stream-session" },
        cliSessionBindings: {
          "claude-cli-streaming": {
            sessionId: "old-stream-session",
          },
        },
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

    const result: EmbeddedPiRunResult = {
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "empty-stream-session",
          provider: "claude-cli-streaming",
          model: "claude-sonnet-4-6",
          clearCliSession: true,
        },
      },
    };

    await updateSessionStoreAfterAgentRun({
      cfg,
      sessionId,
      sessionKey,
      storePath,
      sessionStore,
      defaultProvider: "claude-cli-streaming",
      defaultModel: "claude-sonnet-4-6",
      result,
    });

    expect(sessionStore[sessionKey]?.cliSessionBindings).toBeUndefined();
    expect(sessionStore[sessionKey]?.cliSessionIds).toBeUndefined();

    const persisted = loadSessionStore(storePath);
    expect(persisted[sessionKey]?.cliSessionBindings).toBeUndefined();
    expect(persisted[sessionKey]?.cliSessionIds).toBeUndefined();
  });
});
