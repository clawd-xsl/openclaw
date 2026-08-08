// Agent step tests cover nested session handoff, transcript bookkeeping, and
// MCP runtime retirement after completed nested turns.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { runAgentStep, testing } from "./agent-step.js";

const runWaitMocks = vi.hoisted(() => ({
  waitForAgentRunReply: vi.fn(),
}));

const bundleMcpRuntimeMocks = vi.hoisted(() => ({
  retireSessionMcpRuntimeForSessionKey: vi.fn(async () => true),
}));

vi.mock("../run-wait.js", () => ({
  waitForAgentRunReply: runWaitMocks.waitForAgentRunReply,
}));

vi.mock("../agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey,
}));

describe("runAgentStep", () => {
  afterEach(() => {
    testing.setDepsForTest();
    vi.clearAllMocks();
  });

  it("retires bundle MCP runtime after successful nested agent steps", async () => {
    // Nested steps disable automatic delivery and carry provenance so the reply
    // returns through the message tool path instead of the channel.
    const gatewayCalls: CallGatewayOptions[] = [];
    testing.setDepsForTest({
      callGateway: async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
        gatewayCalls.push(opts);
        return { runId: "run-nested" } as T;
      },
    });
    runWaitMocks.waitForAgentRunReply.mockResolvedValue({
      status: "ok",
      replyText: "done",
    });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
      }),
    ).resolves.toBe("done");

    const params = gatewayCalls[0]?.params as
      | {
          message?: string;
          sessionKey?: string;
          deliver?: boolean;
          sourceReplyDeliveryMode?: string;
          lane?: string;
          inputProvenance?: { kind?: string; sourceTool?: string };
        }
      | undefined;
    expect(params?.message).toContain("[Inter-session message");
    expect(params?.sessionKey).toBe("agent:main:subagent:child");
    expect(params?.deliver).toBe(false);
    expect(params?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(params?.lane).toBe("nested:agent:main:subagent:child");
    expect(params?.inputProvenance?.kind).toBe("inter_session");
    expect(params?.inputProvenance?.sourceTool).toBe("sessions_send");
    expect(params?.message).toContain("isUser=false");
    expect(params?.message).toContain("hello");
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).toHaveBeenCalledWith({
      sessionKey: "agent:main:subagent:child",
      reason: "nested-agent-step-complete",
    });
  });

  it("does not retire bundle MCP runtime while nested agent steps are still pending", async () => {
    testing.setDepsForTest({
      callGateway: async <T = unknown>(): Promise<T> => ({ runId: "run-pending" }) as T,
    });
    runWaitMocks.waitForAgentRunReply.mockResolvedValue({
      status: "timeout",
    });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
      }),
    ).resolves.toBeUndefined();

    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
  });

  it("forwards explicit transcript bodies for nested bookkeeping turns", async () => {
    const gatewayCalls: CallGatewayOptions[] = [];
    const agentCommandFromIngress = vi.fn(async () => ({
      payloads: [{ text: "done", mediaUrl: null }],
      meta: { durationMs: 1 },
    }));
    testing.setDepsForTest({
      agentCommandFromIngress,
      callGateway: async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
        gatewayCalls.push(opts);
        return { runId: "run-nested" } as T;
      },
    });
    runWaitMocks.waitForAgentRunReply.mockResolvedValue({
      status: "ok",
      replyText: "done",
    });

    await runAgentStep({
      sessionKey: "agent:main:subagent:child",
      message: "internal announce step",
      transcriptMessage: "",
      extraSystemPrompt: "announce only",
      timeoutMs: 10_000,
    });

    expect(gatewayCalls).toStrictEqual([]);
    expect(agentCommandFromIngress).toHaveBeenCalledTimes(1);
    const ingressCalls = agentCommandFromIngress.mock.calls as unknown as Array<
      [{ message?: string; sourceReplyDeliveryMode?: string; transcriptMessage?: string }]
    >;
    const ingress = ingressCalls[0]?.[0];
    expect(ingress?.message).toContain("internal announce step");
    expect(ingress?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(ingress?.transcriptMessage).toBe("");
  });

  it.each(["REPLY_SKIP", "[[reply_to_current]] REPLY_SKIP"])(
    "returns normalized run-owned control reply %s instead of its message-tool mirror",
    async (finalAssistantRawText) => {
      testing.setDepsForTest({
        agentCommandFromIngress: vi.fn(async () => ({
          payloads: [{ text: "Already delivered", mediaUrl: null }],
          meta: {
            durationMs: 1,
            finalAssistantVisibleText: "Already delivered",
            finalAssistantRawText,
          },
        })),
      });

      await expect(
        runAgentStep({
          sessionKey: "agent:main:subagent:child",
          message: "announce",
          transcriptMessage: "",
          extraSystemPrompt: "announce only",
          timeoutMs: 10_000,
        }),
      ).resolves.toBe("REPLY_SKIP");
    },
  );

  it("keeps a captured source-reply payload when the assistant result is NO_REPLY", async () => {
    testing.setDepsForTest({
      agentCommandFromIngress: vi.fn(async () => ({
        payloads: [{ text: "Delivered through the message tool", mediaUrl: null }],
        meta: {
          durationMs: 1,
          finalAssistantVisibleText: "NO_REPLY",
          finalAssistantRawText: "NO_REPLY",
        },
      })),
    });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "announce",
        transcriptMessage: "",
        extraSystemPrompt: "announce only",
        timeoutMs: 10_000,
      }),
    ).resolves.toBe("Delivered through the message tool");
  });
});
