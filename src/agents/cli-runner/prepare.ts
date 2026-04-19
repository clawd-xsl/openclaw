import type { CliBackendConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureMcpLoopbackServer } from "../../gateway/mcp-http.js";
import {
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import {
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
  buildBootstrapTruncationReportMeta,
  analyzeBootstrapBudget,
} from "../bootstrap-budget.js";
import {
  makeBootstrapWarn as makeBootstrapWarnImpl,
  resolveBootstrapContextForRun as resolveBootstrapContextForRunImpl,
} from "../bootstrap-files.js";
import { resolveCliAuthEpoch } from "../cli-auth-epoch.js";
import { resolveCliBackendConfig } from "../cli-backends.js";
import { hashCliSessionText, resolveCliSessionReuse } from "../cli-session.js";
import { resolveContextTokensForModel } from "../context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../heartbeat-system-prompt.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
} from "../pi-embedded-helpers.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { resolveSkillsPromptForRun } from "../skills.js";
import { resolveSystemPromptOverride } from "../system-prompt-override.js";
import { buildSystemPromptReport } from "../system-prompt-report.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import { materializeCliBundleMcpConfig, prepareCliBundleMcpSpec } from "./bundle-mcp.js";
import { buildClaudeCliSkillsPluginSpec } from "./claude-skills-plugin.js";
import { buildSystemPrompt, normalizeCliModel } from "./helpers.js";
import { cliBackendLog } from "./log.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

const prepareDeps = {
  makeBootstrapWarn: makeBootstrapWarnImpl,
  resolveBootstrapContextForRun: resolveBootstrapContextForRunImpl,
  getActiveMcpLoopbackRuntime,
  ensureMcpLoopbackServer,
  createMcpLoopbackServerConfig,
  resolveOpenClawDocsPath: async (
    params: Parameters<typeof import("../docs-path.js").resolveOpenClawDocsPath>[0],
  ) => (await import("../docs-path.js")).resolveOpenClawDocsPath(params),
};

const CLAUDE_AUTOCOMPACT_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
const CLAUDE_AUTOCOMPACT_MIN_TOKENS = 100_000;
const CLAUDE_AUTOCOMPACT_MAX_TOKENS = 1_000_000;

function resolveClaudeAutoCompactTokens(params: {
  cfg?: OpenClawConfig;
  provider: string;
  modelId: string;
}): number {
  const configuredContextTokens = resolveContextTokensForModel({
    cfg: params.cfg,
    provider: params.provider,
    model: params.modelId,
    contextTokensOverride: params.cfg?.agents?.defaults?.contextTokens,
    fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
    allowAsyncLoad: false,
  });
  return Math.floor(
    Math.max(
      CLAUDE_AUTOCOMPACT_MIN_TOKENS,
      Math.min(CLAUDE_AUTOCOMPACT_MAX_TOKENS, configuredContextTokens ?? DEFAULT_CONTEXT_TOKENS),
    ),
  );
}

function applyClaudeAutoCompactConfig(params: {
  backend: CliBackendConfig;
  cfg?: OpenClawConfig;
  provider: string;
  modelId: string;
}): CliBackendConfig {
  if (params.backend.jsonlDialect !== "claude-stream-json") {
    return params.backend;
  }
  const value = String(
    resolveClaudeAutoCompactTokens({
      cfg: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
    }),
  );
  return {
    ...params.backend,
    env: {
      ...params.backend.env,
      [CLAUDE_AUTOCOMPACT_ENV]: value,
    },
  };
}

export function setCliRunnerPrepareTestDeps(overrides: Partial<typeof prepareDeps>): void {
  Object.assign(prepareDeps, overrides);
}

