/**
 * Resolves CLI runtime aliases to provider/model auth labels and execution ids.
 */
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isCliRuntimeModelBackendForProvider,
  isRuntimeRegisteredCliBackend,
  listCliRuntimeModelBackendBindings,
  listCliRuntimeProviderIds,
  resolveCliRuntimeCanonicalProvider,
  resolveCliRuntimeModelBackendBinding,
} from "./cli-backends.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";
import { isCliProvider } from "./model-selection-cli.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";

/** True for CLI runtime provider ids such as `claude-cli` and `google-gemini-cli`. */
export function isCliRuntimeProvider(
  provider: string,
  params: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv; includeSetupRegistry?: boolean } = {},
): boolean {
  const normalized = normalizeProviderId(provider);
  return listCliRuntimeProviderIds({
    config: params.config,
    env: params.env,
    includeSetupRegistry:
      params.includeSetupRegistry ?? (params.config !== undefined || params.env !== undefined),
  }).includes(normalized);
}

export function isCliRuntimeAlias(runtime: string | undefined): boolean {
  const normalized = normalizeProviderId(runtime ?? "");
  return normalized
    ? listCliRuntimeModelBackendBindings().some((binding) => binding.runtime === normalized)
    : false;
}

export function isCliRuntimeAliasForProvider(params: {
  runtime: string | undefined;
  provider: string | undefined;
  cfg?: OpenClawConfig;
}): boolean {
  return isCliRuntimeModelBackendForProvider({
    provider: params.provider,
    runtime: params.runtime,
    config: params.cfg,
  });
}

type RuntimeAliasComparisonOptions = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  includeSetupRegistry?: boolean;
};

function canonicalizeRuntimeAliasProvider(
  provider: string,
  options: RuntimeAliasComparisonOptions = {},
): string {
  return (
    resolveCliRuntimeCanonicalProvider({
      runtime: provider,
      config: options.config,
      env: options.env,
      includeSetupRegistry:
        options.includeSetupRegistry ?? (options.config !== undefined || options.env !== undefined),
    }) ?? provider
  );
}

function normalizeRuntimeModelRefForComparison(
  raw: string,
  options: RuntimeAliasComparisonOptions = {},
): string {
  const trimmed = raw.trim();
  const parsed = parseModelCatalogRef(trimmed);
  if (!parsed) {
    return normalizeProviderId(canonicalizeRuntimeAliasProvider(trimmed, options));
  }
  const canonicalProvider = normalizeProviderId(
    canonicalizeRuntimeAliasProvider(parsed.provider, options),
  );
  return `${canonicalProvider}/${parsed.modelId}`;
}

function normalizeRuntimeModelRefWithoutAlias(raw: string): string {
  const trimmed = raw.trim();
  const parsed = parseModelCatalogRef(trimmed);
  if (!parsed) {
    return normalizeProviderId(trimmed);
  }
  return `${parsed.provider}/${parsed.modelId}`;
}

export function areRuntimeModelRefsEquivalent(
  left: string,
  right: string,
  options: RuntimeAliasComparisonOptions = {},
): boolean {
  if (normalizeRuntimeModelRefWithoutAlias(left) === normalizeRuntimeModelRefWithoutAlias(right)) {
    return true;
  }
  return (
    normalizeRuntimeModelRefForComparison(left, options) ===
    normalizeRuntimeModelRefForComparison(right, options)
  );
}

export function shouldPreferActiveRuntimeAliasAuthLabel(params: {
  runtimeAliasModelEquivalent: boolean;
  selectedAuthLabel?: string;
  activeAuthLabel?: string;
}): boolean {
  if (!params.runtimeAliasModelEquivalent) {
    return false;
  }
  const selectedAuth = normalizeOptionalLowercaseString(params.selectedAuthLabel);
  const activeAuth = normalizeOptionalLowercaseString(params.activeAuthLabel);
  if (!activeAuth || activeAuth === "unknown") {
    return false;
  }
  return (
    selectedAuth === "unknown" ||
    (Boolean(selectedAuth?.startsWith("api-key")) &&
      (activeAuth.startsWith("oauth") || activeAuth.startsWith("token")))
  );
}

