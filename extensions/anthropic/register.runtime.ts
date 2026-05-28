import { formatCliCommand, parseDurationMs } from "openclaw/plugin-sdk/cli-runtime";
import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderResolveDynamicModelContext,
  ProviderNormalizeResolvedModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAuthProfileConfig,
  type AuthProfileStore,
  buildTokenProfileId,
  createProviderApiKeyAuthMethod,
  listProfilesForProvider,
  type OpenClawConfig as ProviderAuthConfig,
  type ProviderAuthResult,
  suggestOAuthProfileIdForLegacyDefault,
  upsertAuthProfile,
  validateAnthropicSetupToken,
} from "openclaw/plugin-sdk/provider-auth";
import { findCatalogTemplate } from "openclaw/plugin-sdk/provider-catalog-shared";
import { cloneFirstTemplateModel } from "openclaw/plugin-sdk/provider-model-shared";
import { fetchClaudeUsage } from "openclaw/plugin-sdk/provider-usage";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import * as claudeCliAuth from "./cli-auth-seam.js";
import { buildAnthropicCliBackend, buildAnthropicStreamingCliBackend } from "./cli-backend.js";
import { buildAnthropicCliMigrationResult } from "./cli-migration.js";
import {
  CLAUDE_CLI_BACKEND_IDS,
  CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  isClaudeCliFamilyProvider,
} from "./cli-shared.js";
import {
  applyAnthropicConfigDefaults,
  normalizeAnthropicProviderConfig,
} from "./config-defaults.js";
import { anthropicMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildAnthropicReplayPolicy } from "./replay-policy.js";
import { wrapAnthropicProviderStream } from "./stream-wrappers.js";

const PROVIDER_ID = "anthropic";
const DEFAULT_ANTHROPIC_MODEL = "anthropic/claude-sonnet-4-6";
const ANTHROPIC_OPUS_48_MODEL_ID = "claude-opus-4-8";
const ANTHROPIC_OPUS_48_DOT_MODEL_ID = "claude-opus-4.8";
const ANTHROPIC_OPUS_48_1M_MODEL_ID = "claude-opus-4-8[1m]";
const ANTHROPIC_OPUS_48_1M_DOT_MODEL_ID = "claude-opus-4.8[1m]";
const ANTHROPIC_OPUS_47_MODEL_ID = "claude-opus-4-7";
const ANTHROPIC_OPUS_47_DOT_MODEL_ID = "claude-opus-4.7";
const ANTHROPIC_OPUS_LONG_CONTEXT_TOKENS = 1_048_576;
const ANTHROPIC_OPUS_46_MODEL_ID = "claude-opus-4-6";
const ANTHROPIC_OPUS_46_DOT_MODEL_ID = "claude-opus-4.6";
const ANTHROPIC_OPUS_48_1M_TEMPLATE_MODEL_IDS = [
  ANTHROPIC_OPUS_47_MODEL_ID,
  ANTHROPIC_OPUS_47_DOT_MODEL_ID,
  ANTHROPIC_OPUS_46_MODEL_ID,
  ANTHROPIC_OPUS_46_DOT_MODEL_ID,
  "claude-opus-4-5",
  "claude-opus-4.5",
] as const;
const ANTHROPIC_OPUS_47_TEMPLATE_MODEL_IDS = [
  ANTHROPIC_OPUS_46_MODEL_ID,
  ANTHROPIC_OPUS_46_DOT_MODEL_ID,
  "claude-opus-4-5",
  "claude-opus-4.5",
] as const;
const ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS = ["claude-opus-4-5", "claude-opus-4.5"] as const;
const ANTHROPIC_SONNET_46_MODEL_ID = "claude-sonnet-4-6";
const ANTHROPIC_SONNET_46_DOT_MODEL_ID = "claude-sonnet-4.6";
const ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS = ["claude-sonnet-4-5", "claude-sonnet-4.5"] as const;
const ANTHROPIC_HAIKU_TEMPLATE_MODEL_IDS = ["claude-haiku-4-5", "claude-haiku-4.5"] as const;
const ANTHROPIC_MODERN_MODEL_PREFIXES = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;
const _ANTHROPIC_OAUTH_ALLOWLIST = [
  "anthropic/claude-opus-4-8",
  "anthropic/claude-opus-4-7",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-opus-4-5",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-haiku-4-5",
] as const;
const ANTHROPIC_SETUP_TOKEN_NOTE_LINES = [
  "Anthropic setup-token auth is supported in OpenClaw.",
  "OpenClaw prefers Claude CLI reuse when it is available on the host.",
  "Anthropic staff told us this OpenClaw path is allowed again.",
  `If you want a direct API billing path instead, use ${formatCliCommand("openclaw models auth login --provider anthropic --method api-key --set-default")} or ${formatCliCommand("openclaw models auth login --provider anthropic --method cli --set-default")}.`,
] as const;

