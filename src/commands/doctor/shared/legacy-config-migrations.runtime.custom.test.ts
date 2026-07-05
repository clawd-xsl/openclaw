import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_CUSTOM } from "./legacy-config-migrations.runtime.custom.js";

const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_CUSTOM.find(
  (entry) => entry.id === "custom.20260415.remove-unsupported-config",
);

function apply(raw: Record<string, unknown>): string[] {
  const changes: string[] = [];
  migration!.apply(raw, changes);
  return changes;
}

describe("custom/20260415 legacy config migration", () => {
  it("removes unsupported keys while preserving the restored host attachment policy", () => {
    const raw = {
      gateway: { cliMcp: { toolSurface: "full" } },
      tools: { fs: { allowAllHostSendFileTypes: true } },
      agents: {
        defaults: {
          tools: { fs: { allowAllHostSendFileTypes: false } },
          untrustedSystemEventsDowngradeSenderIsOwner: true,
        },
        list: [
          {
            id: "worker",
            tools: { fs: { allowAllHostSendFileTypes: true } },
          },
        ],
      },
      hooks: {
        mappings: [{ id: "incoming", deleteAfterRun: false }],
      },
    };

    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toEqual([
      "gateway.cliMcp",
      "agents.defaults",
      "hooks.mappings",
      "agents.defaults.untrustedSystemEventsDowngradeSenderIsOwner",
    ]);

    expect(apply(raw)).toEqual([
      "Removed unsupported gateway.cliMcp.",
      "Removed obsolete agents.defaults.tools.fs.allowAllHostSendFileTypes; tools.fs.allowAllHostSendFileTypes is already configured.",
      "Removed unsupported hooks.mappings.0.deleteAfterRun.",
      "Removed unsupported agents.defaults.untrustedSystemEventsDowngradeSenderIsOwner.",
    ]);
    expect(findLegacyConfigIssues(raw)).toEqual([]);
    expect(raw.tools).toEqual({ fs: { allowAllHostSendFileTypes: true } });
    expect(raw.agents).toMatchObject({
      defaults: {},
      list: [{ tools: { fs: { allowAllHostSendFileTypes: true } } }],
    });
  });

  it("is a no-op when repeated", () => {
    const raw = {
      gateway: { cliMcp: {} },
      agents: {
        list: [{ id: "one", tools: { fs: { allowAllHostSendFileTypes: true } } }],
      },
    };

    expect(apply(raw)).toHaveLength(1);
    expect(apply(raw)).toEqual([]);
    expect(raw.agents.list[0]?.tools.fs.allowAllHostSendFileTypes).toBe(true);
  });

  it("preserves adjacent supported fields including loopback auth mode none", () => {
    const raw = {
      gateway: {
        bind: "loopback",
        port: 18_789,
        auth: { mode: "none" },
        cliMcp: { toolSurface: "filtered" },
      },
      tools: {
        fs: { workspaceOnly: true, allowAllHostSendFileTypes: true },
        exec: { security: "deny" },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          tools: { fs: { workspaceOnly: false, allowAllHostSendFileTypes: false } },
          untrustedSystemEventsDowngradeSenderIsOwner: false,
        },
        list: [
          {
            id: "worker",
            name: "Worker",
            tools: { fs: { workspaceOnly: true, allowAllHostSendFileTypes: true } },
          },
        ],
      },
      hooks: {
        enabled: true,
        mappings: [
          {
            id: "incoming",
            match: { path: "incoming" },
            action: "agent",
            deliver: true,
            deleteAfterRun: true,
          },
        ],
      },
    };

    apply(raw);

    expect(raw).toEqual({
      gateway: {
        bind: "loopback",
        port: 18_789,
        auth: { mode: "none" },
      },
      tools: {
        fs: { workspaceOnly: true, allowAllHostSendFileTypes: true },
        exec: { security: "deny" },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          tools: { fs: { workspaceOnly: false } },
        },
        list: [
          {
            id: "worker",
            name: "Worker",
            tools: { fs: { workspaceOnly: true, allowAllHostSendFileTypes: true } },
          },
        ],
      },
      hooks: {
        enabled: true,
        mappings: [
          {
            id: "incoming",
            match: { path: "incoming" },
            action: "agent",
            deliver: true,
          },
        ],
      },
    });
  });

  it("moves the retired agent-default host attachment policy to the global policy", () => {
    const raw = {
      agents: {
        defaults: {
          tools: { fs: { allowAllHostSendFileTypes: true } },
        },
      },
    };

    expect(apply(raw)).toEqual([
      "Moved agents.defaults.tools.fs.allowAllHostSendFileTypes to tools.fs.allowAllHostSendFileTypes.",
    ]);
    expect(raw).toEqual({
      agents: { defaults: {} },
      tools: { fs: { allowAllHostSendFileTypes: true } },
    });
  });
});
