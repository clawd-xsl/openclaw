// Doctor canonicalization of legacy CLI-runtime model refs on every execution
// surface, so the retired claude-cli/<model> spelling never reaches dispatch.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeLegacyRuntimeModelRefs } from "./legacy-config-core-normalizers.js";

function migrate(cfg: OpenClawConfig): { cfg: OpenClawConfig; changes: string[] } {
  const changes: string[] = [];
  const out = normalizeLegacyRuntimeModelRefs(cfg, changes);
  return { cfg: out, changes };
}

describe("normalizeLegacyRuntimeModelRefs", () => {
  it("canonicalizes scattered claude-cli refs and records the runtime binding", () => {
    const { cfg } = migrate({
      agents: {
        defaults: {
          voiceModel: "claude-cli/claude-sonnet-4-6",
          heartbeat: { model: "claude-cli/claude-opus-4-7" },
          compaction: { memoryFlush: { model: "claude-cli/claude-opus-4-7" } },
        },
      },
      channels: { modelByChannel: { discord: { "*": "claude-cli/claude-sonnet-4-6" } } },
      hooks: { mappings: [{ model: "claude-cli/claude-opus-4-7" }] },
      messages: { tts: { summaryModel: "claude-cli/claude-sonnet-4-6" } },
      plugins: {
        entries: {
          "memory-core": { config: { summaries: { model: "claude-cli/claude-opus-4-7" } } },
        },
      },
    } as unknown as OpenClawConfig);

    const defaults = cfg.agents?.defaults as Record<string, unknown>;
    expect(defaults.voiceModel).toBe("anthropic/claude-sonnet-4-6");
    expect((defaults.heartbeat as Record<string, unknown>).model).toBe("anthropic/claude-opus-4-7");
    expect(
      ((defaults.compaction as Record<string, unknown>).memoryFlush as Record<string, unknown>)
        .model,
    ).toBe("anthropic/claude-opus-4-7");
    expect(
      (cfg.channels as Record<string, Record<string, Record<string, string>>>).modelByChannel
        .discord["*"],
    ).toBe("anthropic/claude-sonnet-4-6");
    expect((cfg.hooks as Record<string, Array<{ model: string }>>).mappings[0]?.model).toBe(
      "anthropic/claude-opus-4-7",
    );
    // Runtime binding is written so dispatch still selects the CLI backend.
    expect(
      (defaults.models as Record<string, { agentRuntime?: { id?: string } }>)[
        "anthropic/claude-opus-4-7"
      ]?.agentRuntime?.id,
    ).toBe("claude-cli");
  });

  it("drops the legacy allowlist key instead of keeping it selectable", () => {
    const { cfg } = migrate({
      agents: {
        defaults: {
          model: { primary: "claude-cli/claude-opus-4-7" },
          models: { "claude-cli/claude-opus-4-7": { alias: "canonical" } },
        },
      },
    } as unknown as OpenClawConfig);

    const models = cfg.agents?.defaults?.models as Record<string, unknown>;
    expect(models["claude-cli/claude-opus-4-7"]).toBeUndefined();
    expect(models["anthropic/claude-opus-4-7"]).toMatchObject({
      alias: "canonical",
      agentRuntime: { id: "claude-cli" },
    });
  });

  it("is idempotent: a re-run produces no further changes", () => {
    const first = migrate({
      agents: { defaults: { voiceModel: "claude-cli/claude-sonnet-4-6" } },
    } as unknown as OpenClawConfig);
    const second = migrate(first.cfg);
    expect(second.changes).toEqual([]);
  });
});