function resolveConfiguredRuntime(params: {
  cfg?: OpenClawConfig;
  provider: string;
  agentId?: string;
  modelId?: string;
}): { runtime?: string; matchedProvider?: string } {
  const policy = resolveModelRuntimePolicy({
    config: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
  });
  return {
    runtime: policy.policy?.id?.trim() || undefined,
    matchedProvider: policy.matchedProvider,
  };
}

function resolveProfileRuntimeAlias(params: {
  cfg?: OpenClawConfig;
  provider: string;
  profileId: string;
}): string | undefined {
  const profile = params.cfg?.auth?.profiles?.[params.profileId];
  if (!profile?.provider) {
    return undefined;
  }
  const provider = normalizeProviderId(params.provider);
  const profileProvider = normalizeProviderId(profile.provider);
  if (!provider || !profileProvider) {
    return undefined;
  }
  const providerAuthKey = resolveProviderIdForAuth(provider, { config: params.cfg });
  const profileAuthKey = resolveProviderIdForAuth(profileProvider, { config: params.cfg });
  if (providerAuthKey !== profileAuthKey) {
    return undefined;
  }
  if (profileProvider === provider) {
    return undefined;
  }
  return resolveCliRuntimeModelBackendBinding({
    config: params.cfg,
    provider,
    runtime: profileProvider,
  })?.runtime;
}

function resolveCliRuntimeFromAuthProfile(params: {
  cfg?: OpenClawConfig;
  provider: string;
  authProfileId?: string;
}): string | undefined {
  if (!params.cfg?.auth?.profiles) {
    return undefined;
  }
  if (params.authProfileId?.trim()) {
    return resolveProfileRuntimeAlias({
      cfg: params.cfg,
      provider: params.provider,
      profileId: params.authProfileId.trim(),
    });
  }

  const provider = normalizeProviderId(params.provider);
  const providerAuthKey = resolveProviderIdForAuth(provider, { config: params.cfg });
  const orderedProfileIds = [
    ...(params.cfg.auth.order?.[providerAuthKey] ?? []),
    ...(providerAuthKey === provider ? [] : (params.cfg.auth.order?.[provider] ?? [])),
  ];
  for (const profileId of orderedProfileIds) {
    const profile = params.cfg.auth.profiles[profileId];
    if (!profile?.provider) {
      continue;
    }
    const profileAuthKey = resolveProviderIdForAuth(profile.provider, { config: params.cfg });
    if (profileAuthKey !== providerAuthKey) {
      continue;
    }
    return resolveProfileRuntimeAlias({ cfg: params.cfg, provider, profileId });
  }

  const compatibleProfileIds = Object.entries(params.cfg.auth.profiles)
    .filter(([, profile]) => {
      if (!profile?.provider) {
        return false;
      }
      return resolveProviderIdForAuth(profile.provider, { config: params.cfg }) === providerAuthKey;
    })
    .map(([profileId]) => profileId);
  if (compatibleProfileIds.length !== 1) {
    return undefined;
  }
  const [profileId] = compatibleProfileIds;
  return profileId
    ? resolveProfileRuntimeAlias({ cfg: params.cfg, provider, profileId })
    : undefined;
}

export function resolveCliRuntimeExecutionProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentId?: string;
  modelId?: string;
  authProfileId?: string;
}): string | undefined {
  const provider = normalizeProviderId(params.provider);
  const { runtime, matchedProvider } = resolveConfiguredRuntime({ ...params, provider });
  if (runtime === "openclaw") {
    return undefined;
  }
  if (!runtime || runtime === "auto") {
    return resolveCliRuntimeFromAuthProfile({ ...params, provider });
  }
  const effectiveProvider = provider || normalizeProviderId(matchedProvider ?? "");
  if (!effectiveProvider) {
    return undefined;
  }
  return resolveCliRuntimeModelBackendBinding({
    config: params.cfg,
    provider: effectiveProvider,
    runtime,
  })?.runtime;
}

/** Resolves the runtime provider override stored on a session entry. */
export function resolveSessionRuntimeOverrideForProvider(params: {
  provider: string;
  entry?: Pick<SessionEntry, "agentRuntimeOverride">;
  cfg?: OpenClawConfig;
}): string | undefined {
  const provider = normalizeProviderId(params.provider);
  const runtime = normalizeOptionalLowercaseString(params.entry?.agentRuntimeOverride) ?? "";
  if (!runtime || runtime === "auto" || runtime === "default") {
    return undefined;
  }
  if (provider === "openai" && runtime === "codex") {
    return "codex";
  }
  if (isCliRuntimeAliasForProvider({ provider, runtime, cfg: params.cfg })) {
    return runtime;
  }
  return undefined;
}

