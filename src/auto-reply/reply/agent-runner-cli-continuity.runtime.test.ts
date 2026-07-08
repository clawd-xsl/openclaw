import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  buildClaudeCliContinuityPrompt,
  generateClaudeCliContinuitySummary,
  readClaudeCliNativePromptTokens,
  readClaudeCliNativeUsage,
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

  it("reads the final native Claude call prompt and output usage", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-native-usage-"));
    const homeDir = path.join(root, "home");
    const sessionId = "f13c4c3a-355b-4d7a-8215-acdeaa5d44a5";
    const filePath = path.join(homeDir, ".claude", "projects", "workspace", `${sessionId}.jsonl`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      [
        "not-json",
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 2,
              cache_creation_input_tokens: 17_394,
              cache_read_input_tokens: 9_914,
              output_tokens: 1,
            },
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 2,
              cache_creation_input_tokens: 28,
              cache_read_input_tokens: 27_308,
              output_tokens: 6,
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );
    try {
      await withEnvAsync({ HOME: homeDir, CLAUDE_CONFIG_DIR: "" }, async () => {
        await expect(readClaudeCliNativeUsage(sessionId)).resolves.toEqual({
          promptTokens: 27_338,
          outputTokens: 6,
        });
        await expect(readClaudeCliNativePromptTokens(sessionId)).resolves.toBe(27_338);
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
