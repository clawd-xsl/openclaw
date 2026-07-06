import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildClaudeCliContinuityPrompt,
  generateClaudeCliContinuitySummary,
  sanitizeClaudeCliContinuityText,
  setCliContinuityRuntimeTestDeps,
} from "./agent-runner-cli-continuity.runtime.js";

describe("Claude CLI continuity summary source", () => {
  afterEach(() => {
    setCliContinuityRuntimeTestDeps();
  });

  it("uses the exact six-section contract and preserves tool outcomes", () => {
    const result = buildClaudeCliContinuityPrompt({
      cliSessionId: "native-session",
      messages: [
        { role: "user", content: "Keep the persistent backend" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } },
            { type: "tool_result", name: "Read", content: "export const answer = 42" },
          ],
        },
      ],
    });

    expect(result?.messageCount).toBe(2);
    for (const heading of [
      "## Decisions",
      "## Open TODOs",
      "## Constraints/Rules",
      "## Pending user asks",
      "## Exact identifiers",
      "## Useful recent context",
    ]) {
      expect(result?.prompt).toContain(heading);
    }
    expect(result?.prompt).toContain("[tool call: Read]");
    expect(result?.prompt).toContain("src/a.ts");
    expect(result?.prompt).toContain("export const answer = 42");
  });

  it("drops hidden reasoning and inline image payloads", () => {
    const result = buildClaudeCliContinuityPrompt({
      cliSessionId: "native-session",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "secret reasoning" },
            { type: "image", source: { data: "a".repeat(2_000) } },
            { type: "text", text: "visible result" },
          ],
        },
      ],
    });

    expect(result?.prompt).toContain("visible result");
    expect(result?.prompt).toContain("[image omitted");
    expect(result?.prompt).not.toContain("secret reasoning");
    expect(result?.prompt).not.toContain("a".repeat(1_000));
  });

  it("force-redacts credentials and private keys before model input", () => {
    const result = buildClaudeCliContinuityPrompt({
      cliSessionId: "native-session",
      messages: [
        {
          role: "user",
          content:
            "Authorization: Bearer secret-token-value\napi_key=sk-ant-abcdefghijklmnopqrstuvwxyz\n-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----",
        },
      ],
    });

    expect(result?.prompt).toContain("[REDACTED");
    expect(result?.prompt).not.toContain("secret-token-value");
    expect(result?.prompt).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz");
    expect(result?.prompt).not.toContain("secret-material");
  });

  it("force-redacts secrets nested in structured tool arguments", () => {
    const result = buildClaudeCliContinuityPrompt({
      cliSessionId: "native-session",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Configure",
              input: { api_key: "sk-ant-structured-secret-value", project: "keep-this-id" },
            },
          ],
        },
      ],
    });

    expect(result?.prompt).toContain("keep-this-id");
    expect(result?.prompt).toMatch(/REDACTED|\*\*\*/u);
    expect(result?.prompt).not.toContain("sk-ant-structured-secret-value");
  });

  it("force-redacts generated summary text before it can be persisted", () => {
    const sanitized = sanitizeClaudeCliContinuityText(
      "## Exact identifiers\nAuthorization: Bearer generated-secret-value\napi_key=sk-ant-generated-secret-value",
    );

    expect(sanitized).toContain("## Exact identifiers");
    expect(sanitized).not.toContain("generated-secret-value");
    expect(sanitized).not.toContain("sk-ant-generated-secret-value");
  });

  it("keeps the isolated summary run from closing shared MCP loopback state", async () => {
    const runCliAgent = vi.fn(async () => ({
      payloads: [{ text: "## Decisions\nKeep the persistent backend" }],
      meta: {},
    }));
    setCliContinuityRuntimeTestDeps({
      readClaudeCliSessionMessages: (() => [
        { role: "user", content: "Preserve continuity" },
      ]) as never,
      runCliAgent: runCliAgent as never,
    });

    await expect(
      generateClaudeCliContinuitySummary({
        cfg: {},
        cliSessionId: "native-session",
        workspaceDir: "/tmp",
        provider: "claude-cli",
        timeoutMs: 30_000,
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(runCliAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        disableTools: true,
        oneShotCliRun: true,
        cleanupCliLiveSessionOnRunEnd: true,
      }),
    );
    expect(runCliAgent.mock.calls[0]?.[0]).not.toHaveProperty("cleanupBundleMcpOnRunEnd");
  });
});
