import type { CliBackendConfig } from "openclaw/plugin-sdk/cli-backend";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";

export const CLAUDE_CLI_BACKEND_ID = "claude-cli";
export const CLAUDE_CLI_STREAMING_BACKEND_ID = "claude-cli-streaming";
export const CLAUDE_CLI_BACKEND_IDS = [
  CLAUDE_CLI_BACKEND_ID,
  CLAUDE_CLI_STREAMING_BACKEND_ID,
] as const;
type ClaudeCliBackendId = (typeof CLAUDE_CLI_BACKEND_IDS)[number];

export function buildClaudeCliModelRef(backendId: ClaudeCliBackendId, modelId: string): string {
  return `${backendId}/${modelId}`;
}

export function buildClaudeCliAllowlistRefs(backendId: ClaudeCliBackendId): readonly string[] {
  return [
    buildClaudeCliModelRef(backendId, "claude-opus-4-8"),
    buildClaudeCliModelRef(backendId, "claude-opus-4-8[1m]"),
    buildClaudeCliModelRef(backendId, "claude-opus-4-7"),
    buildClaudeCliModelRef(backendId, "claude-sonnet-4-6"),
    buildClaudeCliModelRef(backendId, "claude-opus-4-6"),
    buildClaudeCliModelRef(backendId, "claude-opus-4-5"),
    buildClaudeCliModelRef(backendId, "claude-sonnet-4-5"),
    buildClaudeCliModelRef(backendId, "claude-haiku-4-5"),
  ] as const;
}

export const CLAUDE_CLI_DEFAULT_MODEL_REF = `${CLAUDE_CLI_BACKEND_ID}/claude-opus-4-8`;
export const CLAUDE_CLI_STREAMING_DEFAULT_MODEL_REF = buildClaudeCliModelRef(
  CLAUDE_CLI_STREAMING_BACKEND_ID,
  "claude-opus-4-8",
);
export const CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS = buildClaudeCliAllowlistRefs(CLAUDE_CLI_BACKEND_ID);
export const CLAUDE_CLI_STREAMING_DEFAULT_ALLOWLIST_REFS = buildClaudeCliAllowlistRefs(
  CLAUDE_CLI_STREAMING_BACKEND_ID,
);

export const CLAUDE_CLI_MODEL_ALIASES: Record<string, string> = {
  opus: "opus",
  "opus-4.8": "claude-opus-4-8",
  "opus-4.8[1m]": "claude-opus-4-8[1m]",
  "opus-4.8-1m": "claude-opus-4-8[1m]",
  "opus-4.7": "claude-opus-4-7",
  "opus-4.6": "claude-opus-4-6",
  "opus-4.5": "claude-opus-4-5",
  "opus-4": "opus",
  "claude-opus-4-8": "claude-opus-4-8",
  "claude-opus-4-8[1m]": "claude-opus-4-8[1m]",
  "claude-opus-4-7": "claude-opus-4-7",
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-opus-4-5": "claude-opus-4-5",
  "claude-opus-4": "opus",
  sonnet: "sonnet",
  "sonnet-4.6": "claude-sonnet-4-6",
  "sonnet-4.5": "claude-sonnet-4-5",
  "sonnet-4.1": "claude-sonnet-4-1",
  "sonnet-4.0": "claude-sonnet-4-0",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-sonnet-4-5": "claude-sonnet-4-5",
  "claude-sonnet-4-1": "claude-sonnet-4-1",
  "claude-sonnet-4-0": "claude-sonnet-4-0",
  haiku: "haiku",
  "haiku-3.5": "haiku",
  "claude-haiku-3-5": "haiku",
};

export const CLAUDE_CLI_SESSION_ID_FIELDS = [
  "session_id",
  "sessionId",
  "conversation_id",
  "conversationId",
] as const;

// Claude Code honors provider-routing, auth, and config-root env before
// consulting its local login state, so inherited shell overrides must not
// steer OpenClaw-managed Claude CLI runs toward a different provider,
// endpoint, token source, plugin/config tree, or telemetry bootstrap mode.
export const CLAUDE_CLI_CLEAR_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_OLD",
  "ANTHROPIC_API_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  "CLAUDE_CODE_PLUGIN_SEED_DIR",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_USE_COWORK_PLUGINS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_SDK_DISABLED",
  "OTEL_TRACES_EXPORTER",
] as const;

