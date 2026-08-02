/**
 * Regression coverage for CLI session persistence helpers.
 * Verifies provider-keyed bindings, legacy Claude state, and reuse invalidation.
 */
import { describe, expect, it } from "vitest";
import type { CliSessionReseedReceipt, SessionEntry } from "../config/sessions.js";
import {
  normalizeCliSessionReseedReceipt,
  rebindCliSessionReseedReceiptsForReset,
} from "../config/sessions/cli-session-binding.js";
import {
  clearCliCompactionOverlay,
  clearAllCliSessions,
  clearCliSession,
  getCliCompactionOverlay,
  getCliSessionBinding,
  hashCliSessionText,
  resolveCliSessionReuse,
  setCliCompactionOverlay,
  setCliSessionBinding,
  setCliSessionId,
} from "./cli-session.js";

describe("cli-session helpers", () => {
  it("normalizes provider-scoped continuity overlays", () => {
    const entry: SessionEntry = { sessionId: "openclaw-session", updatedAt: 1 };
    setCliCompactionOverlay(entry, "CLAUDE-CLI", {
      provider: "ignored",
      localSessionId: "openclaw-session",
      summary: "  durable continuity  ",
      tokensBefore: 1000.8,
      tokensAfter: 120.2,
      contextWindowTokens: 200_000,
      thresholdTokens: 176_000,
      createdAt: 10.8,
      updatedAt: 20.9,
    });

    expect(getCliCompactionOverlay(entry, "claude-cli")).toEqual({
      provider: "claude-cli",
      localSessionId: "openclaw-session",
      summary: "durable continuity",
      tokensBefore: 1000,
      tokensAfter: 120,
      contextWindowTokens: 200_000,
      thresholdTokens: 176_000,
      createdAt: 10,
      updatedAt: 20,
    });
    clearCliCompactionOverlay(entry, "claude-cli");
    expect(entry.cliCompactionOverlays).toBeUndefined();
  });

  it("rejects continuity overlays anchored to another OpenClaw session", () => {
    const entry: SessionEntry = { sessionId: "new-session", updatedAt: 1 };
    setCliCompactionOverlay(entry, "claude-cli", {
      provider: "claude-cli",
      localSessionId: "old-session",
      summary: "stale summary",
      createdAt: 1,
      updatedAt: 1,
    });

    expect(
      getCliCompactionOverlay(entry, "claude-cli", { localSessionId: "new-session" }),
    ).toBeUndefined();
    expect(entry.cliCompactionOverlays?.["claude-cli"]?.summary).toBe("stale summary");
  });
  it("persists binding metadata alongside legacy session ids", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };

    setCliSessionBinding(entry, "claude-cli", {
      sessionId: "cli-session-1",
      forceReuse: true,
      authProfileId: "anthropic:work",
      extraSystemPromptHash: "prompt-hash",
      messageToolPolicyHash: "message-policy-hash",
      promptToolNamesHash: "prompt-tools-hash",
      cwdHash: "cwd-hash",
      mcpConfigHash: "mcp-hash",
      mcpResumeHash: "mcp-resume-hash",
      reseedReceipt: {
        version: 1,
        promptHash: "a".repeat(64),
        localSessionId: "openclaw-session",
        userTurnDisposition: "persisted",
      },
    });

    expect(entry.cliSessionIds?.["claude-cli"]).toBe("cli-session-1");
    expect(entry.claudeCliSessionId).toBe("cli-session-1");
    expect(getCliSessionBinding(entry, "claude-cli")).toEqual({
      sessionId: "cli-session-1",
      forceReuse: true,
      authProfileId: "anthropic:work",
      extraSystemPromptHash: "prompt-hash",
      messageToolPolicyHash: "message-policy-hash",
      promptToolNamesHash: "prompt-tools-hash",
      cwdHash: "cwd-hash",
      mcpConfigHash: "mcp-hash",
      mcpResumeHash: "mcp-resume-hash",
      reseedReceipt: {
        version: 1,
        promptHash: "a".repeat(64),
        localSessionId: "openclaw-session",
        userTurnDisposition: "persisted",
      },
    });
  });

  it("drops malformed reseed receipts while preserving the session binding", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };

    setCliSessionBinding(entry, "claude-cli", {
      sessionId: "cli-session-1",
      reseedReceipt: {
        version: 1,
        promptHash: "not-a-digest",
        localSessionId: "openclaw-session",
        userTurnDisposition: "persisted",
      },
    });

    expect(getCliSessionBinding(entry, "claude-cli")).toEqual({
      sessionId: "cli-session-1",
      authProfileId: undefined,
      extraSystemPromptHash: undefined,
      messageToolPolicyHash: undefined,
      promptToolNamesHash: undefined,
      cwdHash: undefined,
      mcpConfigHash: undefined,
      mcpResumeHash: undefined,
      reseedReceipt: undefined,
    });
  });

  it("rejects reseed receipts without a local session owner", () => {
    expect(
      normalizeCliSessionReseedReceipt({
        version: 1,
        promptHash: "a".repeat(64),
      } as CliSessionReseedReceipt),
    ).toBeUndefined();
  });

  it("rejects reseed receipts without a user-turn disposition", () => {
    expect(
      normalizeCliSessionReseedReceipt({
        version: 1,
        promptHash: "a".repeat(64),
        localSessionId: "openclaw-session",
      } as CliSessionReseedReceipt),
    ).toBeUndefined();
  });

  it("rebinds only omitted receipts across binding-preserving resets", () => {
    const bindings = {
      "claude-cli": {
        sessionId: "claude-session",
        reseedReceipt: {
          version: 1 as const,
          promptHash: "a".repeat(64),
          localSessionId: "old-local-session",
          userTurnDisposition: "omitted" as const,
        },
      },
      "other-cli": {
        sessionId: "other-session",
        reseedReceipt: {
          version: 1 as const,
          promptHash: "b".repeat(64),
          localSessionId: "old-local-session",
          userTurnDisposition: "persisted" as const,
        },
      },
    };

    expect(rebindCliSessionReseedReceiptsForReset(bindings, "new-local-session")).toEqual({
      "claude-cli": {
        sessionId: "claude-session",
        reseedReceipt: {
          version: 1,
          promptHash: "a".repeat(64),
          localSessionId: "new-local-session",
          userTurnDisposition: "omitted",
        },
      },
      "other-cli": bindings["other-cli"],
    });
    expect(bindings["claude-cli"].reseedReceipt.localSessionId).toBe("old-local-session");
  });

  it("preserves receipts only while updating the same native CLI session", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };
    const receipt = {
      version: 1 as const,
      promptHash: "a".repeat(64),
      localSessionId: "openclaw-session",
      userTurnDisposition: "persisted" as const,
    };

    setCliSessionBinding(entry, "claude-cli", {
      sessionId: "cli-session-1",
      reseedReceipt: receipt,
    });
    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-session-1" });
    expect(getCliSessionBinding(entry, "claude-cli")?.reseedReceipt).toEqual(receipt);

    setCliSessionId(entry, "claude-cli", "cli-session-1");
    expect(getCliSessionBinding(entry, "claude-cli")?.reseedReceipt).toEqual(receipt);

    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-session-2" });
    expect(getCliSessionBinding(entry, "claude-cli")?.reseedReceipt).toBeUndefined();
  });

  it("force-reuses explicitly attached CLI sessions despite metadata drift", () => {
    const binding = {
      sessionId: "cli-session-1",
      forceReuse: true,
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-config-a",
      mcpResumeHash: "mcp-resume-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        extraSystemPromptHash: "prompt-b",
        mcpConfigHash: "mcp-config-b",
        mcpResumeHash: "mcp-resume-b",
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it("keeps legacy bindings reusable until richer metadata is persisted", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      cliSessionIds: { "claude-cli": "legacy-session" },
      claudeCliSessionId: "legacy-session",
    };

    expect(
      resolveCliSessionReuse({
        binding: getCliSessionBinding(entry, "claude-cli"),
        cwdHash: hashCliSessionText("/work/repo"),
      }),
    ).toEqual({ mode: "reuse", sessionId: "legacy-session" });
  });

  it("resumes legacy bindings with drift on content changes", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      cliSessionIds: { "claude-cli": "legacy-session" },
      claudeCliSessionId: "legacy-session",
    };
    const binding = getCliSessionBinding(entry, "claude-cli");

    expect(
      resolveCliSessionReuse({
        binding,
        extraSystemPromptHash: "prompt-hash",
      }),
    ).toEqual({
      mode: "reuse-with-drift",
      sessionId: "legacy-session",
      drift: { reasons: ["system-prompt"] },
    });
    expect(
      resolveCliSessionReuse({
        binding,
        mcpConfigHash: "mcp-hash",
      }),
    ).toEqual({
      mode: "reuse-with-drift",
      sessionId: "legacy-session",
      drift: { reasons: ["mcp"] },
    });
  });

  it("ignores auth changes and resumes with drift on prompt or MCP shape changes", () => {
    // Auth profile/epoch are not reuse identity: the CLI child owns its own
    // credentials, and gating on them cost an empty reseed per rotation.
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
    expect(
      resolveCliSessionReuse({
        binding,
        extraSystemPromptHash: "prompt-b",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session-1",
      drift: { reasons: ["system-prompt"] },
    });
    expect(
      resolveCliSessionReuse({
        binding,
        extraSystemPromptHash: "prompt-a",
        promptToolNamesHash: "prompt-tools-b",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session-1",
      drift: { reasons: ["prompt-tools"] },
    });
    expect(
      resolveCliSessionReuse({
        binding,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-b",
      }),
    ).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session-1",
      drift: { reasons: ["mcp"] },
    });
  });

  it("keeps content-drift bindings reusable for queued turns until hashes refresh", () => {
    const binding = {
      sessionId: "cli-session-1",
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };
    const current = {
      binding,
      extraSystemPromptHash: "prompt-b",
      mcpConfigHash: "mcp-a",
    };

    expect(resolveCliSessionReuse(current)).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session-1",
      drift: { reasons: ["system-prompt"] },
    });
    expect(resolveCliSessionReuse(current)).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session-1",
      drift: { reasons: ["system-prompt"] },
    });
    expect(
      resolveCliSessionReuse({
        ...current,
        binding: { ...binding, extraSystemPromptHash: "prompt-b" },
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it("invalidates profile-scoped sessions when the auth profile changes", () => {
    // google-gemini-cli stages a per-profile CLI home, so its native session
    // physically lives under the profile that created it and cannot resume
    // from another profile's home.
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "google:personal",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "google:work",
        sessionBoundToAuthProfile: true,
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "auth-profile" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "google:personal",
        sessionBoundToAuthProfile: true,
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it("resumes with drift when message-tool prompt policy changes", () => {
    const binding = {
      sessionId: "cli-session-1",
      messageToolPolicyHash: "message-policy-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        messageToolPolicyHash: "message-policy-b",
      }),
    ).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session-1",
      drift: { reasons: ["message-policy"] },
    });
    expect(
      resolveCliSessionReuse({
        binding,
        messageToolPolicyHash: "message-policy-a",
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it("invalidates reuse when the task cwd changes", () => {
    const binding = {
      sessionId: "cli-session-1",
      cwdHash: hashCliSessionText("/work/repo-a"),
    };

    expect(
      resolveCliSessionReuse({
        binding,
        cwdHash: hashCliSessionText("/work/repo-b"),
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "cwd" });
    expect(
      resolveCliSessionReuse({
        binding,
        cwdHash: hashCliSessionText("/work/repo-a"),
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it("does not invalidate legacy metadata before cwd hash backfill", () => {
    expect(
      resolveCliSessionReuse({
        binding: { sessionId: "cli-session-1" },
        cwdHash: hashCliSessionText("/work/repo-a"),
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it("prefers the stable MCP resume hash over the raw MCP config hash", () => {
    const binding = {
      sessionId: "cli-session-1",
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-config-a",
      mcpResumeHash: "mcp-resume-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-config-b",
        mcpResumeHash: "mcp-resume-a",
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
    expect(
      resolveCliSessionReuse({
        binding,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-config-a",
        mcpResumeHash: "mcp-resume-b",
      }),
    ).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session-1",
      drift: { reasons: ["mcp"] },
    });
  });

  it("falls back to legacy MCP config hashes when stored resume hashes are absent", () => {
    const binding = {
      sessionId: "cli-session-1",
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-config-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-config-a",
        mcpResumeHash: "mcp-resume-a",
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
    expect(
      resolveCliSessionReuse({
        binding,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-config-b",
        mcpResumeHash: "mcp-resume-a",
      }),
    ).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session-1",
      drift: { reasons: ["mcp"] },
    });
  });

  it("clears provider-scoped and global CLI session state", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };
    setCliSessionBinding(entry, "claude-cli", { sessionId: "claude-session" });
    setCliSessionBinding(entry, "codex-cli", { sessionId: "codex-session" });

    clearCliSession(entry, "codex-cli");
    expect(getCliSessionBinding(entry, "codex-cli")).toBeUndefined();
    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe("claude-session");

    clearAllCliSessions(entry);
    expect(entry.cliSessionBindings).toBeUndefined();
    expect(entry.cliSessionIds).toBeUndefined();
    expect(entry.claudeCliSessionId).toBeUndefined();
  });

  it("hashes trimmed extra system prompts consistently", () => {
    expect(hashCliSessionText("  keep this  ")).toBe(hashCliSessionText("keep this"));
    expect(hashCliSessionText("")).toBeUndefined();
  });
});
