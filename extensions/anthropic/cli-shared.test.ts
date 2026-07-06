// Anthropic tests cover cli shared plugin behavior.
import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { buildClaudeCliCatalogEntries } from "./cli-catalog.js";
import {
  CLAUDE_CLI_CLEAR_ENV,
  normalizeClaudeBackendConfig,
  normalizeClaudeIsolationArgs,
  normalizeClaudeOpenClawToolPermissionArgs,
  normalizeClaudePermissionArgs,
  normalizeClaudeSettingSourcesArgs,
  normalizeClaudeSettingsArgs,
  normalizeClaudeSlashCommandArgs,
  prepareClaudeCliExecution,
  resolveClaudePermissionMode,
  resolveClaudeCliExecutionArgs,
} from "./cli-shared.js";

function expectIsolatedToolArgs(args: readonly string[] | undefined) {
  const toolsIndex = args?.indexOf("--tools") ?? -1;
  expect(toolsIndex).toBeGreaterThanOrEqual(0);
  expect(args?.[toolsIndex + 1]).toBe("ToolSearch");
}

describe("normalizeClaudePermissionArgs", () => {
  it("leaves args alone when they omit permission flags", () => {
    expect(
      normalizeClaudePermissionArgs(["-p", "--output-format", "stream-json", "--verbose"]),
    ).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
  });

  it("removes legacy skip-permissions without adding bypassPermissions", () => {
    expect(
      normalizeClaudePermissionArgs(["-p", "--dangerously-skip-permissions", "--verbose"]),
    ).toEqual(["-p", "--verbose"]);
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

  it("drops malformed permission-mode flags in both split and equals forms", () => {
    expect(
      normalizeClaudePermissionArgs(["-p", "--permission-mode", "--output-format", "stream-json"]),
    ).toEqual(["-p", "--output-format", "stream-json"]);
    expect(normalizeClaudePermissionArgs(["-p", "--permission-mode="])).toEqual(["-p"]);
    expect(normalizeClaudePermissionArgs(["-p", "--permission-mode=--output-format"])).toEqual([
      "-p",
    ]);
  });
});

describe("normalizeClaudeSettingSourcesArgs", () => {
  it("injects empty setting sources when args omit the flag", () => {
    expect(
      normalizeClaudeSettingSourcesArgs(["-p", "--output-format", "stream-json", "--verbose"]),
    ).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--setting-sources", ""]);
  });

  it("forces explicit user, project, or local setting sources to empty", () => {
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

  it("treats a bare setting-sources flag as an isolated empty source list", () => {
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
  it("keeps only the built-in MCP discovery tool", () => {
    expect(normalizeClaudeIsolationArgs(["-p", "--verbose"])).toEqual([
      "-p",
      "--verbose",
      "--tools",
      "ToolSearch",
    ]);
  });

  it("overrides split and equals native tool selections", () => {
    expect(normalizeClaudeIsolationArgs(["-p", "--tools", "Read,Bash"])).toEqual([
      "-p",
      "--tools",
      "ToolSearch",
    ]);
    expect(normalizeClaudeIsolationArgs(["-p", "--tools=Read,Bash"])).toEqual([
      "-p",
      "--tools",
      "ToolSearch",
    ]);
  });
});

describe("normalizeClaudeOpenClawToolPermissionArgs", () => {
  it("replaces operator allow and deny rules with the bundled MCP server", () => {
    expect(
      normalizeClaudeOpenClawToolPermissionArgs([
        "-p",
        "--allowed-tools=Read",
        "--allowedTools",
        "Bash",
        "Edit",
        "--disallowedTools",
        "mcp__*",
        "--verbose",
      ]),
    ).toEqual(["-p", "--verbose", "--allowedTools", "mcp__openclaw__*"]);
  });
});

describe("normalizeClaudeSlashCommandArgs", () => {
  it("forces slash commands off without duplicating the flag", () => {
    expect(normalizeClaudeSlashCommandArgs(["-p"])).toEqual(["-p", "--disable-slash-commands"]);
    expect(normalizeClaudeSlashCommandArgs(["-p", "--disable-slash-commands"])).toEqual([
      "-p",
      "--disable-slash-commands",
    ]);
  });
});

describe("normalizeClaudeSettingsArgs", () => {
  it("disables all hooks while retaining unrelated inline settings", () => {
    expect(normalizeClaudeSettingsArgs(["-p", "--settings", '{"theme":"dark"}'])).toEqual([
      "-p",
      "--settings",
      '{"theme":"dark","disableAllHooks":true}',
    ]);
  });

  it("replaces malformed settings with the isolated hook policy", () => {
    expect(normalizeClaudeSettingsArgs(["-p", "--settings=not-json"])).toEqual([
      "-p",
      '--settings={"disableAllHooks":true}',
    ]);
  });

  it("overrides Claude fast mode while retaining isolated settings", () => {
    expect(
      normalizeClaudeSettingsArgs(["-p", "--settings", '{"theme":"dark","fastMode":false}'], {
        fastMode: true,
      }),
    ).toEqual(["-p", "--settings", '{"theme":"dark","fastMode":true,"disableAllHooks":true}']);
  });

  it("controls Claude thinking through isolated inline settings", () => {
    expect(
      normalizeClaudeSettingsArgs(["-p", "--settings", '{"theme":"dark"}'], {
        thinkingEnabled: false,
      }),
    ).toEqual([
      "-p",
      "--settings",
      '{"theme":"dark","disableAllHooks":true,"alwaysThinkingEnabled":false}',
    ]);
  });
});

describe("Claude CLI model aliases", () => {
  it("keeps pinned Claude CLI model refs on exact selectors", () => {
    const aliases = buildAnthropicCliBackend().config.modelAliases;

    expect(aliases?.["fable"]).toBe("fable");
    expect(aliases?.["fable-5"]).toBe("fable");
    expect(aliases?.["fable[1m]"]).toBe("fable[1m]");
    expect(aliases?.["claude-fable-5"]).toBe("fable");
    expect(aliases?.["claude-fable-5[1m]"]).toBe("fable[1m]");
    expect(aliases?.["opus"]).toBe("opus");
    expect(aliases?.["opus-4.8"]).toBe("claude-opus-4-8");
    expect(aliases?.["opus-4.8[1m]"]).toBe("claude-opus-4-8[1m]");
    expect(aliases?.["opus-4.7"]).toBe("claude-opus-4-7");
    expect(aliases?.["opus-4.6"]).toBe("claude-opus-4-6[1m]");
    expect(aliases?.["opus-4.6[1m]"]).toBe("claude-opus-4-6[1m]");
    expect(aliases?.["claude-opus-4-8"]).toBe("claude-opus-4-8");
    expect(aliases?.["claude-opus-4-8[1m]"]).toBe("claude-opus-4-8[1m]");
    expect(aliases?.["claude-opus-4-7"]).toBe("claude-opus-4-7");
    expect(aliases?.["claude-opus-4-6"]).toBe("claude-opus-4-6[1m]");
    expect(aliases?.["claude-opus-4-6[1m]"]).toBe("claude-opus-4-6[1m]");
    expect(aliases?.sonnet).toBe("claude-sonnet-5");
    expect(aliases?.["sonnet-5"]).toBe("claude-sonnet-5");
    expect(aliases?.["claude-sonnet-5"]).toBe("claude-sonnet-5");
  });
});

describe("prepareClaudeCliExecution", () => {
  it.each([
    { contextTokens: 50_000, expected: "100000" },
    { contextTokens: 222_000, expected: "222000" },
    { contextTokens: 1_048_576, expected: "1000000" },
  ])(
    "sets the native compact window for $contextTokens effective tokens",
    ({ contextTokens, expected }) => {
      expect(
        prepareClaudeCliExecution({
          workspaceDir: "/tmp",
          provider: "claude-cli",
          modelId: "claude-opus-4-6",
          contextTokens,
        }),
      ).toEqual({
        env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: expected },
      });
    },
  );

  it("does not override Claude Code when no effective context is available", () => {
    expect(
      prepareClaudeCliExecution({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-opus-4-6",
      }),
    ).toBeUndefined();
  });

  it.each(["sonnet", "sonnet-5", "claude-sonnet-5"])(
    "keeps Claude Code's native Sonnet 5 compaction margin for %s",
    (modelId) => {
      expect(
        prepareClaudeCliExecution({
          workspaceDir: "/tmp",
          provider: "claude-cli",
          modelId,
          contextTokens: 1_000_000,
        }),
      ).toBeUndefined();
    },
  );

  it("applies an explicitly lower OpenClaw context cap to Sonnet 5", () => {
    expect(
      prepareClaudeCliExecution({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-sonnet-5",
        contextTokens: 222_000,
      }),
    ).toEqual({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "222000" } });
  });
});

describe("Claude CLI catalog", () => {
  it("advertises the Fable selector with its effective context", () => {
    const fable = buildClaudeCliCatalogEntries().find((entry) => entry.id === "claude-fable-5");

    expect(fable).toMatchObject({
      name: "Claude Fable 5 (Claude CLI)",
      contextWindow: 1_000_000,
      contextTokens: 1_000_000,
      mediaInput: {
        image: { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
      },
    });
  });

  it("advertises explicit Claude Code 1M selectors", () => {
    expect(buildClaudeCliCatalogEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "claude-fable-5[1m]",
          name: "Claude Fable 5 1M (Claude CLI)",
          contextWindow: 1_000_000,
          contextTokens: 1_000_000,
        }),
        expect.objectContaining({
          id: "claude-opus-4-8[1m]",
          name: "Claude Opus 4.8 1M (Claude CLI)",
          contextWindow: 1_048_576,
          contextTokens: 1_048_576,
        }),
      ]),
    );
  });

  it("advertises the retained Opus 4.6 long-context route", () => {
    const opus46 = buildClaudeCliCatalogEntries().find((entry) => entry.id === "claude-opus-4-6");

    expect(opus46).toMatchObject({
      contextWindow: 1_048_576,
      contextTokens: 1_048_576,
    });
  });

  it("advertises Claude Sonnet 5 with its verified Claude Code context", () => {
    const sonnet5 = buildClaudeCliCatalogEntries().find((entry) => entry.id === "claude-sonnet-5");

    expect(sonnet5).toMatchObject({
      name: "Claude Sonnet 5 (Claude CLI)",
      contextWindow: 1_000_000,
      contextTokens: 1_000_000,
      mediaInput: {
        image: { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
      },
    });
  });
});

describe("resolveClaudeCliExecutionArgs", () => {
  it("omits effort args when thinking is off", () => {
    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-sonnet-4-6",
        thinkingLevel: "off",
        useResume: false,
        baseArgs: ["-p", "--output-format", "stream-json"],
      }),
    ).toEqual(["-p", "--output-format", "stream-json"]);
  });

  it("explicitly disables Sonnet 5 thinking and removes stale effort args", () => {
    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-sonnet-5",
        thinkingLevel: "off",
        useResume: false,
        baseArgs: ["-p", "--effort", "xhigh"],
      }),
    ).toEqual(["-p", "--settings", '{"disableAllHooks":true,"alwaysThinkingEnabled":false}']);
  });

  it("maps Sonnet 5 adaptive mode to its native high default", () => {
    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "sonnet",
        thinkingLevel: "adaptive",
        useResume: false,
        baseArgs: ["-p"],
      }),
    ).toEqual([
      "-p",
      "--settings",
      '{"disableAllHooks":true,"alwaysThinkingEnabled":true}',
      "--effort",
      "high",
    ]);
  });

  it("maps OpenClaw thinking levels to Claude effort args", () => {
    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-opus-4-7",
        thinkingLevel: "minimal",
        useResume: false,
        baseArgs: ["-p"],
      }),
    ).toEqual(["-p", "--effort", "low"]);
    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-opus-4-7",
        thinkingLevel: "adaptive",
        useResume: false,
        baseArgs: ["-p"],
      }),
    ).toEqual(["-p", "--effort", "medium"]);
    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-opus-4-7",
        thinkingLevel: "xhigh",
        useResume: true,
        baseArgs: ["-p", "--resume", "{sessionId}"],
      }),
    ).toEqual(["-p", "--resume", "{sessionId}", "--effort", "xhigh"]);
  });

  it("replaces static effort args when a session thinking level is active", () => {
    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-opus-4-7",
        thinkingLevel: "max",
        useResume: false,
        baseArgs: ["-p", "--effort", "low", "--effort=high"],
      }),
    ).toEqual(["-p", "--effort", "max"]);
  });

  it("maps the effective OpenClaw fast mode into Claude settings", () => {
    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-opus-4-8",
        fastMode: true,
        useResume: false,
        baseArgs: ["-p", "--settings", '{"disableAllHooks":true}'],
      }),
    ).toEqual(["-p", "--settings", '{"disableAllHooks":true,"fastMode":true}']);
    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-opus-4-8",
        fastMode: false,
        useResume: true,
        baseArgs: ["-p", '--settings={"disableAllHooks":true,"fastMode":true}'],
      }),
    ).toEqual(["-p", '--settings={"disableAllHooks":true,"fastMode":false}']);
  });

  it("forces isolated no-tool one-shot args for side-question execution", () => {
    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-opus-4-7",
        thinkingLevel: "max",
        useResume: true,
        executionMode: "side-question",
        baseArgs: [
          "-p",
          "--output-format",
          "stream-json",
          "--allowedTools=mcp__openclaw__*",
          "--allowedTools",
          "Read",
          "Grep",
          "--permission-mode",
          "bypassPermissions",
          "--session-id=abc",
          "--resume",
          "old-session",
          "--resume-session-at",
          "old-message",
          "--resume-session-at=old-message-equals",
          "--mcp-config",
          "/tmp/side-question-mcp.json",
          "--bare",
          "--safe-mode",
          "--strict-mcp-config",
          "--no-session-persistence",
          "--max-turns",
          "4",
          "--effort",
          "high",
        ],
      }),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--safe-mode",
      "--tools",
      "",
      "--disallowedTools",
      "mcp__*",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--max-turns",
      "1",
      "--permission-mode",
      "default",
    ]);
  });
});

