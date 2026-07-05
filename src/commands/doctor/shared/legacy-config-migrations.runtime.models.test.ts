// Runtime model migration tests cover doctor legacy config migrations for model runtime shape.
import { describe, it, expect } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS } from "./legacy-config-migrations.runtime.models.js";

describe("stale contextWindow migration", () => {
  const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS.find(
    (m) => m.id === "models.providers.*.models.*.contextWindow-stale",
  );

  it("repairs deepseek-v4-flash contextWindow from 200K to 1M", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          deepseek: {
            models: [
              {
                id: "deepseek-v4-flash",
                contextWindow: 200_000,
                maxTokens: 61_440,
              },
            ],
          },
        },
      },
    };

    expect(migration!.legacyRules?.[0]?.match?.(raw.models.providers, raw)).toBe(true);

    migration!.apply(raw, changes);

    expect(raw.models.providers.deepseek.models[0].contextWindow).toBe(1_000_000);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("200000 → 1000000");
    expect(migration!.legacyRules?.[0]?.match?.(raw.models.providers, raw)).toBe(false);
  });

  it("does not modify correct contextWindow values", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          deepseek: {
            models: [
              {
                id: "deepseek-v4-flash",
                contextWindow: 1_000_000,
                maxTokens: 61_440,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(raw.models.providers.deepseek.models[0].contextWindow).toBe(1_000_000);
    expect(changes).toHaveLength(0);
  });

  it("preserves non-stale custom contextWindow values", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          deepseek: {
            models: [
              {
                id: "deepseek-v4-flash",
                contextWindow: 500_000,
                maxTokens: 61_440,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(raw.models.providers.deepseek.models[0].contextWindow).toBe(500_000);
    expect(changes).toHaveLength(0);
  });

  it("does not modify bare ids from other providers", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          custom: {
            models: [
              {
                id: "deepseek-v4-flash",
                contextWindow: 200_000,
                maxTokens: 61_440,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(raw.models.providers.custom.models[0].contextWindow).toBe(200_000);
    expect(changes).toHaveLength(0);
    expect(migration!.legacyRules?.[0]?.match?.(raw.models.providers, raw)).toBe(false);
  });

  it("handles provider-prefixed model IDs under the native provider", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          deepseek: {
            models: [
              {
                id: "deepseek/deepseek-v4-flash",
                contextWindow: 200_000,
                maxTokens: 61_440,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(raw.models.providers.deepseek.models[0].contextWindow).toBe(1_000_000);
    expect(changes).toHaveLength(1);
  });

  it("does not modify provider-prefixed ids from other providers", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          openrouter: {
            models: [
              {
                id: "deepseek/deepseek-v4-flash",
                contextWindow: 200_000,
                maxTokens: 61_440,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(raw.models.providers.openrouter.models[0].contextWindow).toBe(200_000);
    expect(changes).toHaveLength(0);
    expect(migration!.legacyRules?.[0]?.match?.(raw.models.providers, raw)).toBe(false);
  });

  it("skips models not in the stale fixes registry", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-4o",
                contextWindow: 128_000,
                maxTokens: 16_384,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(raw.models.providers.openai.models[0].contextWindow).toBe(128_000);
    expect(changes).toHaveLength(0);
  });

  it("handles missing providers gracefully", () => {
    const changes: string[] = [];
    const raw = {};

    migration!.apply(raw, changes);

    expect(changes).toHaveLength(0);
  });

  it("handles non-array models gracefully", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          deepseek: {
            models: "not-an-array",
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(changes).toHaveLength(0);
  });

  it("handles missing model id gracefully", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          deepseek: {
            models: [
              {
                contextWindow: 200_000,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(changes).toHaveLength(0);
  });
});

describe("retired claude-cli-streaming model refs", () => {
  const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS.find(
    (entry) => entry.id === "models.retired-model-refs",
  );

  it("rewrites every configured model-ref shape and keeps canonical map values", () => {
    const raw = {
      agents: {
        session: { summaryModel: "claude-cli-streaming/claude-sonnet-4-6" },
        defaults: {
          model: {
            primary: "claude-cli-streaming/claude-opus-4-7@claude:work",
            fallbacks: ["claude-cli-streaming/claude-sonnet-4-6"],
          },
          voiceModel: "claude-cli-streaming/claude-sonnet-4-6",
          models: {
            "claude-cli/claude-opus-4-7": { alias: "canonical" },
            "claude-cli-streaming/claude-opus-4-7": {
              alias: "legacy",
              streaming: false,
            },
          },
        },
        list: [
          {
            id: "research",
            heartbeat: { model: "claude-cli-streaming/claude-opus-4-7" },
          },
        ],
      },
      channels: {
        modelByChannel: {
          discord: { "*": "claude-cli-streaming/claude-sonnet-4-6" },
        },
      },
      hooks: {
        mappings: [{ model: "claude-cli-streaming/claude-opus-4-7" }],
      },
      messages: {
        tts: { summaryModel: "claude-cli-streaming/claude-sonnet-4-6" },
      },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              summaries: { model: "claude-cli-streaming/claude-opus-4-7" },
            },
          },
        },
      },
    };

    const agentsRule = migration!.legacyRules?.find((rule) => rule.path[0] === "agents");
    expect(agentsRule?.match?.(raw.agents, raw)).toBe(true);

    const changes: string[] = [];
    migration!.apply(raw, changes);

    expect(raw.agents.session.summaryModel).toBe("claude-cli/claude-sonnet-4-6");
    expect(raw.agents.defaults.model).toEqual({
      primary: "claude-cli/claude-opus-4-7@claude:work",
      fallbacks: ["claude-cli/claude-sonnet-4-6"],
    });
    expect(raw.agents.defaults.voiceModel).toBe("claude-cli/claude-sonnet-4-6");
    expect(raw.agents.defaults.models).toEqual({
      "claude-cli/claude-opus-4-7": { alias: "canonical", streaming: false },
    });
    expect(raw.agents.list[0].heartbeat.model).toBe("claude-cli/claude-opus-4-7");
    expect(raw.channels.modelByChannel.discord["*"]).toBe("claude-cli/claude-sonnet-4-6");
    expect(raw.hooks.mappings[0].model).toBe("claude-cli/claude-opus-4-7");
    expect(raw.messages.tts.summaryModel).toBe("claude-cli/claude-sonnet-4-6");
    expect(raw.plugins.entries["memory-core"].config.summaries.model).toBe(
      "claude-cli/claude-opus-4-7",
    );
    expect(changes).toContain(
      'Merged config.agents.defaults.models key "claude-cli-streaming/claude-opus-4-7" into "claude-cli/claude-opus-4-7"; kept existing values for conflicting fields: alias.',
    );

    const repeatChanges: string[] = [];
    migration!.apply(raw, repeatChanges);
    expect(repeatChanges).toEqual([]);
  });
});
