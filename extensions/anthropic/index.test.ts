import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";

const { readClaudeCliCredentialsForSetupMock, readClaudeCliCredentialsForRuntimeMock } = vi.hoisted(
  () => ({
    readClaudeCliCredentialsForSetupMock: vi.fn(),
    readClaudeCliCredentialsForRuntimeMock: vi.fn(),
  }),
);

vi.mock("./cli-auth-seam.js", () => {
  return {
    readClaudeCliCredentialsForSetup: readClaudeCliCredentialsForSetupMock,
    readClaudeCliCredentialsForRuntime: readClaudeCliCredentialsForRuntimeMock,
  };
});

import anthropicPlugin from "./index.js";

function createModelRegistry(models: ProviderRuntimeModel[]) {
  return {
    find(providerId: string, modelId: string) {
      return (
        models.find(
          (model) =>
            model.provider === providerId && model.id.toLowerCase() === modelId.toLowerCase(),
        ) ?? null
      );
    },
  };
}

describe("anthropic provider replay hooks", () => {
  it("registers both Claude CLI backends", async () => {
    const captured = capturePluginRegistration({ register: anthropicPlugin.register });

    expect(captured.cliBackends).toContainEqual(
      expect.objectContaining({
        id: "claude-cli",
        bundleMcp: true,
        config: expect.objectContaining({
          command: "claude",
          modelArg: "--model",
          sessionArg: "--session-id",
        }),
      }),
    );
    expect(captured.cliBackends).toContainEqual(
      expect.objectContaining({
        id: "claude-cli-streaming",
        bundleMcp: true,
        config: expect.objectContaining({
          command: "claude",
          executionMode: "persistent-process",
          modelArg: "--model",
          sessionArg: "--session-id",
        }),
      }),
    );
  });

  it("augments the catalog with Claude CLI synthetic models", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const entries = await provider.augmentModelCatalog?.({
      config: {},
      env: {},
      entries: [
        {
          provider: "anthropic",
          id: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1_048_576,
        },
        {
          provider: "anthropic",
          id: "claude-opus-4-5",
          name: "Claude Opus 4.5",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 200_000,
        },
        {
          provider: "anthropic",
          id: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 200_000,
        },
        {
          provider: "anthropic",
          id: "claude-haiku-4-5",
          name: "Claude Haiku 4.5",
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 200_000,
        },
      ],
    } as never);

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "claude-cli",
          id: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          contextWindow: 1_048_576,
          contextTokens: 1_048_576,
        }),
        expect.objectContaining({
          provider: "claude-cli",
          id: "claude-opus-4-8[1m]",
          name: "Claude Opus 4.8 1M",
          contextWindow: 1_048_576,
          contextTokens: 1_048_576,
        }),
        expect.objectContaining({
          provider: "claude-cli",
          id: "claude-opus-4-7",
          name: "Claude Opus 4.7",
        }),
        expect.objectContaining({
          provider: "claude-cli",
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 200_000,
        }),
        expect.objectContaining({
          provider: "claude-cli",
          id: "claude-opus-4-6",
          name: "Claude Opus 4.6",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 200_000,
        }),
        expect.objectContaining({
          provider: "claude-cli",
          id: "claude-opus-4-5",
          name: "Claude Opus 4.5",
        }),
        expect.objectContaining({
          provider: "claude-cli",
          id: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
        }),
        expect.objectContaining({
          provider: "claude-cli",
          id: "claude-haiku-4-5",
          name: "Claude Haiku 4.5",
        }),
        expect.objectContaining({
          provider: "claude-cli-streaming",
          id: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          contextWindow: 1_048_576,
          contextTokens: 1_048_576,
        }),
        expect.objectContaining({
          provider: "claude-cli-streaming",
          id: "claude-opus-4-8[1m]",
          name: "Claude Opus 4.8 1M",
          contextWindow: 1_048_576,
          contextTokens: 1_048_576,
        }),
        expect.objectContaining({
          provider: "claude-cli-streaming",
          id: "claude-opus-4-7",
          name: "Claude Opus 4.7",
        }),
        expect.objectContaining({
          provider: "claude-cli-streaming",
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
        }),
        expect.objectContaining({
          provider: "claude-cli-streaming",
          id: "claude-opus-4-6",
          name: "Claude Opus 4.6",
        }),
      ]),
    );
  });

  it("owns native reasoning output mode for Claude transports", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "anthropic",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never),
    ).toBe("native");
  });

  it("owns replay policy for Claude transports", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "anthropic",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never),
    ).toEqual({
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      preserveNativeAnthropicToolUseIds: true,
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      validateAnthropicTurns: true,
      allowSyntheticToolResults: true,
    });
  });

  it("defaults provider api through plugin config normalization", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.normalizeConfig?.({
        provider: "anthropic",
        providerConfig: {
          models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
        },
      } as never),
    ).toMatchObject({
      api: "anthropic-messages",
    });
  });

  it("applies Anthropic pruning defaults through plugin hooks", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const next = provider.applyConfigDefaults?.({
      provider: "anthropic",
      env: {},
      config: {
        auth: {
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-5" },
          },
        },
      },
    } as never);

    expect(next?.agents?.defaults?.contextPruning).toMatchObject({
      mode: "cache-ttl",
      ttl: "1h",
    });
    expect(next?.agents?.defaults?.heartbeat).toMatchObject({
      every: "30m",
    });
    expect(
      next?.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.params?.cacheRetention,
    ).toBe("short");
  });

  it("backfills Claude CLI allowlist defaults through plugin hooks for older configs", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const next = provider.applyConfigDefaults?.({
      provider: "anthropic",
      env: {},
      config: {
        auth: {
          profiles: {
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
        agents: {
          defaults: {
            model: { primary: "claude-cli/claude-sonnet-4-6" },
            models: {
              "claude-cli/claude-sonnet-4-6": {},
            },
          },
        },
      },
    } as never);

    expect(next?.agents?.defaults?.heartbeat).toMatchObject({
      every: "1h",
    });
    expect(next?.agents?.defaults?.models).toMatchObject({
      "claude-cli/claude-opus-4-8": {},
      "claude-cli/claude-opus-4-8[1m]": {},
      "claude-cli/claude-opus-4-7": {},
      "claude-cli/claude-sonnet-4-6": {},
      "claude-cli/claude-opus-4-6": {},
      "claude-cli/claude-opus-4-5": {},
      "claude-cli/claude-sonnet-4-5": {},
      "claude-cli/claude-haiku-4-5": {},
    });
  });

  it("resolves claude-cli synthetic oauth auth", async () => {
    readClaudeCliCredentialsForRuntimeMock.mockReset();
    readClaudeCliCredentialsForRuntimeMock.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
    });

    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.resolveSyntheticAuth?.({
        provider: "claude-cli",
      } as never),
    ).toEqual({
      apiKey: "access-token",
      source: "Claude CLI native auth",
      mode: "oauth",
    });
    expect(readClaudeCliCredentialsForRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it("resolves claude-cli-streaming synthetic oauth auth", async () => {
    readClaudeCliCredentialsForRuntimeMock.mockReset();
    readClaudeCliCredentialsForRuntimeMock.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
    });

    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.resolveSyntheticAuth?.({
        provider: "claude-cli-streaming",
      } as never),
    ).toEqual({
      apiKey: "access-token",
      source: "Claude CLI native auth",
      mode: "oauth",
    });
  });

  it("resolves claude-cli-streaming claude-opus-4-8 from the Opus template family", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const resolved = provider.resolveDynamicModel?.({
      provider: "claude-cli-streaming",
      modelId: "claude-opus-4-8",
      modelRegistry: createModelRegistry([
        {
          id: "claude-opus-4-7",
          name: "Claude Opus 4.7",
          provider: "anthropic",
          api: "anthropic-messages",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_048_576,
          maxTokens: 32_000,
        } as ProviderRuntimeModel,
        {
          id: "claude-opus-4-6",
          name: "Claude Opus 4.6",
          provider: "anthropic",
          api: "anthropic-messages",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 32_000,
        } as ProviderRuntimeModel,
      ]),
    } as ProviderResolveDynamicModelContext);

    expect(resolved).toMatchObject({
      provider: "claude-cli-streaming",
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      contextWindow: 1_048_576,
      contextTokens: 1_048_576,
    });
  });

  it("resolves claude-cli-streaming claude-opus-4-8 1M from the Opus template family", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const resolved = provider.resolveDynamicModel?.({
      provider: "claude-cli-streaming",
      modelId: "claude-opus-4-8[1m]",
      modelRegistry: createModelRegistry([
        {
          id: "claude-opus-4-6",
          name: "Claude Opus 4.6",
          provider: "anthropic",
          api: "anthropic-messages",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 32_000,
        } as ProviderRuntimeModel,
      ]),
    } as ProviderResolveDynamicModelContext);

    expect(resolved).toMatchObject({
      provider: "claude-cli-streaming",
      id: "claude-opus-4-8[1m]",
      name: "Claude Opus 4.8 1M",
      contextWindow: 1_048_576,
      contextTokens: 1_048_576,
    });
  });

  it("resolves claude-cli-streaming claude-opus-4-7 from the 4.6 template family", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const resolved = provider.resolveDynamicModel?.({
      provider: "claude-cli-streaming",
      modelId: "claude-opus-4-7",
      modelRegistry: createModelRegistry([
        {
          id: "claude-opus-4-6",
          name: "Claude Opus 4.6",
          provider: "anthropic",
          api: "anthropic-messages",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 32_000,
        } as ProviderRuntimeModel,
      ]),
    } as ProviderResolveDynamicModelContext);

    expect(resolved).toMatchObject({
      provider: "claude-cli-streaming",
      id: "claude-opus-4-7",
      name: "Claude Opus 4.7",
      contextWindow: 1_048_576,
      contextTokens: 1_048_576,
    });
  });

  it("advertises xhigh thinking for Claude Opus 4.8", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.supportsXHighThinking?.({
        provider: "claude-cli-streaming",
        modelId: "claude-opus-4-8",
      } as never),
    ).toBe(true);
  });

  it("resolves claude-cli synthetic token auth", async () => {
    readClaudeCliCredentialsForRuntimeMock.mockReset();
    readClaudeCliCredentialsForRuntimeMock.mockReturnValue({
      type: "token",
      provider: "anthropic",
      token: "bearer-token",
      expires: 123,
    });

    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.resolveSyntheticAuth?.({
        provider: "claude-cli",
      } as never),
    ).toEqual({
      apiKey: "bearer-token",
      source: "Claude CLI native auth",
      mode: "token",
    });
  });

  it("stores a claude-cli auth profile during anthropic cli migration", async () => {
    readClaudeCliCredentialsForSetupMock.mockReset();
    readClaudeCliCredentialsForSetupMock.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "setup-access-token",
      refresh: "refresh-token",
      expires: 123,
    });

    const provider = await registerSingleProviderPlugin(anthropicPlugin);
    const cliAuth = provider.auth.find((entry) => entry.id === "cli");

    expect(cliAuth).toBeDefined();

    const result = await cliAuth?.run({
      config: {},
    } as never);

    expect(result?.profiles).toEqual([
      {
        profileId: "anthropic:claude-cli",
        credential: {
          type: "oauth",
          provider: "claude-cli",
          access: "setup-access-token",
          refresh: "refresh-token",
          expires: 123,
        },
      },
    ]);
  });
});