describe("normalizeClaudeBackendConfig", () => {
  it("normalizes both args and resumeArgs for custom overrides", () => {
    const normalized = normalizeClaudeBackendConfig({
      command: "claude",
      args: ["-p", "--output-format", "stream-json", "--verbose"],
      resumeArgs: ["-p", "--output-format", "stream-json", "--verbose", "--resume", "{sessionId}"],
    });

    expect(normalized.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
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
      "--tools",
      "ToolSearch",
      "--disable-slash-commands",
      "--setting-sources",
      "",
      "--settings",
      '{"disableAllHooks":true}',
      "--allowedTools",
      "mcp__openclaw__*",
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(normalized.output).toBe("jsonl");
    expect(normalized.liveSession).toBe("claude-stdio");
    expect(normalized.input).toBe("stdin");
    expect(normalized.env).toEqual({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" });
    expect(normalized.systemPromptFileArg).toBe("--system-prompt-file");
    expect(normalized.systemPromptMode).toBe("replace");
  });

  it("derives Claude bypass from OpenClaw YOLO policy and disables it for safer policy", () => {
    expect(resolveClaudePermissionMode({ backendId: "claude-cli" })).toEqual({
      mode: "bypassPermissions",
      overrideExisting: false,
    });
    expect(
      resolveClaudePermissionMode({
        backendId: "claude-cli",
        config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      }),
    ).toEqual({ overrideExisting: false });
  });

  it("derives Claude bypass from per-agent OpenClaw exec policy", () => {
    expect(
      resolveClaudePermissionMode({
        backendId: "claude-cli",
        agentId: "safe-agent",
        config: {
          tools: { exec: { security: "full", ask: "off" } },
          agents: {
            list: [
              {
                id: "safe-agent",
                tools: { exec: { security: "allowlist", ask: "on-miss" } },
              },
            ],
          },
        },
      }),
    ).toEqual({ overrideExisting: false });
    expect(
      resolveClaudePermissionMode({
        backendId: "claude-cli",
        agentId: "yolo-agent",
        config: {
          tools: { exec: { security: "allowlist", ask: "on-miss" } },
          agents: {
            list: [
              {
                id: "yolo-agent",
                tools: { exec: { security: "full", ask: "off" } },
              },
            ],
          },
        },
      }),
    ).toEqual({
      mode: "bypassPermissions",
      overrideExisting: false,
    });
  });

  it("does not infer live stdio when explicit transport overrides are incompatible", () => {
    const normalized = normalizeClaudeBackendConfig({
      command: "claude",
      output: "json",
      input: "arg",
    });

    expect(normalized.output).toBe("json");
    expect(normalized.liveSession).toBeUndefined();
    expect(normalized.input).toBe("arg");
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

    expect(normalized?.args).toContain("--setting-sources");
    expect(normalized?.args).toContain("");
    expect(normalized?.args).toContain("--settings");
    expectIsolatedToolArgs(normalized?.args);
    expect(normalized?.args).toContain("--permission-mode");
    expect(normalized?.args).toContain("bypassPermissions");
    expect(normalized?.resumeArgs).toContain("--setting-sources");
    expect(normalized?.resumeArgs).toContain("");
    expect(normalized?.resumeArgs).toContain("--settings");
    expectIsolatedToolArgs(normalized?.resumeArgs);
    expect(normalized?.resumeArgs).toContain("--permission-mode");
    expect(normalized?.resumeArgs).toContain("bypassPermissions");
    expect(normalized?.liveSession).toBe("claude-stdio");
    expect(backend.prepareExecution).toBe(prepareClaudeCliExecution);
    expect(backend.resolveExecutionArgs).toBe(resolveClaudeCliExecutionArgs);
  });

  it("opts bundled Claude CLI into bounded raw transcript reseed without disabling native resume", () => {
    const backend = buildAnthropicCliBackend();

    expect(backend.config.reseedFromRawTranscriptWhenUncompacted).toBe(true);
    expect(backend.config.sessionMode).toBe("always");
    expect(backend.config.resumeArgs).toContain("--resume");
    expect(backend.config.resumeArgs).toContain("{sessionId}");
  });

  it("passes system prompt on every turn (issue #80374 — systemPromptWhen must be 'always')", () => {
    // Before fix this was hardcoded to "first", which silently dropped updated
    // OpenClaw system prompt context on resumed / compacted claude-cli sessions.
    const backend = buildAnthropicCliBackend();
    expect(backend.config.systemPromptWhen).toBe("always");
  });

  it("isolates Claude runtime context while preserving subscription auth", () => {
    const backend = buildAnthropicCliBackend();

    expect(backend.nativeToolMode).toBe("always-on");
    expect(backend.bundleMcpToolSurface).toBe("openclaw");
    expect(backend.config.env).toEqual({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" });
    expect(backend.config.liveSession).toBe("claude-stdio");
    expect(backend.config.output).toBe("jsonl");
    expect(backend.config.input).toBe("stdin");
    expect(backend.config.args).toContain("--setting-sources");
    expect(backend.config.args).toContain("");
    expect(backend.config.args).toContain("--settings");
    expectIsolatedToolArgs(backend.config.args);
    expect(backend.config.resumeArgs).toContain("--setting-sources");
    expect(backend.config.resumeArgs).toContain("");
    expect(backend.config.resumeArgs).toContain("--settings");
    expectIsolatedToolArgs(backend.config.resumeArgs);
    expect(backend.config.clearEnv).toEqual([...CLAUDE_CLI_CLEAR_ENV]);
    expect(backend.config.clearEnv).toContain("ANTHROPIC_API_TOKEN");
    expect(backend.config.clearEnv).toContain("ANTHROPIC_BASE_URL");
    expect(backend.config.clearEnv).toContain("ANTHROPIC_CUSTOM_HEADERS");
    expect(backend.config.clearEnv).toContain("ANTHROPIC_OAUTH_TOKEN");
    expect(backend.config.clearEnv).toContain("CLAUDE_CONFIG_DIR");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_DISABLE_1M_CONTEXT");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_DISABLE_THINKING");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_EFFORT_LEVEL");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_PLUGIN_CACHE_DIR");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_PLUGIN_SEED_DIR");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_REMOTE");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_USE_COWORK_PLUGINS");
    expect(backend.config.clearEnv).toContain("MAX_THINKING_TOKENS");
    expect(backend.config.clearEnv).toContain("OTEL_METRICS_EXPORTER");
    expect(backend.config.clearEnv).toContain("OTEL_EXPORTER_OTLP_PROTOCOL");
    expect(backend.config.clearEnv).toContain("OTEL_SDK_DISABLED");
  });

  it("disables the entire native tool surface in args and resumeArgs", () => {
    const backend = buildAnthropicCliBackend();

    expectIsolatedToolArgs(backend.config.args);
    expectIsolatedToolArgs(backend.config.resumeArgs);
    expect(backend.config.args).not.toContain("--disallowedTools");
    expect(backend.config.resumeArgs).not.toContain("--disallowedTools");
  });
});