const CLAUDE_LEGACY_SKIP_PERMISSIONS_ARG = "--dangerously-skip-permissions";
const CLAUDE_PERMISSION_MODE_ARG = "--permission-mode";
const CLAUDE_BYPASS_PERMISSIONS_MODE = "bypassPermissions";
const CLAUDE_SETTING_SOURCES_ARG = "--setting-sources";
const CLAUDE_ISOLATED_SETTING_SOURCES = "";
const CLAUDE_TOOLS_ARG = "--tools";
const CLAUDE_DISABLE_BUILTINS_VALUE = "";
const CLAUDE_SETTINGS_ARG = "--settings";
const CLAUDE_DISABLE_ALL_HOOKS_SETTINGS = JSON.stringify({ disableAllHooks: true });
const CLAUDE_SYSTEM_PROMPT_ARG = "--system-prompt";
const CLAUDE_SYSTEM_PROMPT_FILE_ARG = "--system-prompt-file";
const CLAUDE_DISABLE_CLAUDE_MDS_ENV = "CLAUDE_CODE_DISABLE_CLAUDE_MDS";
const CLAUDE_DISABLE_SLASH_COMMANDS_ARG = "--disable-slash-commands";

function normalizeClaudeSystemPromptWhen(
  when: CliBackendConfig["systemPromptWhen"],
): CliBackendConfig["systemPromptWhen"] {
  // Claude Code does not persist custom system prompts across resumed sessions,
  // so OpenClaw must keep re-supplying them unless the operator disables them.
  return when === "never" ? "never" : "always";
}

export function normalizeClaudeIsolationArgs(args?: string[]): string[] | undefined {
  if (!args) {
    return args;
  }
  const normalized: string[] = [];
  let hasTools = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === CLAUDE_TOOLS_ARG) {
      hasTools = true;
      const maybeValue = args[i + 1];
      if (typeof maybeValue === "string" && !maybeValue.startsWith("-")) {
        normalized.push(arg, CLAUDE_DISABLE_BUILTINS_VALUE);
        i += 1;
      } else {
        normalized.push(arg, CLAUDE_DISABLE_BUILTINS_VALUE);
      }
      continue;
    }
    if (arg.startsWith(`${CLAUDE_TOOLS_ARG}=`)) {
      hasTools = true;
      normalized.push(CLAUDE_TOOLS_ARG, CLAUDE_DISABLE_BUILTINS_VALUE);
      continue;
    }
    normalized.push(arg);
  }
  if (!hasTools) {
    normalized.push(CLAUDE_TOOLS_ARG, CLAUDE_DISABLE_BUILTINS_VALUE);
  }
  return normalized;
}

export function normalizeClaudeSlashCommandArgs(args?: string[]): string[] | undefined {
  if (!args) {
    return args;
  }
  const normalized: string[] = [];
  let hasDisableSlashCommands = false;
  for (const arg of args) {
    if (arg === CLAUDE_DISABLE_SLASH_COMMANDS_ARG) {
      hasDisableSlashCommands = true;
    }
    normalized.push(arg);
  }
  if (!hasDisableSlashCommands) {
    normalized.push(CLAUDE_DISABLE_SLASH_COMMANDS_ARG);
  }
  return normalized;
}

function normalizeClaudeEnv(env?: Record<string, string>): Record<string, string> {
  return {
    ...env,
    [CLAUDE_DISABLE_CLAUDE_MDS_ENV]: "1",
  };
}

export function isClaudeCliProvider(providerId: string): boolean {
  return normalizeOptionalLowercaseString(providerId) === CLAUDE_CLI_BACKEND_ID;
}

export function isClaudeCliStreamingProvider(providerId: string): boolean {
  return normalizeOptionalLowercaseString(providerId) === CLAUDE_CLI_STREAMING_BACKEND_ID;
}

export function isClaudeCliFamilyProvider(providerId: string): boolean {
  const normalized = normalizeOptionalLowercaseString(providerId);
  return normalized ? CLAUDE_CLI_BACKEND_IDS.includes(normalized as ClaudeCliBackendId) : false;
}

export function normalizeClaudePermissionArgs(args?: string[]): string[] | undefined {
  if (!args) {
    return args;
  }
  const normalized: string[] = [];
  let hasPermissionMode = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === CLAUDE_LEGACY_SKIP_PERMISSIONS_ARG) {
      continue;
    }
    if (arg === CLAUDE_PERMISSION_MODE_ARG) {
      const maybeValue = args[i + 1];
      if (
        typeof maybeValue === "string" &&
        maybeValue.trim().length > 0 &&
        !maybeValue.startsWith("-")
      ) {
        hasPermissionMode = true;
        normalized.push(arg);
        normalized.push(maybeValue);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith(`${CLAUDE_PERMISSION_MODE_ARG}=`)) {
      hasPermissionMode = true;
    }
    normalized.push(arg);
  }
  if (!hasPermissionMode) {
    normalized.push(CLAUDE_PERMISSION_MODE_ARG, CLAUDE_BYPASS_PERMISSIONS_MODE);
  }
  return normalized;
}

