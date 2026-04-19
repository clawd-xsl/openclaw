import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";
import {
  CLAUDE_CLI_BACKEND_ID,
  CLAUDE_CLI_STREAMING_BACKEND_ID,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CLAUDE_CLI_STREAMING_DEFAULT_MODEL_REF,
  CLAUDE_CLI_CLEAR_ENV,
  CLAUDE_CLI_MODEL_ALIASES,
  CLAUDE_CLI_SESSION_ID_FIELDS,
  normalizeClaudeBackendConfig,
} from "./cli-shared.js";

function buildClaudeBaseConfig(defaultModelRef: string): Omit<CliBackendPlugin, "id" | "config"> {
  return {
    liveTest: {
      defaultModelRef,
      defaultImageProbe: true,
      defaultMcpProbe: true,
      docker: {
        npmPackage: "@anthropic-ai/claude-code",
        binaryName: "claude",
      },
    },
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    normalizeConfig: normalizeClaudeBackendConfig,
  };
}

export function buildAnthropicCliBackend(): CliBackendPlugin {
  return {
    ...buildClaudeBaseConfig(CLAUDE_CLI_DEFAULT_MODEL_REF),
    id: CLAUDE_CLI_BACKEND_ID,
    config: {
      command: "claude",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--tools",
        "",
        "--disable-slash-commands",
        "--setting-sources",
        "",
        "--settings",
        '{"disableAllHooks":true}',
        "--permission-mode",
        "bypassPermissions",
      ],
      resumeArgs: [
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--tools",
        "",
        "--disable-slash-commands",
        "--setting-sources",
        "",
        "--settings",
        '{"disableAllHooks":true}',
        "--permission-mode",
        "bypassPermissions",
        "--resume",
        "{sessionId}",
      ],
      output: "jsonl",
      jsonlDialect: "claude-stream-json",
      input: "stdin",
      modelArg: "--model",
      modelAliases: CLAUDE_CLI_MODEL_ALIASES,
      sessionArg: "--session-id",
      sessionMode: "always",
      sessionIdFields: [...CLAUDE_CLI_SESSION_ID_FIELDS],
      systemPromptArg: "--system-prompt",
      systemPromptMode: "replace",
      systemPromptWhen: "always",
      env: {
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      },
      clearEnv: [...CLAUDE_CLI_CLEAR_ENV],
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      serialize: true,
    },
  };
}

export function buildAnthropicStreamingCliBackend(): CliBackendPlugin {
  return {
    ...buildClaudeBaseConfig(CLAUDE_CLI_STREAMING_DEFAULT_MODEL_REF),
    id: CLAUDE_CLI_STREAMING_BACKEND_ID,
    config: {
      command: "claude",
      executionMode: "persistent-process",
      args: [
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--tools",
        "",
        "--disable-slash-commands",
        "--setting-sources",
        "",
        "--settings",
        '{"disableAllHooks":true}',
        "--permission-mode",
        "bypassPermissions",
      ],
      resumeArgs: [
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--tools",
        "",
        "--disable-slash-commands",
        "--setting-sources",
        "",
        "--settings",
        '{"disableAllHooks":true}',
        "--permission-mode",
        "bypassPermissions",
        "--resume",
        "{sessionId}",
      ],
      output: "jsonl",
      jsonlDialect: "claude-stream-json",
      input: "stdin",
      modelArg: "--model",
      modelAliases: CLAUDE_CLI_MODEL_ALIASES,
      sessionArg: "--session-id",
      sessionMode: "always",
      sessionIdFields: [...CLAUDE_CLI_SESSION_ID_FIELDS],
      systemPromptArg: "--system-prompt",
      systemPromptMode: "replace",
      systemPromptWhen: "always",
      env: {
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      },
      clearEnv: [...CLAUDE_CLI_CLEAR_ENV],
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      serialize: true,
    },
  };
}