export async function prepareCliRunContext(
  params: RunCliAgentParams,
): Promise<PreparedCliRunContext> {
  const traceId = params.runId ?? params.sessionKey ?? params.sessionId;
  const traceStartedAt = Date.now();
  const trace = (stage: string, details?: string) => {
    const suffix = details ? ` ${details}` : "";
    cliBackendLog.info(
      `cli prepare trace: run=${traceId} stage=${stage} sinceStartMs=${Date.now() - traceStartedAt}${suffix}`,
    );
  };
  const started = Date.now();
  const workspaceResolution = resolveRunWorkspaceDir({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const resolvedWorkspace = workspaceResolution.workspaceDir;
  const redactedSessionId = redactRunIdentifier(params.sessionId);
  const redactedSessionKey = redactRunIdentifier(params.sessionKey);
  const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
  if (workspaceResolution.usedFallback) {
    cliBackendLog.warn(
      `[workspace-fallback] caller=runCliAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
    );
  }
  const workspaceDir = resolvedWorkspace;
  trace("workspace-resolved", `workspace=${redactedWorkspace}`);

  const backendResolved = resolveCliBackendConfig(params.provider, params.config);
  if (!backendResolved) {
    throw new Error(`Unknown CLI backend: ${params.provider}`);
  }
  const authEpoch = await resolveCliAuthEpoch({
    provider: params.provider,
    authProfileId: params.authProfileId,
  });
  trace("auth-epoch-done");
  const extraSystemPrompt = params.extraSystemPrompt?.trim() ?? "";
  const extraSystemPromptHash = hashCliSessionText(extraSystemPrompt);
  const modelId = (params.model ?? "default").trim() || "default";
  const backendConfig = applyClaudeAutoCompactConfig({
    backend: backendResolved.config,
    cfg: params.config,
    provider: params.provider,
    modelId,
  });
  const resolvedBackend = {
    ...backendResolved,
    config: backendConfig,
  };
  const normalizedModel = normalizeCliModel(modelId, resolvedBackend.config);
  const modelDisplay = `${params.provider}/${modelId}`;

  const sessionLabel = params.sessionKey ?? params.sessionId;
  const { bootstrapFiles, contextFiles } = await prepareDeps.resolveBootstrapContextForRun({
    workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    warn: prepareDeps.makeBootstrapWarn({
      sessionLabel,
      warn: (message) => cliBackendLog.warn(message),
    }),
  });
  trace("bootstrap-context-done", `files=${contextFiles.length}`);
  const bootstrapMaxChars = resolveBootstrapMaxChars(params.config);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config);
  const bootstrapAnalysis = analyzeBootstrapBudget({
    files: buildBootstrapInjectionStats({
      bootstrapFiles,
      injectedFiles: contextFiles,
    }),
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
  });
  const bootstrapPromptWarningMode = resolveBootstrapPromptTruncationWarningMode(params.config);
  const bootstrapPromptWarning = buildBootstrapPromptWarning({
    analysis: bootstrapAnalysis,
    mode: bootstrapPromptWarningMode,
    seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
    previousSignature: params.bootstrapPromptWarningSignature,
  });
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  let mcpLoopbackRuntime = resolvedBackend.bundleMcp
    ? prepareDeps.getActiveMcpLoopbackRuntime()
    : undefined;
  if (resolvedBackend.bundleMcp && !mcpLoopbackRuntime) {
    try {
      await prepareDeps.ensureMcpLoopbackServer();
    } catch (error) {
      cliBackendLog.warn(`mcp loopback server failed to start: ${String(error)}`);
    }
    mcpLoopbackRuntime = prepareDeps.getActiveMcpLoopbackRuntime();
  }
  trace("mcp-loopback-ready", `active=${mcpLoopbackRuntime ? "yes" : "no"}`);
  const bundleMcpSpec = await prepareCliBundleMcpSpec({
    enabled: resolvedBackend.bundleMcp,
    mode: resolvedBackend.bundleMcpMode,
    backend: resolvedBackend.config,
    workspaceDir,
    config: params.config,
    additionalConfig: mcpLoopbackRuntime
      ? prepareDeps.createMcpLoopbackServerConfig(mcpLoopbackRuntime.port)
      : undefined,
    env: mcpLoopbackRuntime
      ? {
          OPENCLAW_MCP_TOKEN: mcpLoopbackRuntime.token,
          OPENCLAW_MCP_AGENT_ID: sessionAgentId ?? "",
          OPENCLAW_MCP_ACCOUNT_ID: params.agentAccountId ?? "",
          OPENCLAW_MCP_SESSION_KEY: params.sessionKey ?? "",
          OPENCLAW_MCP_MESSAGE_CHANNEL: params.messageProvider ?? "",
          OPENCLAW_MCP_SENDER_IS_OWNER: params.senderIsOwner === true ? "true" : "false",
        }
      : undefined,
    warn: (message) => cliBackendLog.warn(message),
  });
  trace("bundle-mcp-spec-done", `hash=${bundleMcpSpec.mcpConfigHash ?? "none"}`);
  const preparedBackend =
    resolvedBackend.config.executionMode === "persistent-process"
      ? {
          backend: resolvedBackend.config,
          mcpConfigHash: bundleMcpSpec.mcpConfigHash,
          env: bundleMcpSpec.env,
          bundleMcpSpec: bundleMcpSpec,
        }
      : await materializeCliBundleMcpConfig({
          backend: resolvedBackend.config,
          spec: bundleMcpSpec,
        });
  trace("prepared-backend-done");
  const claudeSkillsPluginSpec = await buildClaudeCliSkillsPluginSpec({
    backendId: backendResolved.id,
    skillsSnapshot: params.skillsSnapshot,
  });
  trace("skills-plugin-spec-done", `enabled=${claudeSkillsPluginSpec ? "yes" : "no"}`);
  const resolvedReusableCliSession = params.cliSessionBinding
    ? resolveCliSessionReuse({
        binding: params.cliSessionBinding,
        authProfileId: params.authProfileId,
        authEpoch,
        ...(resolvedBackend.config.invalidateOnSystemPromptChange !== false
          ? { extraSystemPromptHash }
          : {}),
        mcpConfigHash: preparedBackend.mcpConfigHash,
      })
    : params.cliSessionId
      ? { sessionId: params.cliSessionId }
      : {};
  // Claude Code accepts fresh MCP config on --resume, so an MCP hash change
  // should not be treated as a continuity break for the parent OpenClaw session.
  // Only trust that path when the stored binding itself carried an MCP hash.
  // Older bindings without continuity metadata should cold-start instead of
  // blindly resuming an unknown Claude session after gateway restart.
  const reusableCliSession =
    resolvedBackend.config.jsonlDialect === "claude-stream-json" &&
    resolvedReusableCliSession.invalidatedReason === "mcp" &&
    params.cliSessionBinding?.sessionId &&
    normalizeOptionalString(params.cliSessionBinding.mcpConfigHash)
      ? { sessionId: params.cliSessionBinding.sessionId }
      : resolvedReusableCliSession;
  if (reusableCliSession.invalidatedReason) {
    const binding = params.cliSessionBinding;
    const resetDetails =
      reusableCliSession.invalidatedReason === "auth-epoch"
        ? ` storedAuthEpoch=${normalizeOptionalString(binding?.authEpoch) ?? "none"} currentAuthEpoch=${authEpoch ?? "none"} storedSessionId=${normalizeOptionalString(binding?.sessionId) ?? "none"}`
        : reusableCliSession.invalidatedReason === "auth-profile"
          ? ` storedAuthProfile=${normalizeOptionalString(binding?.authProfileId) ?? "none"} currentAuthProfile=${params.authProfileId ?? "none"} storedSessionId=${normalizeOptionalString(binding?.sessionId) ?? "none"}`
          : reusableCliSession.invalidatedReason === "mcp"
            ? ` storedMcpHash=${normalizeOptionalString(binding?.mcpConfigHash) ?? "none"} currentMcpHash=${preparedBackend.mcpConfigHash ?? "none"} storedSessionId=${normalizeOptionalString(binding?.sessionId) ?? "none"}`
            : reusableCliSession.invalidatedReason === "system-prompt"
              ? ` storedPromptHash=${normalizeOptionalString(binding?.extraSystemPromptHash) ?? "none"} currentPromptHash=${extraSystemPromptHash ?? "none"} storedSessionId=${normalizeOptionalString(binding?.sessionId) ?? "none"}`
              : "";
    cliBackendLog.info(
      `cli session reset: provider=${params.provider} reason=${reusableCliSession.invalidatedReason}${resetDetails}`,
    );
  }
  const heartbeatPrompt = resolveHeartbeatPromptForSystemPrompt({
    config: params.config,
    agentId: sessionAgentId,
    defaultAgentId,
  });
  const docsPath = await prepareDeps.resolveOpenClawDocsPath({
    workspaceDir,
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
  const skillsPrompt = resolveSkillsPromptForRun({
    skillsSnapshot: params.skillsSnapshot,
    workspaceDir,
    config: params.config,
    agentId: sessionAgentId,
  });
  const builtSystemPrompt =
    resolveSystemPromptOverride({
      config: params.config,
      agentId: sessionAgentId,
    }) ??
    buildSystemPrompt({
      workspaceDir,
      config: params.config,
      defaultThinkLevel: params.thinkLevel,
      reasoningLevel: params.reasoningLevel,
      extraSystemPrompt,
      ownerNumbers: params.ownerNumbers,
      heartbeatPrompt,
      docsPath: docsPath ?? undefined,
      skillsPrompt,
      tools: [],
      contextFiles,
      modelDisplay,
      agentId: sessionAgentId,
      messageProvider: params.messageProvider,
      previousSessionId: params.previousSessionId,
      recentSessionHistory: params.recentSessionHistory,
      sessionCreatedAt: params.sessionCreatedAt,
    });
  trace("system-prompt-built", `chars=${builtSystemPrompt.length}`);
  const transformedSystemPrompt =
    resolvedBackend.transformSystemPrompt?.({
      config: params.config,
      workspaceDir,
      provider: params.provider,
      modelId,
      modelDisplay,
      agentId: sessionAgentId,
      systemPrompt: builtSystemPrompt,
    }) ?? builtSystemPrompt;
  const systemPrompt = applyPluginTextReplacements(
    transformedSystemPrompt,
    resolvedBackend.textTransforms?.input,
  );
  const systemPromptReport = buildSystemPromptReport({
    source: "run",
    generatedAt: Date.now(),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    model: modelId,
    workspaceDir,
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
    bootstrapTruncation: buildBootstrapTruncationReportMeta({
      analysis: bootstrapAnalysis,
      warningMode: bootstrapPromptWarningMode,
      warning: bootstrapPromptWarning,
    }),
    sandbox: { mode: "off", sandboxed: false },
    systemPrompt,
    bootstrapFiles,
    injectedFiles: contextFiles,
    skillsPrompt,
    tools: [],
  });

  return {
    params,
    started,
    workspaceDir,
    backendResolved: resolvedBackend,
    preparedBackend: {
      ...preparedBackend,
      bundleMcpSpec,
      claudeSkillsPluginSpec,
    },
    reusableCliSession,
    modelId,
    normalizedModel,
    systemPrompt,
    systemPromptReport,
    bootstrapPromptWarningLines: bootstrapPromptWarning.lines,
    heartbeatPrompt,
    authEpoch,
    extraSystemPromptHash,
  };
}