type AnthropicContextWindowFields = {
  contextWindow?: number;
  contextTokens?: number;
};

function normalizeAnthropicSetupTokenInput(value: string): string {
  return value.replaceAll(/\s+/g, "").trim();
}

function normalizeAnthropicModelId(modelId: string): string {
  const trimmed = modelId.trim();
  switch (normalizeLowercaseStringOrEmpty(trimmed)) {
    case "opus-4.8":
      return ANTHROPIC_OPUS_48_MODEL_ID;
    case "opus-4.8[1m]":
    case "opus-4.8-1m":
      return ANTHROPIC_OPUS_48_1M_MODEL_ID;
    case "opus-4.7":
      return ANTHROPIC_OPUS_47_MODEL_ID;
    case "opus-4.6":
      return ANTHROPIC_OPUS_46_MODEL_ID;
    case "opus-4.5":
      return "claude-opus-4-5";
    case "sonnet-4.6":
      return ANTHROPIC_SONNET_46_MODEL_ID;
    case "sonnet-4.5":
      return "claude-sonnet-4-5";
    default:
      return trimmed;
  }
}

function resolveAnthropicSetupTokenProfileId(rawProfileId?: unknown): string {
  if (typeof rawProfileId === "string") {
    const trimmed = rawProfileId.trim();
    if (trimmed.length > 0) {
      if (trimmed.startsWith(`${PROVIDER_ID}:`)) {
        return trimmed;
      }
      return buildTokenProfileId({ provider: PROVIDER_ID, name: trimmed });
    }
  }
  return `${PROVIDER_ID}:default`;
}

function resolveAnthropicSetupTokenExpiry(rawExpiresIn?: unknown): number | undefined {
  if (typeof rawExpiresIn !== "string" || rawExpiresIn.trim().length === 0) {
    return undefined;
  }
  return Date.now() + parseDurationMs(rawExpiresIn.trim(), { defaultUnit: "d" });
}

async function runAnthropicSetupTokenAuth(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const providedToken =
    typeof ctx.opts?.token === "string" && ctx.opts.token.trim().length > 0
      ? normalizeAnthropicSetupTokenInput(ctx.opts.token)
      : undefined;
  const token =
    providedToken ??
    normalizeAnthropicSetupTokenInput(
      await ctx.prompter.text({
        message: "Paste Anthropic setup-token",
        validate: (value) => validateAnthropicSetupToken(normalizeAnthropicSetupTokenInput(value)),
      }),
    );
  const tokenError = validateAnthropicSetupToken(token);
  if (tokenError) {
    throw new Error(tokenError);
  }

  const profileId = resolveAnthropicSetupTokenProfileId(ctx.opts?.tokenProfileId);
  const expires = resolveAnthropicSetupTokenExpiry(ctx.opts?.tokenExpiresIn);

  return {
    profiles: [
      {
        profileId,
        credential: {
          type: "token",
          provider: PROVIDER_ID,
          token,
          ...(expires ? { expires } : {}),
        },
      },
    ],
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
    notes: [...ANTHROPIC_SETUP_TOKEN_NOTE_LINES],
  };
}

async function runAnthropicSetupTokenNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
): Promise<ProviderAuthConfig | null> {
  const rawToken =
    typeof ctx.opts.token === "string" ? normalizeAnthropicSetupTokenInput(ctx.opts.token) : "";
  const tokenError = validateAnthropicSetupToken(rawToken);
  if (tokenError) {
    ctx.runtime.error(
      ["Anthropic setup-token auth requires --token with a valid setup-token.", tokenError].join(
        "\n",
      ),
    );
    ctx.runtime.exit(1);
    return null;
  }

  const profileId = resolveAnthropicSetupTokenProfileId(ctx.opts.tokenProfileId);
  const expires = resolveAnthropicSetupTokenExpiry(ctx.opts.tokenExpiresIn);
  upsertAuthProfile({
    profileId,
    credential: {
      type: "token",
      provider: PROVIDER_ID,
      token: rawToken,
      ...(expires ? { expires } : {}),
    },
    agentDir: ctx.agentDir,
  });

  ctx.runtime.log(ANTHROPIC_SETUP_TOKEN_NOTE_LINES[0]);
  ctx.runtime.log(ANTHROPIC_SETUP_TOKEN_NOTE_LINES[1]);

  const withProfile = applyAuthProfileConfig(ctx.config, {
    profileId,
    provider: PROVIDER_ID,
    mode: "token",
  });
  const existingModelConfig =
    withProfile.agents?.defaults?.model && typeof withProfile.agents.defaults.model === "object"
      ? withProfile.agents.defaults.model
      : {};
  return {
    ...withProfile,
    agents: {
      ...withProfile.agents,
      defaults: {
        ...withProfile.agents?.defaults,
        model: {
          ...existingModelConfig,
          primary: DEFAULT_ANTHROPIC_MODEL,
        },
      },
    },
  };
}

function resolveAnthropic46ForwardCompatModel(params: {
  ctx: ProviderResolveDynamicModelContext;
  dashModelId: string;
  dotModelId: string;
  dashTemplateId: string;
  dotTemplateId: string;
  fallbackTemplateIds: readonly string[];
  displayName?: string;
}): ProviderRuntimeModel | undefined {
  const trimmedModelId = params.ctx.modelId.trim();
  const lower = normalizeLowercaseStringOrEmpty(trimmedModelId);
  const is46Model =
    lower === params.dashModelId ||
    lower === params.dotModelId ||
    lower.startsWith(`${params.dashModelId}-`) ||
    lower.startsWith(`${params.dotModelId}-`);
  if (!is46Model) {
    return undefined;
  }

  const templateIds: string[] = [];
  if (lower.startsWith(params.dashModelId)) {
    templateIds.push(lower.replace(params.dashModelId, params.dashTemplateId));
  }
  if (lower.startsWith(params.dotModelId)) {
    templateIds.push(lower.replace(params.dotModelId, params.dotTemplateId));
  }
  templateIds.push(...params.fallbackTemplateIds);

  const resolved = cloneFirstTemplateModel({
    providerId: PROVIDER_ID,
    modelId: trimmedModelId,
    templateIds,
    ctx: params.ctx,
    patch: isClaudeCliFamilyProvider(params.ctx.provider)
      ? { provider: params.ctx.provider }
      : undefined,
  });
  if (!resolved) {
    return undefined;
  }
  return params.displayName ? { ...resolved, name: params.displayName } : resolved;
}

function resolveAnthropicForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  return (
    resolveAnthropic46ForwardCompatModel({
      ctx,
      dashModelId: ANTHROPIC_OPUS_48_1M_MODEL_ID,
      dotModelId: ANTHROPIC_OPUS_48_1M_DOT_MODEL_ID,
      dashTemplateId: ANTHROPIC_OPUS_47_MODEL_ID,
      dotTemplateId: ANTHROPIC_OPUS_47_DOT_MODEL_ID,
      fallbackTemplateIds: ANTHROPIC_OPUS_48_1M_TEMPLATE_MODEL_IDS,
      displayName: "Claude Opus 4.8 1M",
    }) ??
    resolveAnthropic46ForwardCompatModel({
      ctx,
      dashModelId: ANTHROPIC_OPUS_48_MODEL_ID,
      dotModelId: ANTHROPIC_OPUS_48_DOT_MODEL_ID,
      dashTemplateId: ANTHROPIC_OPUS_47_MODEL_ID,
      dotTemplateId: ANTHROPIC_OPUS_47_DOT_MODEL_ID,
      fallbackTemplateIds: ANTHROPIC_OPUS_48_1M_TEMPLATE_MODEL_IDS,
      displayName: "Claude Opus 4.8",
    }) ??
    resolveAnthropic46ForwardCompatModel({
      ctx,
      dashModelId: ANTHROPIC_OPUS_47_MODEL_ID,
      dotModelId: ANTHROPIC_OPUS_47_DOT_MODEL_ID,
      dashTemplateId: ANTHROPIC_OPUS_46_MODEL_ID,
      dotTemplateId: ANTHROPIC_OPUS_46_DOT_MODEL_ID,
      fallbackTemplateIds: ANTHROPIC_OPUS_47_TEMPLATE_MODEL_IDS,
      displayName: "Claude Opus 4.7",
    }) ??
    resolveAnthropic46ForwardCompatModel({
      ctx,
      dashModelId: ANTHROPIC_OPUS_46_MODEL_ID,
      dotModelId: ANTHROPIC_OPUS_46_DOT_MODEL_ID,
      dashTemplateId: "claude-opus-4-5",
      dotTemplateId: "claude-opus-4.5",
      fallbackTemplateIds: ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS,
    }) ??
    resolveAnthropic46ForwardCompatModel({
      ctx,
      dashModelId: ANTHROPIC_SONNET_46_MODEL_ID,
      dotModelId: ANTHROPIC_SONNET_46_DOT_MODEL_ID,
      dashTemplateId: "claude-sonnet-4-5",
      dotTemplateId: "claude-sonnet-4.5",
      fallbackTemplateIds: ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS,
    })
  );
}

function shouldUseAnthropicAdaptiveThinkingDefault(modelId: string): boolean {
  const lowerModelId = normalizeLowercaseStringOrEmpty(modelId);
  return (
    lowerModelId.startsWith(ANTHROPIC_OPUS_46_MODEL_ID) ||
    lowerModelId.startsWith(ANTHROPIC_OPUS_46_DOT_MODEL_ID) ||
    lowerModelId.startsWith(ANTHROPIC_SONNET_46_MODEL_ID) ||
    lowerModelId.startsWith(ANTHROPIC_SONNET_46_DOT_MODEL_ID)
  );
}

function isAnthropicOpusLongContextModel(modelId: string): boolean {
  const lowerModelId = normalizeLowercaseStringOrEmpty(modelId);
  return (
    lowerModelId.startsWith(ANTHROPIC_OPUS_48_MODEL_ID) ||
    lowerModelId.startsWith(ANTHROPIC_OPUS_48_DOT_MODEL_ID) ||
    lowerModelId.startsWith(ANTHROPIC_OPUS_48_1M_MODEL_ID) ||
    lowerModelId.startsWith(ANTHROPIC_OPUS_48_1M_DOT_MODEL_ID) ||
    lowerModelId.startsWith(ANTHROPIC_OPUS_47_MODEL_ID) ||
    lowerModelId.startsWith(ANTHROPIC_OPUS_47_DOT_MODEL_ID)
  );
}

