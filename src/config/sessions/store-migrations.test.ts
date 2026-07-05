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
