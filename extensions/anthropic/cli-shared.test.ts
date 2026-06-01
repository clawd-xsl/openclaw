import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend, buildAnthropicStreamingCliBackend } from "./cli-backend.js";
import {
  CLAUDE_CLI_CLEAR_ENV,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CLAUDE_CLI_MODEL_ALIASES,
  CLAUDE_NATIVE_TOOL_DENYLIST_VALUE,
  normalizeClaudeBackendConfig,
  normalizeClaudeIsolationArgs,
  normalizeClaudePermissionArgs,
  normalizeClaudeSlashCommandArgs,
  normalizeClaudeSettingsArgs,
  normalizeClaudeSettingSourcesArgs,
} from "./cli-shared.js";

describe("normalizeClaudePermissionArgs", () => {
  it("pins the Claude CLI default to Opus 4.8", () => {
    expect(CLAUDE_CLI_DEFAULT_MODEL_REF).toBe("claude-cli/claude-opus-4-8");
    expect(CLAUDE_CLI_MODEL_ALIASES["opus-4.8"]).toBe("claude-opus-4-8");
    expect(CLAUDE_CLI_MODEL_ALIASES["opus-4.8[1m]"]).toBe("claude-opus-4-8[1m]");
    expect(CLAUDE_CLI_MODEL_ALIASES["claude-opus-4-8"]).toBe("claude-opus-4-8");
    expect(CLAUDE_CLI_MODEL_ALIASES["claude-opus-4-8[1m]"]).toBe("claude-opus-4-8[1m]");
    expect(CLAUDE_CLI_MODEL_ALIASES["claude-opus-4-7"]).toBe("claude-opus-4-7");
  });

  it("injects bypassPermissions when args omit permission flags", () => {
    expect(
      normalizeClaudePermissionArgs(["-p", "--output-format", "stream-json", "--verbose"]),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  it("removes legacy skip-permissions and injects bypassPermissions", () => {
    expect(
      normalizeClaudePermissionArgs(["-p", "--dangerously-skip-permissions", "--verbose"]),
    ).toEqual(["-p", "--verbose", "--permission-mode", "bypassPermissions"]);
  });

  it("keeps explicit permission-mode overrides", () => {
    expect(normalizeClaudePermissionArgs(["-p", "--permission-mode", "acceptEdits"])).toEqual([
      "-p",
      "--permission-mode",
      "acceptEdits",
    ]);
    expect(normalizeClaudePermissionArgs(["-p", "--permission-mode=acceptEdits"])).toEqual([
      "-p",
      "--permission-mode=acceptEdits",
    ]);
  });

  it("treats a bare permission-mode flag as malformed and falls back to bypassPermissions", () => {
    expect(
      normalizeClaudePermissionArgs(["-p", "--permission-mode", "--output-format", "stream-json"]),
    ).toEqual(["-p", "--output-format", "stream-json", "--permission-mode", "bypassPermissions"]);
  });
});

describe("normalizeClaudeSettingSourcesArgs", () => {
  it("injects empty setting sources when args omit the flag", () => {
    expect(
      normalizeClaudeSettingSourcesArgs(["-p", "--output-format", "stream-json", "--verbose"]),
    ).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--setting-sources", ""]);
  });

  it("forces explicit project or local setting sources back to empty", () => {
    expect(normalizeClaudeSettingSourcesArgs(["-p", "--setting-sources", "project"])).toEqual([
      "-p",
      "--setting-sources",
      "",
    ]);
    expect(normalizeClaudeSettingSourcesArgs(["-p", "--setting-sources=local,user"])).toEqual([
      "-p",
      "--setting-sources=",
    ]);
  });

  it("treats a bare setting-sources flag as malformed and falls back to empty", () => {
    expect(
      normalizeClaudeSettingSourcesArgs([
        "-p",
        "--setting-sources",
        "--output-format",
        "stream-json",
      ]),
    ).toEqual(["-p", "--setting-sources", "", "--output-format", "stream-json"]);
  });
});

describe("normalizeClaudeIsolationArgs", () => {
  it("disallows native Claude tools when args omit the flag", () => {
    expect(
      normalizeClaudeIsolationArgs(["-p", "--output-format", "stream-json", "--verbose"]),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--disallowedTools",
      CLAUDE_NATIVE_TOOL_DENYLIST_VALUE,
    ]);
  });

  it("removes legacy --tools overrides and keeps the native denylist", () => {
    expect(normalizeClaudeIsolationArgs(["-p", "--tools", "Bash,Edit"])).toEqual([
      "-p",
      "--disallowedTools",
      CLAUDE_NATIVE_TOOL_DENYLIST_VALUE,
    ]);
    expect(normalizeClaudeIsolationArgs(["-p", "--tools=default"])).toEqual([
      "-p",
      "--disallowedTools",
      CLAUDE_NATIVE_TOOL_DENYLIST_VALUE,
    ]);
  });
});

describe("normalizeClaudeSlashCommandArgs", () => {
  it("injects disable-slash-commands when args omit the flag", () => {
    expect(
      normalizeClaudeSlashCommandArgs(["-p", "--output-format", "stream-json", "--verbose"]),
    ).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--disable-slash-commands"]);
  });

  it("does not duplicate disable-slash-commands when already present", () => {
    expect(
      normalizeClaudeSlashCommandArgs([
        "-p",
        "--disable-slash-commands",
        "--output-format",
        "stream-json",
      ]),
    ).toEqual(["-p", "--disable-slash-commands", "--output-format", "stream-json"]);
  });
});

describe("normalizeClaudeSettingsArgs", () => {
  it("injects disableAllHooks when args omit the flag", () => {
    expect(normalizeClaudeSettingsArgs(["-p", "--output-format", "stream-json"])).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--settings",
      '{"disableAllHooks":true}',
    ]);
  });

  it("merges disableAllHooks into explicit settings JSON", () => {
    expect(normalizeClaudeSettingsArgs(["-p", "--settings", '{"theme":"light"}'])).toEqual([
      "-p",
      "--settings",
      '{"theme":"light","disableAllHooks":true}',
    ]);
  });
});