function supportsAnthropicOpusXHighThinking(modelId: string): boolean {
  const lowerModelId = normalizeLowercaseStringOrEmpty(modelId);
  return (
    lowerModelId.startsWith(ANTHROPIC_OPUS_48_MODEL_ID) ||
    lowerModelId.startsWith(ANTHROPIC_OPUS_48_DOT_MODEL_ID) ||
    lowerModelId.startsWith(ANTHROPIC_OPUS_47_MODEL_ID) ||
    lowerModelId.startsWith(ANTHROPIC_OPUS_47_DOT_MODEL_ID)
  );
}

function hasConfiguredModelContextOverride(
  config: ProviderNormalizeResolvedModelContext["config"],
  provider: string,
  modelId: string,
): boolean {
  const providers = config?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return false;
  }
  const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (normalizeLowercaseStringOrEmpty(providerId) !== normalizedProvider) {
      continue;
    }
    if (!Array.isArray(providerConfig?.models)) {
      continue;
    }
    for (const model of providerConfig.models) {
      if (
        normalizeLowercaseStringOrEmpty(typeof model?.id === "string" ? model.id : "") !==
        normalizedModelId
      ) {
        continue;
      }
      if (
        (typeof model?.contextTokens === "number" && model.contextTokens > 0) ||
        (typeof model?.contextWindow === "number" && model.contextWindow > 0)
      ) {
        return true;
      }
    }
  }
  return false;
}

function applyAnthropicOpusLongContextWindow<TModel extends object>(params: {
  config?: ProviderNormalizeResolvedModelContext["config"];
  provider: string;
  modelId: string;
  model: TModel;
}): TModel | undefined {
  if (!isAnthropicOpusLongContextModel(params.modelId)) {
    return undefined;
  }
  if (hasConfiguredModelContextOverride(params.config, params.provider, params.modelId)) {
    return undefined;
  }
  const current = params.model as AnthropicContextWindowFields;
  const nextContextWindow = Math.max(
    current.contextWindow ?? 0,
    ANTHROPIC_OPUS_LONG_CONTEXT_TOKENS,
  );
  const nextContextTokens =
    typeof current.contextTokens === "number"
      ? Math.max(current.contextTokens, ANTHROPIC_OPUS_LONG_CONTEXT_TOKENS)
      : ANTHROPIC_OPUS_LONG_CONTEXT_TOKENS;
  if (nextContextWindow === current.contextWindow && nextContextTokens === current.contextTokens) {
    return undefined;
  }
  return {
    ...params.model,
    contextWindow: nextContextWindow,
    contextTokens: nextContextTokens,
  } as TModel;
}

function applyAnthropicOpusContextWindow<TModel extends object>(params: {
  config?: ProviderNormalizeResolvedModelContext["config"];
  provider: string;
  modelId: string;
  model: TModel;
}): TModel | undefined {
  return applyAnthropicOpusLongContextWindow(params);
}

