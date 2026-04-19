import { capturePluginRegistration } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import anthropicSetupPlugin from "./setup-api.js";

describe("anthropic setup plugin", () => {
  it("registers both Claude CLI setup backends", () => {
    const captured = capturePluginRegistration({ register: anthropicSetupPlugin.register });

    expect(captured.cliBackends).toContainEqual(
      expect.objectContaining({
        id: "claude-cli",
        bundleMcp: true,
        config: expect.objectContaining({
          command: "claude",
          modelArg: "--model",
          sessionArg: "--session-id",
        }),
      }),
    );
    expect(captured.cliBackends).toContainEqual(
      expect.objectContaining({
        id: "claude-cli-streaming",
        bundleMcp: true,
        config: expect.objectContaining({
          command: "claude",
          executionMode: "persistent-process",
          modelArg: "--model",
          sessionArg: "--session-id",
        }),
      }),
    );
  });
});
