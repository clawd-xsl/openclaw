import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_CLAUDE_CLI } from "./legacy-config-migrations.runtime.claude-cli.js";

const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_CLAUDE_CLI[0];

function apply(raw: Record<string, unknown>): string[] {
  const changes: string[] = [];
  migration.apply(raw, changes);
  return changes;
}

describe("retired claude-cli-streaming config migration", () => {
  it("merges the backend into claude-cli with canonical values taking precedence", () => {
    const raw = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "/canonical/claude",
              env: { SHARED: "canonical", CANONICAL_ONLY: "yes" },
            },
            "claude-cli-streaming": {
              command: "/legacy/claude",
              args: ["--legacy-flag"],
              env: { SHARED: "legacy", LEGACY_ONLY: "yes" },
              executionMode: "persistent-process",
              invalidateOnSystemPromptChange: false,
            },
          },
        },
      },
    };

    expect(migration.legacyRules?.[0]?.match?.(raw.agents.defaults.cliBackends, raw)).toBe(true);
    const changes = apply(raw);

    expect(raw.agents.defaults.cliBackends).toEqual({
      "claude-cli": {
        command: "/canonical/claude",
        args: ["--legacy-flag"],
        env: {
          SHARED: "canonical",
          CANONICAL_ONLY: "yes",
          LEGACY_ONLY: "yes",
        },
      },
    });
    expect(changes).toContain(
      "Merged agents.defaults.cliBackends.claude-cli-streaming into agents.defaults.cliBackends.claude-cli; kept explicit canonical values.",
    );
    expect(changes.filter((change) => change.includes("Removed agents.defaults"))).toHaveLength(2);
  });

  it("removes retired fields from an already canonical backend", () => {
    const raw = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
              executionMode: "persistent-process",
              invalidateOnSystemPromptChange: true,
            },
          },
        },
      },
    };

    expect(apply(raw)).toHaveLength(2);
    expect(raw.agents.defaults.cliBackends["claude-cli"]).toEqual({ command: "claude" });
  });

  it("rewrites agent and provider runtime ids without touching other runtimes", () => {
    const raw = {
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli-streaming" },
          models: {
            "anthropic/claude-opus-4-7": {
              agentRuntime: { id: "claude-cli-streaming" },
            },
          },
        },
        list: [
          {
            id: "research",
            agentRuntime: { id: "claude-cli-streaming" },
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
            },
          },
        ],
      },
      models: {
        providers: {
          anthropic: {
            agentRuntime: { id: "claude-cli-streaming" },
            models: [
              {
                id: "claude-opus-4-7",
                name: "Claude Opus 4.7",
                agentRuntime: { id: "claude-cli-streaming" },
              },
            ],
          },
        },
      },
    };

    const runtimeRule = migration.legacyRules?.find((rule) => rule.path.join(".") === "agents");
    expect(runtimeRule?.match?.(raw.agents, raw)).toBe(true);
    const changes = apply(raw);

    expect(raw.agents.defaults.agentRuntime.id).toBe("claude-cli");
    expect(raw.agents.defaults.models["anthropic/claude-opus-4-7"].agentRuntime.id).toBe(
      "claude-cli",
    );
    expect(raw.agents.list[0].agentRuntime.id).toBe("claude-cli");
    expect(raw.agents.list[0].models["openai/gpt-5.5"].agentRuntime.id).toBe("codex");
    expect(raw.models.providers.anthropic.agentRuntime.id).toBe("claude-cli");
    expect(raw.models.providers.anthropic.models[0].agentRuntime.id).toBe("claude-cli");
    expect(changes).toHaveLength(5);
    expect(apply(raw)).toEqual([]);
  });

  it("keeps an explicit malformed canonical value instead of overwriting it", () => {
    const raw = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": false,
            "claude-cli-streaming": { command: "claude" },
          },
        },
      },
    };

    apply(raw);

    expect(raw.agents.defaults.cliBackends).toEqual({ "claude-cli": false });
  });

  it("canonicalizes auth provider references while keeping profile ids opaque", () => {
    const raw = {
      auth: {
        profiles: {
          "claude-cli-streaming:work": {
            provider: "claude-cli-streaming",
            mode: "oauth",
          },
          "opaque-profile-id": {
            provider: "claude-cli-streaming",
            mode: "token",
          },
        },
        order: {
          "claude-cli": ["canonical-profile", "shared-profile"],
          "claude-cli-streaming": [
            "claude-cli-streaming:work",
            "shared-profile",
            "opaque-profile-id",
          ],
        },
        cooldowns: {
          billingBackoffHoursByProvider: {
            "claude-cli": 4,
            "claude-cli-streaming": 9,
          },
        },
      },
    };

    const authRule = migration.legacyRules?.find((rule) => rule.path.join(".") === "auth");
    expect(authRule?.match?.(raw.auth, raw)).toBe(true);
    const changes = apply(raw);

    expect(Object.keys(raw.auth.profiles)).toEqual([
      "claude-cli-streaming:work",
      "opaque-profile-id",
    ]);
    expect(raw.auth.profiles["claude-cli-streaming:work"].provider).toBe("claude-cli");
    expect(raw.auth.profiles["opaque-profile-id"].provider).toBe("claude-cli");
    expect(raw.auth.order).toEqual({
      "claude-cli": [
        "canonical-profile",
        "shared-profile",
        "claude-cli-streaming:work",
        "opaque-profile-id",
      ],
    });
    expect(raw.auth.cooldowns.billingBackoffHoursByProvider).toEqual({ "claude-cli": 4 });
    expect(changes).toContain(
      "Merged auth.order.claude-cli-streaming into auth.order.claude-cli; kept canonical order first and de-duplicated profile ids.",
    );
    expect(apply(raw)).toEqual([]);
  });

  it("produces a current, valid backend and auth config shape", () => {
    const result = migrateLegacyConfig({
      auth: {
        profiles: {
          "claude-cli-streaming:work": {
            provider: "claude-cli-streaming",
            mode: "oauth",
          },
        },
        order: { "claude-cli-streaming": ["claude-cli-streaming:work"] },
      },
      agents: {
        defaults: {
          model: "claude-cli-streaming/claude-opus-4-7",
          cliBackends: {
            "claude-cli-streaming": {
              command: "claude",
              output: "jsonl",
              executionMode: "persistent-process",
              invalidateOnSystemPromptChange: false,
            },
          },
        },
      },
    });

    expect(result.partiallyValid).toBeUndefined();
    expect(result.config?.agents?.defaults?.model).toBe("claude-cli/claude-opus-4-7");
    expect(result.config?.agents?.defaults?.cliBackends).toEqual({
      "claude-cli": { command: "claude", output: "jsonl" },
    });
    expect(result.config?.auth).toEqual({
      profiles: {
        "claude-cli-streaming:work": { provider: "claude-cli", mode: "oauth" },
      },
      order: { "claude-cli": ["claude-cli-streaming:work"] },
    });
  });
});
