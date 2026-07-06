import { describe, expect, it } from "vitest";
import { applySessionStoreMigrations } from "./store-migrations.js";
import type { SessionEntry } from "./types.js";

function createEntry(patch: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "local-session",
    updatedAt: 1,
    ...patch,
  };
}

describe("applySessionStoreMigrations", () => {
  it("canonicalizes provider/runtime fields but drops unsafe retired bindings", () => {
    const legacyBinding = {
      sessionId: "native-streaming-session",
      authProfileId: "claude-cli-streaming:custom-profile",
      authEpoch: "opaque-auth-epoch",
    };
    const store = {
      main: createEntry({
        modelProvider: "claude-cli-streaming",
        providerOverride: "claude-cli-streaming",
        agentHarnessId: "claude-cli-streaming",
        agentRuntimeOverride: "claude-cli-streaming",
        authProfileOverride: "claude-cli-streaming:custom-profile",
        cliSessionIds: { "claude-cli-streaming": "native-streaming-session" },
        cliSessionBindings: { "claude-cli-streaming": legacyBinding },
      }),
    };

    expect(applySessionStoreMigrations(store)).toBe(true);
    expect(store.main).toMatchObject({
      modelProvider: "claude-cli",
      providerOverride: "claude-cli",
      agentHarnessId: "claude-cli",
      agentRuntimeOverride: "claude-cli",
      authProfileOverride: "claude-cli-streaming:custom-profile",
      cliSessionIds: {},
      cliSessionBindings: {},
    });
    expect(store.main.cliSessionIds).not.toHaveProperty("claude-cli-streaming");
    expect(store.main.cliSessionBindings).not.toHaveProperty("claude-cli-streaming");
    expect(store.main.cliSessionIds).not.toHaveProperty("claude-cli");
    expect(store.main.cliSessionBindings).not.toHaveProperty("claude-cli");
    expect(applySessionStoreMigrations(store)).toBe(false);
  });

  it("keeps canonical session ids and bindings when both keys exist", () => {
    const canonicalBinding = {
      sessionId: "canonical-native-session",
      authProfileId: "canonical-profile-id",
    };
    const store = {
      main: createEntry({
        cliSessionIds: {
          "claude-cli": "canonical-native-session",
          "claude-cli-streaming": "legacy-native-session",
        },
        cliSessionBindings: {
          "claude-cli": canonicalBinding,
          "claude-cli-streaming": {
            sessionId: "legacy-native-session",
            authProfileId: "opaque-legacy-profile-id",
          },
        },
      }),
    };

    expect(applySessionStoreMigrations(store)).toBe(true);
    expect(store.main.cliSessionIds).toEqual({
      "claude-cli": "canonical-native-session",
    });
    expect(store.main.cliSessionBindings).toEqual({
      "claude-cli": canonicalBinding,
    });
  });

  it("migrates valid CLI prompt-growth state without dropping continuity overlays", () => {
    const entry = createEntry({ agentRuntimeOverride: "claude-cli" }) as SessionEntry &
      Record<string, unknown>;
    entry.cliCompactionOverlays = {
      "claude-cli": {
        provider: "claude-cli",
        localSessionId: "local-session",
        summary: "durable provider-owned compaction overlay",
        createdAt: 10,
        updatedAt: 20,
      },
    };
    entry.memoryFlushPromptTokens = 123_456.75;
    entry.memoryFlushContextHash = "retired-tail-hash";
    const store = { main: entry };

    expect(applySessionStoreMigrations(store)).toBe(true);
    expect(store.main.memoryFlushCliPromptTokens).toBe(123_456);
    expect(store.main.cliCompactionOverlays).toEqual({
      "claude-cli": {
        provider: "claude-cli",
        localSessionId: "local-session",
        summary: "durable provider-owned compaction overlay",
        createdAt: 10,
        updatedAt: 20,
      },
    });
    expect(store.main).not.toHaveProperty("memoryFlushPromptTokens");
    expect(store.main).not.toHaveProperty("memoryFlushContextHash");
    expect(applySessionStoreMigrations(store)).toBe(false);
  });

  it("anchors legacy continuity overlays to their owning OpenClaw session", () => {
    const entry = createEntry() as SessionEntry & Record<string, unknown>;
    entry.cliCompactionOverlays = {
      "claude-cli": {
        provider: "claude-cli",
        summary: "legacy summary without a local-session anchor",
        createdAt: 10,
        updatedAt: 20,
      },
    } as SessionEntry["cliCompactionOverlays"];

    expect(applySessionStoreMigrations({ main: entry })).toBe(true);
    expect(entry.cliCompactionOverlays?.["claude-cli"]?.localSessionId).toBe("local-session");
    expect(applySessionStoreMigrations({ main: entry })).toBe(false);
  });

  it("canonicalizes retired Claude overlay keys without overwriting a newer overlay", () => {
    const entry = createEntry({
      cliCompactionOverlays: {
        "claude-cli": {
          provider: "claude-cli",
          localSessionId: "local-session",
          summary: "new summary",
          createdAt: 20,
          updatedAt: 20,
        },
        "claude-cli-streaming": {
          provider: "claude-cli-streaming",
          localSessionId: "local-session",
          summary: "legacy summary",
          createdAt: 10,
          updatedAt: 10,
        },
      },
    });

    expect(applySessionStoreMigrations({ main: entry })).toBe(true);
    expect(entry.cliCompactionOverlays).toEqual({
      "claude-cli": {
        provider: "claude-cli",
        localSessionId: "local-session",
        summary: "new summary",
        createdAt: 20,
        updatedAt: 20,
      },
    });
  });

  it("drops invalid or non-CLI legacy prompt-growth state without migrating it", () => {
    const nonCli = createEntry({ modelProvider: "anthropic" }) as SessionEntry &
      Record<string, unknown>;
    nonCli.memoryFlushPromptTokens = 123_456;
    const invalidCli = createEntry({ agentHarnessId: "claude-cli" }) as SessionEntry &
      Record<string, unknown>;
    invalidCli.memoryFlushPromptTokens = -1;
    const dormantCli = createEntry({
      modelProvider: "anthropic",
      cliSessionIds: { "claude-cli": "dormant-native-session" },
      cliSessionBindings: { "claude-cli": { sessionId: "dormant-native-session" } },
      claudeCliSessionId: "dormant-native-session",
    }) as SessionEntry & Record<string, unknown>;
    dormantCli.memoryFlushPromptTokens = 99_999;
    const store = { nonCli, invalidCli, dormantCli };

    expect(applySessionStoreMigrations(store)).toBe(true);
    expect(store.nonCli.memoryFlushCliPromptTokens).toBeUndefined();
    expect(store.invalidCli.memoryFlushCliPromptTokens).toBeUndefined();
    expect(store.dormantCli.memoryFlushCliPromptTokens).toBeUndefined();
    expect(store.nonCli).not.toHaveProperty("memoryFlushPromptTokens");
    expect(store.invalidCli).not.toHaveProperty("memoryFlushPromptTokens");
    expect(store.dormantCli).not.toHaveProperty("memoryFlushPromptTokens");
  });

  it("migrates retired CLI runtime watermarks without overwriting a new receipt", () => {
    const retired = createEntry({
      agentRuntimeOverride: "claude-cli-streaming",
    }) as SessionEntry & Record<string, unknown>;
    retired.memoryFlushPromptTokens = 88_000;
    const alreadyMigrated = createEntry({
      agentRuntimeOverride: "claude-cli",
      memoryFlushCliPromptTokens: 99_000,
    }) as SessionEntry & Record<string, unknown>;
    alreadyMigrated.memoryFlushPromptTokens = 77_000;
    const store = { retired, alreadyMigrated };

    expect(applySessionStoreMigrations(store)).toBe(true);
    expect(store.retired.agentRuntimeOverride).toBe("claude-cli");
    expect(store.retired.memoryFlushCliPromptTokens).toBe(88_000);
    expect(store.alreadyMigrated.memoryFlushCliPromptTokens).toBe(99_000);
    expect(store.retired).not.toHaveProperty("memoryFlushPromptTokens");
    expect(store.alreadyMigrated).not.toHaveProperty("memoryFlushPromptTokens");
    expect(applySessionStoreMigrations(store)).toBe(false);
  });

  it("migrates an active custom CLI backend whose id does not contain cli", () => {
    const entry = createEntry({
      agentRuntimeOverride: "acme-agent",
      cliSessionBindings: { "acme-agent": { sessionId: "native-session" } },
    }) as SessionEntry & Record<string, unknown>;
    entry.memoryFlushPromptTokens = 64_000;
    const store = { main: entry };

    expect(applySessionStoreMigrations(store)).toBe(true);
    expect(store.main.memoryFlushCliPromptTokens).toBe(64_000);
    expect(store.main).not.toHaveProperty("memoryFlushPromptTokens");
  });

  it("leaves unrelated providers unchanged", () => {
    const store = {
      main: createEntry({
        modelProvider: "anthropic",
        providerOverride: "openai",
        agentHarnessId: "codex",
        agentRuntimeOverride: "openclaw",
        cliSessionIds: { "google-gemini-cli": "gemini-session" },
      }),
    };

    expect(applySessionStoreMigrations(store)).toBe(false);
    expect(store.main).toEqual(
      createEntry({
        modelProvider: "anthropic",
        providerOverride: "openai",
        agentHarnessId: "codex",
        agentRuntimeOverride: "openclaw",
        cliSessionIds: { "google-gemini-cli": "gemini-session" },
      }),
    );
  });
});
