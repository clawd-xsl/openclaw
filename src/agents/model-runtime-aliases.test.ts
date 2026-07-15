// Verifies CLI runtime alias resolution and runtime model-ref equivalence.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { testing as cliBackendsTesting } from "./cli-backends.js";
import {
  createModelPickerVisibleProviderPredicate,
  isRetiredModelPickerProvider,
} from "./model-picker-visibility.js";
import {
  areRuntimeModelRefsEquivalent,
  isCliRuntimeProvider,
  resolveCliExecutionDispatch,
  resolveCliRuntimeExecutionProvider,
} from "./model-runtime-aliases.js";

function createAnthropicAuthConfig(params: {
  order?: string[];
  models?: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"];
}): OpenClawConfig {
  // Auth order controls whether Anthropic execution is direct API or Claude
  // CLI-backed when no explicit runtime policy overrides it.
  return {
    auth: {
      order: params.order ? { anthropic: params.order } : undefined,
      profiles: {
        "anthropic:api": { provider: "anthropic", mode: "api_key" },
        "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
      },
    },
    agents: {
      defaults: {
        models: params.models,
      },
    },
  } as OpenClawConfig;
}

describe("resolveCliRuntimeExecutionProvider", () => {
  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
      ],
    });
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  it("routes Anthropic execution to Claude CLI when the selected auth profile is Claude CLI", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: createAnthropicAuthConfig({ order: ["anthropic:claude-cli"] }),
        provider: "anthropic",
        modelId: "opus-4.7",
      }),
    ).toBe("claude-cli");
  });

  it("keeps direct Anthropic execution when the selected auth profile is direct Anthropic", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: createAnthropicAuthConfig({
          order: ["anthropic:api", "anthropic:claude-cli"],
        }),
        provider: "anthropic",
        modelId: "opus-4.7",
      }),
    ).toBeUndefined();
  });

  it("honors an explicit direct Anthropic auth profile over CLI auth order", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        authProfileId: "anthropic:api",
        cfg: createAnthropicAuthConfig({ order: ["anthropic:claude-cli"] }),
        provider: "anthropic",
        modelId: "opus-4.7",
      }),
    ).toBeUndefined();
  });

  it("uses an explicit Claude CLI auth profile without a model-runtime entry", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        authProfileId: "anthropic:claude-cli",
        cfg: createAnthropicAuthConfig({ order: ["anthropic:api"] }),
        provider: "anthropic",
        modelId: "opus-4.7",
      }),
    ).toBe("claude-cli");
  });

  it("does not override an explicit OpenClaw model-runtime policy with CLI auth", () => {
    // Runtime policy is more explicit than profile order, so CLI auth cannot
    // force a model onto the CLI harness when config says OpenClaw.
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: createAnthropicAuthConfig({
          order: ["anthropic:claude-cli"],
          models: {
            "anthropic/opus-4.7": { agentRuntime: { id: "openclaw" } },
          },
        }),
        provider: "anthropic",
        modelId: "opus-4.7",
      }),
    ).toBeUndefined();
  });

  it("matches a configured claude-cli policy when the caller provider is empty", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: createAnthropicAuthConfig({
          models: {
            "anthropic/opus-4.7": { agentRuntime: { id: "claude-cli" } },
          },
        }),
        provider: "",
        modelId: "opus-4.7",
      }),
    ).toBe("claude-cli");
  });

  it("matches provider runtime policy from a provider-qualified model when the caller provider is empty", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: {
          models: {
            providers: {
              anthropic: {
                baseUrl: "https://api.anthropic.example/v1",
                agentRuntime: { id: "claude-cli" },
                models: [],
              },
            },
          },
        } as OpenClawConfig,
        provider: "",
        modelId: "anthropic/opus-4.7",
      }),
    ).toBe("claude-cli");
  });

  it("does not return a CLI runtime when the matched entry's provider is incompatible with the runtime alias", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: createAnthropicAuthConfig({
          models: {
            "openrouter/opus-4.7": { agentRuntime: { id: "claude-cli" } },
          },
        }),
        provider: "",
        modelId: "opus-4.7",
      }),
    ).toBeUndefined();
  });

  it("keeps standalone CLI backend provider refs visible", () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
        {
          id: "acme-cli",
          pluginId: "acme",
          config: { command: "acme" },
        },
      ],
    });

    const isVisibleProvider = createModelPickerVisibleProviderPredicate();

    expect(isCliRuntimeProvider("claude-cli")).toBe(true);
    expect(isVisibleProvider("claude-cli")).toBe(false);
    expect(isCliRuntimeProvider("acme-cli")).toBe(false);
    expect(isVisibleProvider("acme-cli")).toBe(true);
  });

  it("recognizes retired picker providers without loading CLI backend metadata", () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: () => {
        throw new Error("retired provider checks should not load setup metadata");
      },
      resolveRuntimeCliBackends: () => {
        throw new Error("retired provider checks should not load runtime metadata");
      },
    });

    expect(isRetiredModelPickerProvider("CODEX-CLI")).toBe(true);
    expect(isRetiredModelPickerProvider("anthropic")).toBe(false);
  });
});