const ANTHROPIC_CLI_CATALOG_SPECS = [
  {
    id: ANTHROPIC_OPUS_48_MODEL_ID,
    name: "Claude Opus 4.8",
    templateIds: [
      ANTHROPIC_OPUS_48_MODEL_ID,
      ANTHROPIC_OPUS_48_DOT_MODEL_ID,
      ...ANTHROPIC_OPUS_48_1M_TEMPLATE_MODEL_IDS,
    ] as const,
  },
  {
    id: ANTHROPIC_OPUS_48_1M_MODEL_ID,
    name: "Claude Opus 4.8 1M",
    templateIds: [
      ANTHROPIC_OPUS_48_1M_MODEL_ID,
      ANTHROPIC_OPUS_48_1M_DOT_MODEL_ID,
      ANTHROPIC_OPUS_48_MODEL_ID,
      ANTHROPIC_OPUS_48_DOT_MODEL_ID,
      ...ANTHROPIC_OPUS_48_1M_TEMPLATE_MODEL_IDS,
    ] as const,
  },
  {
    id: ANTHROPIC_OPUS_47_MODEL_ID,
    name: "Claude Opus 4.7",
    templateIds: [
      ANTHROPIC_OPUS_47_MODEL_ID,
      ANTHROPIC_OPUS_47_DOT_MODEL_ID,
      ...ANTHROPIC_OPUS_47_TEMPLATE_MODEL_IDS,
    ] as const,
  },
  {
    id: ANTHROPIC_SONNET_46_MODEL_ID,
    name: "Claude Sonnet 4.6",
    templateIds: [
      ANTHROPIC_SONNET_46_MODEL_ID,
      ANTHROPIC_SONNET_46_DOT_MODEL_ID,
      ...ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS,
    ] as const,
  },
  {
    id: ANTHROPIC_OPUS_46_MODEL_ID,
    name: "Claude Opus 4.6",
    templateIds: [
      ANTHROPIC_OPUS_46_MODEL_ID,
      ANTHROPIC_OPUS_46_DOT_MODEL_ID,
      ...ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS,
    ] as const,
  },
  {
    id: ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS[0],
    name: "Claude Opus 4.5",
    templateIds: ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS,
  },
  {
    id: ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS[0],
    name: "Claude Sonnet 4.5",
    templateIds: ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS,
  },
  {
    id: ANTHROPIC_HAIKU_TEMPLATE_MODEL_IDS[0],
    name: "Claude Haiku 4.5",
    templateIds: ANTHROPIC_HAIKU_TEMPLATE_MODEL_IDS,
  },
] as const;

function buildAnthropicCliCatalogEntries(ctx: {
  entries: Array<{
    provider: string;
    id: string;
    name: string;
    contextWindow?: number;
    reasoning?: boolean;
    input?: ("text" | "image" | "document")[];
  }>;
}) {
  return CLAUDE_CLI_BACKEND_IDS.flatMap((backendId) =>
    ANTHROPIC_CLI_CATALOG_SPECS.map((spec) => {
      const template = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: spec.templateIds,
      });
      if (!template) {
        return undefined;
      }
      const entry = {
        ...template,
        provider: backendId,
        id: spec.id,
        name: spec.name,
      };
      return (
        applyAnthropicOpusContextWindow({
          provider: backendId,
          modelId: spec.id,
          model: entry,
        }) ?? entry
      );
    }).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
  );
}

