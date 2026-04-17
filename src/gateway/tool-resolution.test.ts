import { beforeEach, describe, expect, it, vi } from "vitest";

const createOpenClawToolsMock = vi.hoisted(() =>
  vi.fn(() => [{ name: "gateway" }, { name: "sessions_list" }]),
);
const createOpenClawCodingToolsMock = vi.hoisted(() =>
  vi.fn(() => [{ name: "exec" }, { name: "read" }, { name: "gateway" }]),
);

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
  resolveDefaultAgentId: () => "main",
}));

vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawTools: (...args: Parameters<typeof createOpenClawToolsMock>) =>
    createOpenClawToolsMock(...args),
}));

vi.mock("../agents/pi-tools.js", () => ({
  createOpenClawCodingTools: (...args: Parameters<typeof createOpenClawCodingToolsMock>) =>
    createOpenClawCodingToolsMock(...args),
}));

vi.mock("../agents/pi-tools.policy.js", () => ({
  resolveEffectiveToolPolicy: () => ({
    agentId: "main",
    globalPolicy: undefined,
    globalProviderPolicy: undefined,
    agentPolicy: undefined,
    agentProviderPolicy: undefined,
    profile: undefined,
    providerProfile: undefined,
    profileAlsoAllow: undefined,
    providerProfileAlsoAllow: undefined,
  }),
  resolveGroupToolPolicy: () => undefined,
  resolveSubagentToolPolicy: () => undefined,
}));

vi.mock("../agents/tool-policy-pipeline.js", () => ({
  applyToolPolicyPipeline: ({ tools }: { tools: unknown[] }) => tools,
  buildDefaultToolPolicyPipelineSteps: () => [],
}));

vi.mock("../agents/tool-policy.js", () => ({
  collectExplicitAllowlist: () => undefined,
  mergeAlsoAllowPolicy: (policy: unknown) => policy,
  resolveToolProfilePolicy: () => undefined,
}));

vi.mock("../plugins/tools.js", () => ({
  getPluginToolMeta: () => undefined,
}));

vi.mock("../logger.js", () => ({
  logWarn: () => {},
}));

vi.mock("../routing/session-key.js", () => ({
  isSubagentSessionKey: () => false,
}));

import { resolveGatewayScopedTools } from "./tool-resolution.js";

describe("resolveGatewayScopedTools", () => {
  beforeEach(() => {
    createOpenClawToolsMock.mockClear();
    createOpenClawCodingToolsMock.mockClear();
  });

  it("uses the filtered gateway surface for loopback by default", () => {
    const result = resolveGatewayScopedTools({
      cfg: {},
      sessionKey: "agent:main:main",
      surface: "loopback",
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    expect(createOpenClawCodingToolsMock).not.toHaveBeenCalled();
    expect(result.tools.map((tool) => tool.name)).toEqual(["gateway", "sessions_list"]);
  });

  it("uses the full coding surface for loopback when requested", () => {
    const result = resolveGatewayScopedTools({
      cfg: {},
      sessionKey: "agent:main:main",
      surface: "loopback",
      loopbackToolSurface: "full",
      excludeToolNames: new Set(["read"]),
    });

    expect(createOpenClawCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionKey: "agent:main:main",
        config: {},
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(createOpenClawToolsMock).not.toHaveBeenCalled();
    expect(result.tools.map((tool) => tool.name)).toEqual(["exec", "gateway"]);
  });
});