describe("areRuntimeModelRefsEquivalent", () => {
  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  it("does not load setup runtime aliases for already-identical refs", () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: () => {
        throw new Error("setup registry should not load for identical refs");
      },
      resolveRuntimeCliBackends: () => [],
    });

    expect(
      areRuntimeModelRefsEquivalent("anthropic/claude", "anthropic/claude", {
        config: {},
      }),
    ).toBe(true);
  });

  it("resolves one setup runtime alias without loading the full setup registry", () => {
    // Equivalence checks use targeted setup lookup so hot model comparisons do
    // not load the full plugin setup registry.
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: ({ backend }) =>
        backend === "claude-cli"
          ? {
              pluginId: "anthropic",
              backend: {
                id: "claude-cli",
                modelProvider: "anthropic",
                config: { command: "claude" },
                bundleMcp: false,
              },
            }
          : undefined,
      resolvePluginSetupRegistry: () => {
        throw new Error("setup registry should not load for a single runtime alias");
      },
      resolveRuntimeCliBackends: () => [],
    });

    expect(
      areRuntimeModelRefsEquivalent("anthropic/claude-opus-4-7", "claude-cli/claude-opus-4-7", {
        config: {
          agents: {
            defaults: {
              cliBackends: {
                "claude-cli": { command: "claude" },
              },
            },
          },
        },
      }),
    ).toBe(true);
  });
});

describe("resolveCliExecutionDispatch", () => {
  const cliBackendsCfg = {
    agents: {
      defaults: {
        cliBackends: {
          "claude-cli": { command: "claude" },
          "acme-cli": { command: "acme" },
        },
      },
    },
  } as OpenClawConfig;

  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
      ],
    });
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  it("prefers a validated CLI session runtime override", () => {
    expect(
      resolveCliExecutionDispatch({
        provider: "anthropic",
        cfg: cliBackendsCfg,
        runtimeOverride: "claude-cli",
      }),
    ).toBe("claude-cli");
  });

  it("ignores non-CLI runtime overrides (codex stays embedded)", () => {
    expect(
      resolveCliExecutionDispatch({
        provider: "openai",
        cfg: cliBackendsCfg,
        runtimeOverride: "codex",
      }),
    ).toBeUndefined();
  });

  it("dispatches an API provider ref through its auth-profile CLI binding", () => {
    expect(
      resolveCliExecutionDispatch({
        provider: "anthropic",
        cfg: createAnthropicAuthConfig({ order: ["anthropic:claude-cli"] }),
        modelId: "opus-4.7",
      }),
    ).toBe("claude-cli");
  });

  it("keeps an explicit openclaw runtime policy on the embedded path", () => {
    expect(
      resolveCliExecutionDispatch({
        provider: "anthropic",
        cfg: createAnthropicAuthConfig({
          order: ["anthropic:claude-cli"],
          models: { "anthropic/opus-4.7": { agentRuntime: { id: "openclaw" } } },
        }),
        modelId: "opus-4.7",
      }),
    ).toBeUndefined();
  });

  it("returns undefined for canonical refs with no CLI binding", () => {
    expect(resolveCliExecutionDispatch({ provider: "anthropic", cfg: cliBackendsCfg })).toBe(
      undefined,
    );
  });

  it("dispatches standalone CLI backends' own provider-prefixed refs", () => {
    // acme-cli has no canonical modelProvider: direct acme-cli/<model> refs are
    // its only spelling and must keep dispatching.
    expect(resolveCliExecutionDispatch({ provider: "acme-cli", cfg: cliBackendsCfg })).toBe(
      "acme-cli",
    );
  });

  it("throws for retired runtime-alias provider refs like claude-cli/<model>", () => {
    expect(() =>
      resolveCliExecutionDispatch({
        provider: "claude-cli",
        cfg: cliBackendsCfg,
        modelId: "claude-opus-4-8",
      }),
    ).toThrowError(/retired[\s\S]*anthropic\/<model>[\s\S]*doctor --fix/);
  });

  it("offers the auth-profile recovery hint only when the backend aliases the auth key", () => {
    // claude-cli aliases to anthropic's auth key -> hint applies.
    expect(() =>
      resolveCliExecutionDispatch({ provider: "claude-cli", cfg: cliBackendsCfg }),
    ).toThrowError(/keep a "claude-cli" auth profile/);
  });

  it("omits the auth-profile hint for a runtime-alias backend without an auth alias", () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
      resolveRuntimeCliBackends: () => [
        {
          id: "acme-cli",
          modelProvider: "acme",
          pluginId: "acme",
          config: { command: "acme" },
        },
      ],
    });
    let caught: Error | undefined;
    try {
      resolveCliExecutionDispatch({
        provider: "acme-cli",
        cfg: {
          agents: { defaults: { cliBackends: { "acme-cli": { command: "acme" } } } },
        } as OpenClawConfig,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/retired/);
    expect(caught?.message).not.toMatch(/auth profile/);
  });
});