function matchesAnthropicModernModel(modelId: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(modelId).replace(/\./g, "-");
  return ANTHROPIC_MODERN_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function buildAnthropicAuthDoctorHint(params: {
  config?: ProviderAuthContext["config"];
  store: AuthProfileStore;
  profileId?: string;
}): string {
  const legacyProfileId = params.profileId ?? "anthropic:default";
  const suggested = suggestOAuthProfileIdForLegacyDefault({
    cfg: params.config,
    store: params.store,
    provider: PROVIDER_ID,
    legacyProfileId,
  });
  if (!suggested || suggested === legacyProfileId) {
    return "";
  }

  const storeOauthProfiles = listProfilesForProvider(params.store, PROVIDER_ID)
    .filter((id) => params.store.profiles[id]?.type === "oauth")
    .join(", ");

  const cfgMode = params.config?.auth?.profiles?.[legacyProfileId]?.mode;
  const cfgProvider = params.config?.auth?.profiles?.[legacyProfileId]?.provider;

  return [
    "Doctor hint (for GitHub issue):",
    `- provider: ${PROVIDER_ID}`,
    `- config: ${legacyProfileId}${
      cfgProvider || cfgMode ? ` (provider=${cfgProvider ?? "?"}, mode=${cfgMode ?? "?"})` : ""
    }`,
    `- auth store oauth profiles: ${storeOauthProfiles || "(none)"}`,
    `- suggested profile: ${suggested}`,
    `Fix: run "${formatCliCommand("openclaw doctor --yes")}"`,
  ].join("\n");
}

function resolveClaudeCliSyntheticAuth() {
  const credential = claudeCliAuth.readClaudeCliCredentialsForRuntime();
  if (!credential) {
    return undefined;
  }
  return credential.type === "oauth"
    ? {
        apiKey: credential.access,
        source: "Claude CLI native auth",
        mode: "oauth" as const,
      }
    : {
        apiKey: credential.token,
        source: "Claude CLI native auth",
        mode: "token" as const,
      };
}

async function runAnthropicCliMigration(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const credential = claudeCliAuth.readClaudeCliCredentialsForSetup();
  if (!credential) {
    throw new Error(
      [
        "Claude CLI is not authenticated on this host.",
        `Run ${formatCliCommand("claude auth login")} first, then re-run this setup.`,
      ].join("\n"),
    );
  }
  return buildAnthropicCliMigrationResult(ctx.config, credential);
}

async function runAnthropicCliMigrationNonInteractive(ctx: {
  config: ProviderAuthContext["config"];
  runtime: ProviderAuthContext["runtime"];
  agentDir?: string;
}): Promise<ProviderAuthContext["config"] | null> {
  const credential = claudeCliAuth.readClaudeCliCredentialsForSetupNonInteractive();
  if (!credential) {
    ctx.runtime.error(
      [
        'Auth choice "anthropic-cli" requires Claude CLI auth on this host.',
        `Run ${formatCliCommand("claude auth login")} first.`,
      ].join("\n"),
    );
    ctx.runtime.exit(1);
    return null;
  }

  const result = buildAnthropicCliMigrationResult(ctx.config, credential);
  const currentDefaults = ctx.config.agents?.defaults;
  const currentModel = currentDefaults?.model;
  const currentFallbacks =
    currentModel && typeof currentModel === "object" && "fallbacks" in currentModel
      ? currentModel.fallbacks
      : undefined;
  const migratedModel = result.configPatch?.agents?.defaults?.model;
  const migratedFallbacks =
    migratedModel && typeof migratedModel === "object" && "fallbacks" in migratedModel
      ? migratedModel.fallbacks
      : undefined;
  const nextFallbacks = Array.isArray(migratedFallbacks) ? migratedFallbacks : currentFallbacks;

  return {
    ...ctx.config,
    ...result.configPatch,
    agents: {
      ...ctx.config.agents,
      ...result.configPatch?.agents,
      defaults: {
        ...currentDefaults,
        ...result.configPatch?.agents?.defaults,
        model: {
          ...(Array.isArray(nextFallbacks) ? { fallbacks: nextFallbacks } : {}),
          primary: result.defaultModel,
        },
      },
    },
  };
}

export function registerAnthropicPlugin(api: OpenClawPluginApi): void {
  const providerId = "anthropic";
  const defaultAnthropicModel = "anthropic/claude-sonnet-4-6";
  const _anthropicOauthAllowlist = [
    "anthropic/claude-opus-4-8",
    "anthropic/claude-opus-4-7",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-opus-4-6",
    "anthropic/claude-opus-4-5",
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-haiku-4-5",
  ] as const;
  api.registerCliBackend(buildAnthropicCliBackend());
  api.registerCliBackend(buildAnthropicStreamingCliBackend());
  api.registerProvider({
    id: providerId,
    label: "Anthropic",
    docsPath: "/providers/models",
    hookAliases: [...CLAUDE_CLI_BACKEND_IDS],
    envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    oauthProfileIdRepairs: [
      {
        legacyProfileId: "anthropic:default",
        promptLabel: "Anthropic",
      },
    ],
    auth: [
      {
        id: "cli",
        label: "Claude CLI",
        hint: "Reuse a local Claude CLI login and switch model selection to claude-cli/*",
        kind: "custom",
        wizard: {
          choiceId: "anthropic-cli",
          choiceLabel: "Anthropic Claude CLI",
          choiceHint: "Reuse a local Claude CLI login on this host",
          assistantPriority: -20,
          groupId: "anthropic",
          groupLabel: "Anthropic",
          groupHint: "Claude CLI + API key",
          modelAllowlist: {
            allowedKeys: [...CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS],
            initialSelections: [CLAUDE_CLI_DEFAULT_MODEL_REF],
            message: "Claude CLI models",
          },
        },
        run: async (ctx: ProviderAuthContext) => await runAnthropicCliMigration(ctx),
        runNonInteractive: async (ctx) =>
          await runAnthropicCliMigrationNonInteractive({
            config: ctx.config,
            runtime: ctx.runtime,
            agentDir: ctx.agentDir,
          }),
      },
      {
        id: "setup-token",
        label: "Anthropic setup-token",
        hint: "Manual bearer token path",
        kind: "token",
        wizard: {
          choiceId: "setup-token",
          choiceLabel: "Anthropic setup-token",
          choiceHint: "Manual token path",
          assistantPriority: 40,
          groupId: "anthropic",
          groupLabel: "Anthropic",
          groupHint: "Claude CLI + API key + token",
        },
        run: async (ctx: ProviderAuthContext) => await runAnthropicSetupTokenAuth(ctx),
        runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) =>
          await runAnthropicSetupTokenNonInteractive(ctx),
      },
      createProviderApiKeyAuthMethod({
        providerId,
        methodId: "api-key",
        label: "Anthropic API key",
        hint: "Direct Anthropic API key",
        optionKey: "anthropicApiKey",
        flagName: "--anthropic-api-key",
        envVar: "ANTHROPIC_API_KEY",
        promptMessage: "Enter Anthropic API key",
        defaultModel: defaultAnthropicModel,
        expectedProviders: ["anthropic"],
        wizard: {
          choiceId: "apiKey",
          choiceLabel: "Anthropic API key",
          groupId: "anthropic",
          groupLabel: "Anthropic",
          groupHint: "Claude CLI + API key",
        },
      }),
    ],
    normalizeConfig: ({ providerConfig }) => normalizeAnthropicProviderConfig(providerConfig),
    normalizeModelId: ({ modelId }) => normalizeAnthropicModelId(modelId),
    applyConfigDefaults: ({ config, env }) => applyAnthropicConfigDefaults({ config, env }),
    augmentModelCatalog: (ctx) => buildAnthropicCliCatalogEntries(ctx),
    resolveDynamicModel: (ctx) => {
      const model = resolveAnthropicForwardCompatModel(ctx);
      if (!model) {
        return undefined;
      }
      return (
        applyAnthropicOpusContextWindow({
          config: ctx.config,
          provider: ctx.provider,
          modelId: ctx.modelId,
          model,
        }) ?? model
      );
    },
    normalizeResolvedModel: (ctx) => applyAnthropicOpusContextWindow(ctx),
    resolveSyntheticAuth: ({ provider }) =>
      isClaudeCliFamilyProvider(provider) ? resolveClaudeCliSyntheticAuth() : undefined,
    buildReplayPolicy: buildAnthropicReplayPolicy,
    isModernModelRef: ({ modelId }) => matchesAnthropicModernModel(modelId),
    resolveReasoningOutputMode: () => "native",
    wrapStreamFn: wrapAnthropicProviderStream,
    supportsXHighThinking: ({ modelId }) => supportsAnthropicOpusXHighThinking(modelId),
    resolveDefaultThinkingLevel: ({ modelId }) =>
      isAnthropicOpusLongContextModel(modelId)
        ? "off"
        : matchesAnthropicModernModel(modelId) && shouldUseAnthropicAdaptiveThinkingDefault(modelId)
          ? "adaptive"
          : undefined,
    resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
    fetchUsageSnapshot: async (ctx) =>
      await fetchClaudeUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
    isCacheTtlEligible: () => true,
    buildAuthDoctorHint: (ctx) =>
      buildAnthropicAuthDoctorHint({
        config: ctx.config,
        store: ctx.store,
        profileId: ctx.profileId,
      }),
  });
  api.registerMediaUnderstandingProvider(anthropicMediaUnderstandingProvider);
}
