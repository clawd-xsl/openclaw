import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import "./test-helpers/fast-openclaw-tools-sessions.js";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("openclaw-tools session summaries registration", () => {
  it("registers the session_summaries tool", () => {
    const config = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      tools: {
        agentToAgent: {
          enabled: false,
        },
      },
    } as OpenClawConfig;

    const names = createOpenClawTools({
      config,
      disablePluginTools: true,
    }).map((tool) => tool.name);

    expect(names.filter((name) => name === "session_summaries")).toHaveLength(1);
  });
});
