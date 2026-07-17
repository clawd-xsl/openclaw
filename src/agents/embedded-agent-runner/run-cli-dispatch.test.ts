import { describe, expect, it, vi } from "vitest";
import { buildCliRunParamsFromEmbedded, runEmbeddedRunViaCliBackend } from "./run-cli-dispatch.js";
import type { RunEmbeddedAgentParams } from "./run/params.js";

const baseParams: RunEmbeddedAgentParams & { sessionFile: string } = {
  sessionId: "sess-1",
  sessionFile: "/tmp/sess-1.jsonl",
  workspaceDir: "/tmp/ws",
  prompt: "hello",
  timeoutMs: 30_000,
  runId: "run-1",
};

describe("buildCliRunParamsFromEmbedded", () => {
  it("maps required fields and overrides provider/model with the resolved pair", () => {
    // Canonical request shape: an API provider/model ref whose configured agent
    // runtime binding resolved to the claude-cli execution provider.
    const cli = buildCliRunParamsFromEmbedded({
      params: { ...baseParams, provider: "anthropic", model: "anthropic/claude-sonnet-4-5" },
      provider: "claude-cli",
      modelId: "claude-sonnet-4-5",
    });
    expect(cli).toMatchObject({
      sessionId: "sess-1",
      sessionFile: "/tmp/sess-1.jsonl",
      workspaceDir: "/tmp/ws",
      prompt: "hello",
      provider: "claude-cli",
      model: "claude-sonnet-4-5",
      timeoutMs: 30_000,
      runId: "run-1",
    });
  });

  it("passes through shared optional fields and drops undefined ones", () => {
    const abort = new AbortController();
    const cli = buildCliRunParamsFromEmbedded({
      params: {
        ...baseParams,
        agentId: "main",
        sessionKey: "agent:main:signal:direct:abc",
        extraSystemPrompt: "brief instruction",
        toolsAllow: [],
        abortSignal: abort.signal,
        oneShotCliRun: true,
        cleanupCliLiveSessionOnRunEnd: true,
      },
      provider: "claude-cli",
      modelId: "claude-sonnet-4-5",
    });
    expect(cli.agentId).toBe("main");
    expect(cli.sessionKey).toBe("agent:main:signal:direct:abc");
    expect(cli.extraSystemPrompt).toBe("brief instruction");
    expect(cli.toolsAllow).toEqual([]);
    expect(cli.abortSignal).toBe(abort.signal);
    expect(cli.oneShotCliRun).toBe(true);
    expect(cli.cleanupCliLiveSessionOnRunEnd).toBe(true);
    expect("trigger" in cli).toBe(false);
    expect("thinkLevel" in cli).toBe(false);
  });
});

describe("runEmbeddedRunViaCliBackend", () => {
  it("invokes the injected runCliAgent with the mapped params and returns its result", async () => {
    const result = { payloads: [{ text: "ok" }] } as never;
    const runCliAgent = vi.fn().mockResolvedValue(result);
    const out = await runEmbeddedRunViaCliBackend({
      params: baseParams,
      provider: "claude-cli",
      modelId: "claude-sonnet-4-5",
      runCliAgent,
    });
    expect(out).toBe(result);
    expect(runCliAgent).toHaveBeenCalledTimes(1);
    expect(runCliAgent.mock.calls[0]?.[0]).toMatchObject({
      provider: "claude-cli",
      model: "claude-sonnet-4-5",
      prompt: "hello",
    });
  });

  describe("CLI session binding round-trip", () => {
    it("passes a prior binding into the CLI run params", () => {
      const cli = buildCliRunParamsFromEmbedded(
        { params: baseParams, provider: "claude-cli", modelId: "sonnet" },
        { sessionId: "claude-abc" },
      );
      expect(cli.cliSessionBinding).toEqual({ sessionId: "claude-abc" });
    });

    it("reads the prior binding and persists the new one after the run", async () => {
      const write = vi.fn(async () => {});
      const bindingStore = {
        read: vi.fn(() => ({ sessionId: "warm-1" })),
        write,
      };
      const runCliAgent = vi.fn().mockResolvedValue({
        payloads: [],
        meta: { agentMeta: { cliSessionBinding: { sessionId: "warm-2" } } },
      } as never);

      await runEmbeddedRunViaCliBackend({
        params: { ...baseParams, sessionKey: "agent:main:signal:direct:abc", agentId: "main" },
        provider: "claude-cli",
        modelId: "sonnet",
        runCliAgent,
        bindingStore,
      });

      // Prior binding was resumed.
      expect(bindingStore.read).toHaveBeenCalledWith(
        expect.any(String),
        "agent:main:signal:direct:abc",
        "main",
        "claude-cli",
      );
      expect(runCliAgent.mock.calls[0]?.[0]?.cliSessionBinding).toEqual({ sessionId: "warm-1" });
      // New binding was persisted.
      expect(write).toHaveBeenCalledWith(
        expect.any(String),
        "agent:main:signal:direct:abc",
        "main",
        "claude-cli",
        { sessionId: "warm-2" },
      );
    });
  });
});
