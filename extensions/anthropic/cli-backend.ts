/**
 * Claude CLI backend descriptor. It configures Claude Code process arguments,
 * MCP bundling, session handling, environment scrubbing, and watchdog defaults.
 */
import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";
import {
  CLAUDE_CLI_BACKEND_ID,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CLAUDE_CLI_CLEAR_ENV,
  CLAUDE_CLI_MODEL_ALIASES,
  CLAUDE_CLI_SESSION_ID_FIELDS,
  normalizeClaudeBackendConfig,
  resolveClaudeCliExecutionArgs,
} from "./cli-shared.js";

/** Build the Claude CLI backend plugin descriptor. */
export function buildAnthropicCliBackend(): CliBackendPlugin {
  return {
    id: CLAUDE_CLI_BACKEND_ID,
    modelProvider: "anthropic",
    liveTest: {
      defaultModelRef: CLAUDE_CLI_DEFAULT_MODEL_REF,
      defaultImageProbe: true,
      defaultMcpProbe: true,
      docker: {
        npmPackage: "@anthropic-ai/claude-code",
        binaryName: "claude",
      },
    },
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    bundleMcpToolSurface: "openclaw",
    nativeToolMode: "none",
    sideQuestionToolMode: "disabled",
    ownsNativeCompaction: true,
    config: {
      command: "claude",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--tools",
        "ToolSearch",
        "--disable-slash-commands",
        "--setting-sources",
        "",
        "--settings",
        '{"disableAllHooks":true}',
        "--allowedTools",
        "mcp__openclaw__*",
      ],
      resumeArgs: [
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--tools",
        "ToolSearch",
        "--disable-slash-commands",
        "--setting-sources",
        "",
        "--settings",
        '{"disableAllHooks":true}',
        "--allowedTools",
        "mcp__openclaw__*",
        "--resume",
        "{sessionId}",
      ],
      output: "jsonl",
      liveSession: "claude-stdio",
      input: "stdin",
      modelArg: "--model",
      modelAliases: CLAUDE_CLI_MODEL_ALIASES,
      imageArg: "@",
      imagePathScope: "workspace",
      sessionArg: "--session-id",
      sessionMode: "always",
      reseedFromRawTranscriptWhenUncompacted: true,
      sessionIdFields: [...CLAUDE_CLI_SESSION_ID_FIELDS],
      systemPromptFileArg: "--system-prompt-file",
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
    normalizeConfig: normalizeClaudeBackendConfig,
    resolveExecutionArgs: resolveClaudeCliExecutionArgs,
  };
}
