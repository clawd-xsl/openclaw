import { afterEach, describe, expect, it } from "vitest";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  resetCliAuthEpochTestDeps,
  resolveCliAuthEpoch,
  setCliAuthEpochTestDeps,
} from "./cli-auth-epoch.js";

describe("resolveCliAuthEpoch", () => {
  afterEach(() => {
    resetCliAuthEpochTestDeps();
  });

  it("returns undefined when no local or auth-profile credentials exist", async () => {
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => null,
      readCodexCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => ({
        version: 1,
        profiles: {},
      }),
    });

    await expect(resolveCliAuthEpoch({ provider: "claude-cli" })).resolves.toBeUndefined();
    await expect(
      resolveCliAuthEpoch({
        provider: "google-gemini-cli",
        authProfileId: "google:work",
      }),
    ).resolves.toBeUndefined();
  });

  it("stays stable when claude cli only rotates access token and expiry", async () => {
    let access = "access-a";
    let expires = 1;
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => ({
        type: "oauth",
        provider: "anthropic",
        access,
        refresh: "refresh",
        expires,
      }),
    });

    const first = await resolveCliAuthEpoch({ provider: "claude-cli" });
    access = "access-b";
    expires = 2;
    const second = await resolveCliAuthEpoch({ provider: "claude-cli" });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).toBe(first);
  });

  it("stays stable when the claude cli refresh token changes", async () => {
    let refresh = "refresh-a";
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => ({
        type: "oauth",
        provider: "anthropic",
        access: "access",
        refresh,
        expires: 1,
      }),
    });

    const first = await resolveCliAuthEpoch({ provider: "claude-cli" });
    refresh = "refresh-b";
    const second = await resolveCliAuthEpoch({ provider: "claude-cli" });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).toBe(first);
  });

  it("treats claude-cli-streaming as the same local Claude credential source", async () => {
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => ({
        type: "oauth",
        provider: "anthropic",
        access: "streaming-access",
        refresh: "refresh",
        expires: 1,
      }),
    });

    await expect(resolveCliAuthEpoch({ provider: "claude-cli-streaming" })).resolves.toBeDefined();
  });

  it("stays stable when auth profile oauth only rotates access token and expiry", async () => {
    let store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access-a",
          refresh: "refresh",
          expires: 1,
        },
      },
    };
    setCliAuthEpochTestDeps({
      loadAuthProfileStoreForRuntime: () => store,
    });

    const first = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });
    store = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access-b",
          refresh: "refresh",
          expires: 2,
        },
      },
    };
    const second = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).toBe(first);
  });

  it("changes when auth profile oauth refresh token changes", async () => {
    let refresh = "refresh-a";
    setCliAuthEpochTestDeps({
      loadAuthProfileStoreForRuntime: () => ({
        version: 1,
        profiles: {
          "anthropic:work": {
            type: "oauth",
            provider: "anthropic",
            access: "access",
            refresh,
            expires: 1,
          },
        },
      }),
    });

    const first = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });
    refresh = "refresh-b";
    const second = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("mixes local codex and auth-profile state", async () => {
    let access = "local-access-a";
    let refresh = "profile-refresh-a";
    let localRefresh = "local-refresh-a";
    setCliAuthEpochTestDeps({
      readCodexCliCredentialsCached: () => ({
        type: "oauth",
        provider: "openai-codex",
        access,
        refresh: localRefresh,
        expires: 1,
        accountId: "acct-1",
      }),
      loadAuthProfileStoreForRuntime: () => ({
        version: 1,
        profiles: {
          "openai:work": {
            type: "oauth",
            provider: "openai",
            access: "profile-access",
            refresh,
            expires: 1,
          },
        },
      }),
    });

    const first = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });
    access = "local-access-b";
    const second = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });
    localRefresh = "local-refresh-b";
    const third = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });
    refresh = "profile-refresh-b";
    const fourth = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    expect(fourth).toBeDefined();
    expect(second).toBe(first);
    expect(third).not.toBe(second);
    expect(fourth).not.toBe(third);
  });
});
