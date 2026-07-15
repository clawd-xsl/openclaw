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
    const cli = buildCliRunParamsFromEmbedded({
      params: { ...baseParams, provider: "claude-cli", model: "claude-cli/sonnet" },
      provider: "claude-cli",
      modelId: "sonnet",
    });
    expect(cli).toMatchObject({
      sessionId: "sess-1",
      sessionFile: "/tmp/sess-1.jsonl",
      workspaceDir: "/tmp/ws",
      prompt: "hello",
      provider: "claude-cli",
      model: "sonnet",
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
      modelId: "sonnet",
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
      modelId: "sonnet",
      runCliAgent,
    });
    expect(out).toBe(result);
    expect(runCliAgent).toHaveBeenCalledTimes(1);
    expect(runCliAgent.mock.calls[0]?.[0]).toMatchObject({
      provider: "claude-cli",
      model: "sonnet",
      prompt: "hello",
    });
  });
});
