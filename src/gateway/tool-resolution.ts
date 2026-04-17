import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import { createOpenClawCodingTools } from "../agents/pi-tools.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicy,
} from "../agents/pi-tools.policy.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "../agents/tool-policy-pipeline.js";
import {
  collectExplicitAllowlist,
  mergeAlsoAllowPolicy,
  resolveToolProfilePolicy,
} from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { DEFAULT_GATEWAY_HTTP_TOOL_DENY } from "../security/dangerous-tools.js";

export type GatewayScopedToolSurface = "http" | "loopback";
export type GatewayLoopbackToolSurface = "filtered" | "full";

function resolveFilteredGatewayTools(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  messageProvider?: string;
  accountId?: string;
  agentTo?: string;
  agentThreadId?: string;
  allowGatewaySubagentBinding?: boolean;
  allowMediaInvokeCommands?: boolean;
  disablePluginTools?: boolean;
  senderIsOwner?: boolean;
  workspaceDir: string;
  policyAllowlist?: string[];
}) {
  return createOpenClawTools({
    agentSessionKey: params.sessionKey,
    agentChannel: params.messageProvider ?? undefined,
    agentAccountId: params.accountId,
    agentTo: params.agentTo,
    agentThreadId: params.agentThreadId,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    allowMediaInvokeCommands: params.allowMediaInvokeCommands,
    disablePluginTools: params.disablePluginTools,
    senderIsOwner: params.senderIsOwner,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    pluginToolAllowlist: params.policyAllowlist,
  });
}

function resolveFullLoopbackTools(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  messageProvider?: string;
  accountId?: string;
  agentTo?: string;
  agentThreadId?: string;
  allowGatewaySubagentBinding?: boolean;
  senderIsOwner?: boolean;
  workspaceDir: string;
  agentId?: string;
}) {
  return createOpenClawCodingTools({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    messageProvider: params.messageProvider,
    agentAccountId: params.accountId,
    messageTo: params.agentTo,
    messageThreadId: params.agentThreadId,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    senderIsOwner: params.senderIsOwner,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
  });
}

export function resolveGatewayScopedTools(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  messageProvider?: string;
  accountId?: string;
  agentTo?: string;
  agentThreadId?: string;
  allowGatewaySubagentBinding?: boolean;
  allowMediaInvokeCommands?: boolean;
  surface?: GatewayScopedToolSurface;
  loopbackToolSurface?: GatewayLoopbackToolSurface;
  excludeToolNames?: Iterable<string>;
  disablePluginTools?: boolean;
  senderIsOwner?: boolean;
}) {
  const {
    agentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({ config: params.cfg, sessionKey: params.sessionKey });
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
  const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, profileAlsoAllow);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(
    providerProfilePolicy,
    providerProfileAlsoAllow,
  );
  const groupPolicy = resolveGroupToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    messageProvider: params.messageProvider,
    accountId: params.accountId ?? null,
  });
  const subagentPolicy = isSubagentSessionKey(params.sessionKey)
    ? resolveSubagentToolPolicy(params.cfg)
    : undefined;
  const workspaceDir = resolveAgentWorkspaceDir(
    params.cfg,
    agentId ?? resolveDefaultAgentId(params.cfg),
  );
  const policyAllowlist = collectExplicitAllowlist([
    profilePolicy,
    providerProfilePolicy,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    groupPolicy,
    subagentPolicy,
  ]);
  const surface = params.surface ?? "http";
  const loopbackToolSurface = params.loopbackToolSurface ?? "filtered";

  const scopedTools =
    surface === "loopback" && loopbackToolSurface === "full"
      ? resolveFullLoopbackTools({
          cfg: params.cfg,
          sessionKey: params.sessionKey,
          messageProvider: params.messageProvider,
          accountId: params.accountId,
          agentTo: params.agentTo,
          agentThreadId: params.agentThreadId,
          allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
          senderIsOwner: params.senderIsOwner,
          workspaceDir,
          agentId,
        })
      : applyToolPolicyPipeline({
          tools: resolveFilteredGatewayTools({
            cfg: params.cfg,
            sessionKey: params.sessionKey,
            messageProvider: params.messageProvider,
            accountId: params.accountId,
            agentTo: params.agentTo,
            agentThreadId: params.agentThreadId,
            allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
            allowMediaInvokeCommands: params.allowMediaInvokeCommands,
            disablePluginTools: params.disablePluginTools,
            senderIsOwner: params.senderIsOwner,
            workspaceDir,
            policyAllowlist,
          }),
          toolMeta: (tool: AnyAgentTool) => getPluginToolMeta(tool),
          warn: logWarn,
          steps: [
            ...buildDefaultToolPolicyPipelineSteps({
              profilePolicy: profilePolicyWithAlsoAllow,
              profile,
              profileUnavailableCoreWarningAllowlist: profilePolicy?.allow,
              providerProfilePolicy: providerProfilePolicyWithAlsoAllow,
              providerProfile,
              providerProfileUnavailableCoreWarningAllowlist: providerProfilePolicy?.allow,
              globalPolicy,
              globalProviderPolicy,
              agentPolicy,
              agentProviderPolicy,
              groupPolicy,
              agentId,
            }),
            { policy: subagentPolicy, label: "subagent tools.allow" },
          ],
        });
  const gatewayToolsCfg = params.cfg.gateway?.tools;
  const defaultGatewayDeny =
    surface === "http"
      ? DEFAULT_GATEWAY_HTTP_TOOL_DENY.filter((name) => !gatewayToolsCfg?.allow?.includes(name))
      : [];
  const gatewayDenySet = new Set([
    ...defaultGatewayDeny,
    ...(Array.isArray(gatewayToolsCfg?.deny) ? gatewayToolsCfg.deny : []),
    ...(params.excludeToolNames ? Array.from(params.excludeToolNames) : []),
  ]);

  return {
    agentId,
    tools: scopedTools.filter((tool) => !gatewayDenySet.has(tool.name)),
  };
}
