import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION } from "./legacy-config-migrations.runtime.session.js";

const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION.find(
  (entry) => entry.id === "agents.session.summary*->plugins.entries.memory-core.config.summaries",
);

function apply(raw: Record<string, unknown>): string[] {
  const changes: string[] = [];
  migration!.apply(raw, changes);
  return changes;
}

describe("legacy agents.session summary migration", () => {
  it("moves legacy behavior to memory-core and canonicalizes the retired Claude backend", () => {
    const raw = {
      agents: {
        session: {
          summaryModel: " claude-cli-streaming/claude-opus-4-7 ",
          summaryDays: 5_000,
          summaryMaxChars: 12_000,
        },
      },
    };

    expect(migration!.legacyRules?.[0]?.match?.(raw.agents.session, raw)).toBe(true);
    const changes = apply(raw);

    expect(raw).toEqual({
      agents: {},
      plugins: {
        entries: {
          "memory-core": {
            llm: {
              allowAgentIdOverride: true,
              allowModelOverride: true,
            },
            config: {
              summaries: {
                enabled: true,
                autoInject: true,
                model: "claude-cli/claude-opus-4-7",
                lookbackDays: 3_650,
              },
            },
          },
        },
      },
    });
    expect(changes).toEqual([
      "Moved agents.session summary settings to plugins.entries.memory-core.config.summaries; preserved explicit target values and legacy defaults.",
      "Removed agents.session.summaryMaxChars; memory-core maxPromptTokens has different semantics, so no token limit was inferred.",
    ]);
  });

  it("uses the old model and seven-day defaults without mapping the character cap", () => {
    const raw = {
      agents: { session: { summaryMaxChars: 8_000 } },
    };

    apply(raw);

    expect(raw).toEqual({
      agents: {},
      plugins: {
        entries: {
          "memory-core": {
            llm: {
              allowAgentIdOverride: true,
              allowModelOverride: true,
            },
            config: {
              summaries: {
                enabled: true,
                autoInject: true,
                model: "anthropic/claude-sonnet-4-6",
                lookbackDays: 7,
              },
            },
          },
        },
      },
    });
  });

  it("keeps every explicit target value and only fills missing fields", () => {
    const raw = {
      agents: {
        session: {
          summaryModel: "claude-cli-streaming/claude-opus-4-7",
          summaryDays: 14,
          summaryMaxChars: 9_000,
          futureField: true,
        },
      },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              summaries: {
                enabled: false,
                autoInject: false,
                model: "openai/gpt-5.5",
                lookbackDays: 30,
                maxPromptTokens: 4_096,
                minMessages: 9,
              },
            },
          },
        },
      },
    };

    const changes = apply(raw);

    expect(raw.agents.session).toEqual({ futureField: true });
    expect(raw.plugins.entries["memory-core"]).toEqual({
      config: {
        summaries: {
          enabled: false,
          autoInject: false,
          model: "openai/gpt-5.5",
          lookbackDays: 30,
          maxPromptTokens: 4_096,
          minMessages: 9,
        },
      },
    });
    expect(raw.plugins.entries["memory-core"]).not.toHaveProperty("llm");
    expect(changes).toContain(
      "Kept plugins.entries.memory-core.config.summaries.enabled=false; no LLM override permissions were added.",
    );
  });

  it("does not grant LLM overrides when the plugin is explicitly disabled", () => {
    const raw = {
      agents: { session: { summaryDays: 14 } },
      plugins: {
        entries: {
          "memory-core": { enabled: false },
        },
      },
    };

    const changes = apply(raw);

    expect(raw.plugins.entries["memory-core"]).not.toHaveProperty("llm");
    const memoryCore = raw.plugins.entries["memory-core"] as {
      config?: { summaries?: { enabled?: boolean } };
    };
    expect(memoryCore.config?.summaries?.enabled).toBe(true);
    expect(changes).toContain(
      "Kept plugins.entries.memory-core.enabled=false; migrated summaries remain inactive and no LLM override permissions were added.",
    );
  });

  it("keeps explicit false LLM policy while active and explains the limitation", () => {
    const raw = {
      agents: { session: { summaryDays: 14 } },
      plugins: {
        entries: {
          "memory-core": {
            llm: {
              allowAgentIdOverride: false,
              allowModelOverride: false,
            },
          },
        },
      },
    };

    const changes = apply(raw);

    expect(raw.plugins.entries["memory-core"].llm).toEqual({
      allowAgentIdOverride: false,
      allowModelOverride: false,
    });
    expect(changes).toContain(
      "Kept plugins.entries.memory-core.llm.allowAgentIdOverride=false; migrated summaries cannot generate until this policy is enabled.",
    );
    expect(changes).toContain(
      "Kept plugins.entries.memory-core.llm.allowModelOverride=false; migrated summaries.model cannot be used until this policy is enabled.",
    );
  });

  it("is idempotent after removing the legacy fields", () => {
    const raw = { agents: { session: { summaryDays: 2 } } };

    expect(apply(raw)).toHaveLength(1);
    expect(apply(raw)).toEqual([]);
    expect(migration!.legacyRules?.[0]?.match?.(raw.agents.session, raw)).toBe(false);
  });

  it("produces a current, valid memory-core config shape", () => {
    const result = migrateLegacyConfig({
      agents: {
        session: {
          summaryModel: "claude-cli-streaming/claude-sonnet-4-6",
          summaryDays: 7,
          summaryMaxChars: 8_000,
        },
      },
    });
    const memoryCore = result.config?.plugins?.entries?.["memory-core"] as
      | { config?: Record<string, unknown>; llm?: Record<string, unknown> }
      | undefined;

    expect(result.partiallyValid).toBeUndefined();
    expect(memoryCore?.llm).toEqual({
      allowAgentIdOverride: true,
      allowModelOverride: true,
    });
    expect(memoryCore?.config?.summaries).toEqual({
      enabled: true,
      autoInject: true,
      model: "claude-cli/claude-sonnet-4-6",
      lookbackDays: 7,
    });
  });
});