/**
 * Single decision seam for CLI-backend execution dispatch, shared by the
 * main-turn, followup, memory-flush, cron, command, and embedded runners.
 * Returns the CLI execution provider (backend id, e.g. "claude-cli") when the
 * run must execute through a CLI harness, or undefined for the embedded/API
 * path. Precedence: validated session runtime override, then the configured
 * agentRuntime binding / auth-profile inference (an explicit "openclaw" policy
 * pins embedded), then standalone CLI backends' own provider-prefixed refs.
 *
 * Provider-prefixed refs of runtime-ALIAS backends (model refs like
 * claude-cli/<model>, whose backend serves a canonical model provider) are
 * retired input and THROW: the canonical config is the API provider ref plus
 * the agentRuntime binding. "claude-cli" stays valid everywhere else — as this
 * seam's OUTPUT, as a session-binding/auth key, and as an agentRuntime id.
 */
export function resolveCliExecutionDispatch(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentId?: string | undefined;
  modelId?: string | undefined;
  authProfileId?: string | undefined;
  /** Session override, already validated by resolveSessionRuntimeOverrideForProvider. */
  runtimeOverride?: string | undefined;
}): string | undefined {
  const override = normalizeProviderId(params.runtimeOverride ?? "");
  if (override && isCliProvider(override, params.cfg)) {
    return override;
  }
  const bound = resolveCliRuntimeExecutionProvider({
    provider: params.provider,
    cfg: params.cfg,
    agentId: params.agentId,
    modelId: params.modelId,
    ...(params.authProfileId !== undefined ? { authProfileId: params.authProfileId } : {}),
  });
  if (bound) {
    return isCliProvider(bound, params.cfg) ? bound : undefined;
  }
  const provider = normalizeProviderId(params.provider);
  if (!provider || !isCliProvider(provider, params.cfg)) {
    return undefined;
  }
  // Loaded surfaces first (registry bindings are in-memory): only fall back to
  // the setup registry when neither the runtime registry nor config owns the
  // backend — its per-call register()/fs probes are hot-path poison, and this
  // tail runs per fallback candidate.
  const canonical = resolveCliRuntimeCanonicalProvider({ runtime: provider, config: params.cfg });
  if (canonical && canonical !== provider) {
    throw buildRetiredCliRefError(provider, canonical, params.cfg);
  }
  const ownedByLoadedSurface =
    Object.keys(params.cfg?.agents?.defaults?.cliBackends ?? {}).some(
      (key) => normalizeProviderId(key) === provider,
    ) || isRuntimeRegisteredCliBackend(provider);
  if (ownedByLoadedSurface) {
    // Standalone CLI backend without a canonical model provider: direct
    // <backend>/<model> refs are its only spelling — dispatch as-is.
    return provider;
  }
  const setupCanonical = resolveCliRuntimeCanonicalProvider({
    runtime: provider,
    config: params.cfg,
    includeSetupRegistry: true,
  });
  if (setupCanonical && setupCanonical !== provider) {
    throw buildRetiredCliRefError(provider, setupCanonical, params.cfg);
  }
  return provider;
}

function buildRetiredCliRefError(provider: string, canonical: string, cfg?: OpenClawConfig): Error {
  // Only claim the auth-profile recovery path when the backend id actually
  // aliases to the canonical provider's auth key (claude-cli -> anthropic
  // does; google-gemini-cli does not, so that profile can never auto-bind).
  const authAliasWorks =
    resolveProviderIdForAuth(provider, { config: cfg }) ===
    resolveProviderIdForAuth(canonical, { config: cfg });
  const authHint = authAliasWorks
    ? ` (or keep a "${provider}" auth profile for automatic binding)`
    : "";
  return new Error(
    `Model refs with the CLI runtime provider "${provider}" are retired. ` +
      `Use the canonical "${canonical}/<model>" ref and configure the agentRuntime binding${authHint}. ` +
      `Run \`openclaw doctor --fix\` to migrate model config, and reset session or cron ` +
      `model overrides that still use "${provider}/..." manually.`,
  );
}