describe("normalizeClaudeBackendConfig", () => {
  it("normalizes both args and resumeArgs for custom overrides", () => {
    const normalized = normalizeClaudeBackendConfig({
      command: "claude",
      args: ["-p", "--output-format", "stream-json", "--verbose"],
      resumeArgs: ["-p", "--output-format", "stream-json", "--verbose", "--resume", "{sessionId}"],
      systemPromptWhen: "first",
    });

    expect(normalized.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--disallowedTools",
      CLAUDE_NATIVE_TOOL_DENYLIST_VALUE,
      "--disable-slash-commands",
      "--setting-sources",
      "",
      "--settings",
      '{"disableAllHooks":true}',
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(normalized.resumeArgs).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--resume",
      "{sessionId}",
      "--disallowedTools",
      CLAUDE_NATIVE_TOOL_DENYLIST_VALUE,
      "--disable-slash-commands",
      "--setting-sources",
      "",
      "--settings",
      '{"disableAllHooks":true}',
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(normalized.env).toEqual({
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    });
    expect(normalized.systemPromptArg).toBe("--system-prompt");
    expect(normalized.systemPromptFileConfigArg).toBe("--system-prompt-file");
    expect(normalized.systemPromptMode).toBe("replace");
    expect(normalized.systemPromptWhen).toBe("always");
    expect(normalized.invalidateOnSystemPromptChange).toBe(false);
  });

  it("preserves an explicit never system prompt policy", () => {
    const normalized = normalizeClaudeBackendConfig({
      command: "claude",
      systemPromptWhen: "never",
    });

    expect(normalized.systemPromptWhen).toBe("never");
  });

  it("preserves explicit prompt invalidation opt-in", () => {
    const normalized = normalizeClaudeBackendConfig({
      command: "claude",
      invalidateOnSystemPromptChange: true,
    });

    expect(normalized.invalidateOnSystemPromptChange).toBe(true);
  });

  it("is wired through the anthropic cli backend normalize hook", () => {
    const backend = buildAnthropicCliBackend();
    const normalizeConfig = backend.normalizeConfig;

    expect(normalizeConfig).toBeTypeOf("function");

    const normalized = normalizeConfig?.({
      ...backend.config,
      args: ["-p", "--output-format", "stream-json", "--verbose"],
      resumeArgs: ["-p", "--output-format", "stream-json", "--verbose", "--resume", "{sessionId}"],
    });

    expect(normalized?.args).toContain("--permission-mode");
    expect(normalized?.args).toContain("bypassPermissions");
    expect(normalized?.args).toContain("--disallowedTools");
    expect(normalized?.args).toContain(CLAUDE_NATIVE_TOOL_DENYLIST_VALUE);
    expect(normalized?.args).toContain("--disable-slash-commands");
    expect(normalized?.args).toContain("--setting-sources");
    expect(normalized?.args).toContain("--settings");
    expect(normalized?.args).toContain('{"disableAllHooks":true}');
    expect(normalized?.resumeArgs).toContain("--permission-mode");
    expect(normalized?.resumeArgs).toContain("bypassPermissions");
    expect(normalized?.resumeArgs).toContain("--disallowedTools");
    expect(normalized?.resumeArgs).toContain(CLAUDE_NATIVE_TOOL_DENYLIST_VALUE);
    expect(normalized?.resumeArgs).toContain("--disable-slash-commands");
    expect(normalized?.resumeArgs).toContain("--setting-sources");
    expect(normalized?.resumeArgs).toContain("--settings");
    expect(normalized?.resumeArgs).toContain('{"disableAllHooks":true}');
    expect(normalized?.env).toEqual({
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    });
    expect(normalized?.systemPromptArg).toBe("--system-prompt");
    expect(normalized?.systemPromptMode).toBe("replace");
    expect(normalized?.systemPromptWhen).toBe("always");
    expect(normalized?.invalidateOnSystemPromptChange).toBe(false);
  });

  it("leaves claude cli subscription-managed, blocks native tools, and clears inherited env overrides", () => {
    const backend = buildAnthropicCliBackend();

    expect(backend.config.env).toEqual({
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    });
    expect(backend.config.args).toContain("--disallowedTools");
    expect(backend.config.args).toContain(CLAUDE_NATIVE_TOOL_DENYLIST_VALUE);
    expect(backend.config.args).toContain("--disable-slash-commands");
    expect(backend.config.args).toContain("--setting-sources");
    expect(backend.config.args).toContain("--settings");
    expect(backend.config.args).toContain('{"disableAllHooks":true}');
    expect(backend.config.resumeArgs).toContain("--setting-sources");
    expect(backend.config.resumeArgs).toContain("--settings");
    expect(backend.config.resumeArgs).toContain('{"disableAllHooks":true}');
    expect(backend.config.resumeArgs).toContain("--disallowedTools");
    expect(backend.config.resumeArgs).toContain(CLAUDE_NATIVE_TOOL_DENYLIST_VALUE);
    expect(backend.config.resumeArgs).toContain("--disable-slash-commands");
    expect(backend.config.systemPromptArg).toBe("--system-prompt");
    expect(backend.config.systemPromptMode).toBe("replace");
    expect(backend.config.systemPromptWhen).toBe("always");
    expect(backend.config.invalidateOnSystemPromptChange).toBe(false);
    expect(backend.config.clearEnv).toEqual([...CLAUDE_CLI_CLEAR_ENV]);
    expect(backend.config.clearEnv).toContain("ANTHROPIC_API_TOKEN");
    expect(backend.config.clearEnv).toContain("ANTHROPIC_BASE_URL");
    expect(backend.config.clearEnv).toContain("ANTHROPIC_CUSTOM_HEADERS");
    expect(backend.config.clearEnv).toContain("ANTHROPIC_OAUTH_TOKEN");
    expect(backend.config.clearEnv).toContain("CLAUDE_CONFIG_DIR");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_PLUGIN_CACHE_DIR");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_PLUGIN_SEED_DIR");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_REMOTE");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_USE_COWORK_PLUGINS");
    expect(backend.config.clearEnv).toContain("OTEL_METRICS_EXPORTER");
    expect(backend.config.clearEnv).toContain("OTEL_EXPORTER_OTLP_PROTOCOL");
    expect(backend.config.clearEnv).toContain("OTEL_SDK_DISABLED");
  });

  it("keeps streaming Claude sessions resumable across gateway restarts", () => {
    const backend = buildAnthropicStreamingCliBackend();

    expect(backend.config.args).toContain("--include-partial-messages");
    expect(backend.config.args).toContain("--disallowedTools");
    expect(backend.config.args).toContain(CLAUDE_NATIVE_TOOL_DENYLIST_VALUE);
    expect(backend.config.args).not.toContain("--tools");
    expect(backend.config.resumeArgs).toContain("--resume");
    expect(backend.config.resumeArgs).toContain("{sessionId}");
    expect(backend.config.sessionMode).toBe("always");
    expect(backend.config.invalidateOnSystemPromptChange).toBe(false);
  });
});
