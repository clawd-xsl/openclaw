/**
 * Gateway tool-resolution tests.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

describe("resolveGatewayScopedTools", () => {
  beforeAll(() => {
    resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "room_event",
      surface: "loopback",
    });
  });

  it("force-allows the message tool for room-event loopback turns", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "room_event",
      surface: "loopback",
    });

    const messageTool = result.tools.find((tool) => tool.name === "message");
    expect(messageTool?.description).toContain(
      "visible replies to the current source conversation",
    );
  });

  it("keeps webchat room-event turns on automatic source delivery", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:webchat:forge-main",
      messageProvider: "webchat",
      inboundEventKind: "room_event",
      surface: "loopback",
    });

    // The message tool is always part of the loopback surface, but webchat
    // room events must not be forced into message_tool_only source replies.
    const messageTool = result.tools.find((tool) => tool.name === "message");
    expect(messageTool).toBeDefined();
    expect(messageTool?.description).not.toContain(
      "visible replies to the current source conversation",
    );
  });

  it("force-allows the message tool for routed webchat room-event turns", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "webchat",
      inboundEventKind: "room_event",
      sourceReplyDeliveryMode: "message_tool_only",
      surface: "loopback",
    });

    const messageTool = result.tools.find((tool) => tool.name === "message");
    expect(messageTool?.description).toContain(
      "visible replies to the current source conversation",
    );
  });

  it("keeps a stable loopback tool surface across delivery-mode changes", () => {
    // A CLI client fetches tools once per process and the loopback never
    // notifies list changes, so system-event and channel turns sharing one
    // warm session must resolve identical tool names regardless of the
    // per-turn source delivery mode.
    const resolve = (mode: "message_tool_only" | undefined) =>
      resolveGatewayScopedTools({
        cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
        sessionKey: "agent:main:signal:direct:owner",
        inboundEventKind: "user_request",
        sourceReplyDeliveryMode: mode,
        surface: "loopback",
      })
        .tools.map((tool) => tool.name)
        .toSorted();

    const automaticNames = resolve(undefined);
    expect(automaticNames).toContain("message");
    expect(automaticNames).toEqual(resolve("message_tool_only"));
  });

  it("keeps ordinary loopback turns under the configured profile", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "user_request",
      surface: "loopback",
    });

    // The profile still restricts everything except the always-on loopback
    // reply tool.
    const names = result.tools.map((tool) => tool.name);
    expect(names).toContain("message");
    expect(names).not.toContain("cron");
  });

  it("intersects runtime toolsAllow with the resolved surface", () => {
    const unrestricted = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:cron:job-1",
      surface: "loopback",
    });
    const unrestrictedNames = unrestricted.tools.map((tool) => tool.name);
    expect(unrestrictedNames).toContain("message");
    expect(unrestrictedNames).toContain("cron");

    const restricted = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:cron:job-1",
      surface: "loopback",
      runtimeToolsAllow: ["message", "web_search"],
    });

    const restrictedNames = restricted.tools.map((tool) => tool.name);
    expect(restrictedNames).toContain("message");
    expect(restrictedNames).toContain("web_search");
    expect(restrictedNames).not.toContain("cron");
  });

  it("materializes coding tools for the openclaw loopback surface", () => {
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:main",
      surface: "loopback",
      senderIsOwner: true,
      materializeCodingTools: true,
    });

    const names = result.tools.map((tool) => tool.name);
    for (const name of ["read", "write", "edit", "exec", "process"]) {
      expect(names).toContain(name);
    }
    expect(names).toContain("message");
  });

  it("keeps coding tools away from non-owner senders even when materialized", () => {
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:main",
      surface: "loopback",
      senderIsOwner: false,
      materializeCodingTools: true,
    });

    const names = result.tools.map((tool) => tool.name);
    for (const name of ["read", "write", "edit", "apply_patch", "exec", "process"]) {
      expect(names).not.toContain(name);
    }
  });

  it("grants restricted coding tools to runtime toolsAllow when materialized", () => {
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:cron:job-1",
      surface: "loopback",
      senderIsOwner: true,
      materializeCodingTools: true,
      runtimeToolsAllow: ["exec", "read", "message"],
    });

    const names = result.tools.map((tool) => tool.name).toSorted();
    expect(names).toContain("exec");
    expect(names).toContain("read");
    expect(names).toContain("message");
    expect(names).not.toContain("write");
    expect(names).not.toContain("cron");
  });

  it("never widens the profile surface through runtime toolsAllow", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "user_request",
      surface: "loopback",
      runtimeToolsAllow: ["cron"],
    });

    expect(result.tools.some((tool) => tool.name === "cron")).toBe(false);
  });

  it("disables all tools for an explicit empty runtime toolsAllow", () => {
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:cron:job-1",
      surface: "loopback",
      runtimeToolsAllow: [],
    });

    expect(result.tools).toHaveLength(0);
  });

  it("passes loopback yield context into sessions_yield", async () => {
    const onYield = vi.fn();
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal", alsoAllow: ["sessions_yield"] } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      sessionId: "session-123",
      onYield,
      surface: "loopback",
    });
    const yieldTool = result.tools.find((tool) => tool.name === "sessions_yield");
    if (!yieldTool) {
      throw new Error("expected sessions_yield tool");
    }

    const toolResult = await yieldTool.execute("tool-call-1", {
      message: "waiting on subagents",
    });

    expect(onYield).toHaveBeenCalledWith("waiting on subagents");
    expect(toolResult.details).toEqual({
      status: "yielded",
      message: "waiting on subagents",
    });
  });
});