export function normalizeClaudeSettingSourcesArgs(args?: string[]): string[] | undefined {
  if (!args) {
    return args;
  }
  const normalized: string[] = [];
  let hasSettingSources = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === CLAUDE_SETTING_SOURCES_ARG) {
      const maybeValue = args[i + 1];
      if (typeof maybeValue === "string" && !maybeValue.startsWith("-")) {
        hasSettingSources = true;
        normalized.push(arg, CLAUDE_ISOLATED_SETTING_SOURCES);
        i += 1;
      } else {
        hasSettingSources = true;
        normalized.push(arg, CLAUDE_ISOLATED_SETTING_SOURCES);
      }
      continue;
    }
    if (arg.startsWith(`${CLAUDE_SETTING_SOURCES_ARG}=`)) {
      hasSettingSources = true;
      normalized.push(`${CLAUDE_SETTING_SOURCES_ARG}=${CLAUDE_ISOLATED_SETTING_SOURCES}`);
      continue;
    }
    normalized.push(arg);
  }
  if (!hasSettingSources) {
    normalized.push(CLAUDE_SETTING_SOURCES_ARG, CLAUDE_ISOLATED_SETTING_SOURCES);
  }
  return normalized;
}

function normalizeClaudeSettingsValue(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    return CLAUDE_DISABLE_ALL_HOOKS_SETTINGS;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return CLAUDE_DISABLE_ALL_HOOKS_SETTINGS;
    }
    return JSON.stringify({
      ...parsed,
      disableAllHooks: true,
    });
  } catch {
    return CLAUDE_DISABLE_ALL_HOOKS_SETTINGS;
  }
}

export function normalizeClaudeSettingsArgs(args?: string[]): string[] | undefined {
  if (!args) {
    return args;
  }
  const normalized: string[] = [];
  let hasSettings = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === CLAUDE_SETTINGS_ARG) {
      const maybeValue = args[i + 1];
      if (typeof maybeValue === "string" && !maybeValue.startsWith("-")) {
        hasSettings = true;
        normalized.push(arg, normalizeClaudeSettingsValue(maybeValue));
        i += 1;
      } else {
        hasSettings = true;
        normalized.push(arg, CLAUDE_DISABLE_ALL_HOOKS_SETTINGS);
      }
      continue;
    }
    if (arg.startsWith(`${CLAUDE_SETTINGS_ARG}=`)) {
      hasSettings = true;
      normalized.push(
        `${CLAUDE_SETTINGS_ARG}=${normalizeClaudeSettingsValue(
          arg.slice(`${CLAUDE_SETTINGS_ARG}=`.length),
        )}`,
      );
      continue;
    }
    normalized.push(arg);
  }
  if (!hasSettings) {
    normalized.push(CLAUDE_SETTINGS_ARG, CLAUDE_DISABLE_ALL_HOOKS_SETTINGS);
  }
  return normalized;
}

export function normalizeClaudeBackendConfig(config: CliBackendConfig): CliBackendConfig {
  return {
    ...config,
    args: normalizeClaudePermissionArgs(
      normalizeClaudeSettingsArgs(
        normalizeClaudeSettingSourcesArgs(
          normalizeClaudeSlashCommandArgs(normalizeClaudeIsolationArgs(config.args)),
        ),
      ),
    ),
    resumeArgs: normalizeClaudePermissionArgs(
      normalizeClaudeSettingsArgs(
        normalizeClaudeSettingSourcesArgs(
          normalizeClaudeSlashCommandArgs(normalizeClaudeIsolationArgs(config.resumeArgs)),
        ),
      ),
    ),
    env: normalizeClaudeEnv(config.env),
    systemPromptArg: CLAUDE_SYSTEM_PROMPT_ARG,
    systemPromptFileConfigArg: CLAUDE_SYSTEM_PROMPT_FILE_ARG,
    systemPromptMode: "replace",
    systemPromptWhen: normalizeClaudeSystemPromptWhen(config.systemPromptWhen),
  };
}
