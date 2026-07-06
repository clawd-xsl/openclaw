// Gateway MCP loopback JSON-RPC handlers.
// Implements initialize, tools/list, tools/call, and notification handling.
import crypto from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runBeforeToolCallHook, type HookContext } from "../agents/agent-tools.before-tool-call.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  MCP_LOOPBACK_SERVER_NAME,
  MCP_LOOPBACK_SERVER_VERSION,
  MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS,
  jsonRpcError,
  jsonRpcResult,
  type JsonRpcRequest,
} from "./mcp-http.protocol.js";
import {
  readMcpLoopbackToolName,
  type McpLoopbackTool,
  type McpToolSchemaEntry,
} from "./mcp-http.schema.js";

type McpToolCallContent = NonNullable<CallToolResult["content"]>[number];
type McpTextContent = Extract<McpToolCallContent, { type: "text" }>;
type McpImageContent = Extract<McpToolCallContent, { type: "image" }>;
type McpAudioContent = Extract<McpToolCallContent, { type: "audio" }>;
type McpResourceLinkContent = Extract<McpToolCallContent, { type: "resource_link" }>;
type McpResourceContent = Extract<McpToolCallContent, { type: "resource" }>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toTextFallback(block: unknown): McpTextContent {
  let text: string;
  if (typeof block === "string") {
    text = block;
  } else {
    try {
      text = JSON.stringify(block) ?? String(block);
    } catch {
      text = String(block);
    }
  }
  return {
    type: "text",
    text,
  };
}

function normalizeToolCallBlock(block: unknown): McpToolCallContent {
  if (!isPlainRecord(block)) {
    return toTextFallback(block);
  }
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text } satisfies McpTextContent;
  }
  if (
    block.type === "image" &&
    typeof block.data === "string" &&
    typeof block.mimeType === "string"
  ) {
    return {
      type: "image",
      data: block.data,
      mimeType: block.mimeType,
    } satisfies McpImageContent;
  }
  if (
    block.type === "audio" &&
    typeof block.data === "string" &&
    typeof block.mimeType === "string"
  ) {
    return {
      type: "audio",
      data: block.data,
      mimeType: block.mimeType,
    } satisfies McpAudioContent;
  }
  if (
    block.type === "resource_link" &&
    typeof block.name === "string" &&
    typeof block.uri === "string"
  ) {
    return {
      type: "resource_link",
      name: block.name,
      uri: block.uri,
      ...(typeof block.title === "string" ? { title: block.title } : {}),
      ...(typeof block.description === "string" ? { description: block.description } : {}),
      ...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
      ...(typeof block.size === "number" ? { size: block.size } : {}),
    } satisfies McpResourceLinkContent;
  }
  if (
    block.type === "resource" &&
    isPlainRecord(block.resource) &&
    typeof block.resource.uri === "string" &&
    (typeof block.resource.text === "string" || typeof block.resource.blob === "string")
  ) {
    return {
      type: "resource",
      resource: block.resource as McpResourceContent["resource"],
    } satisfies McpResourceContent;
  }
  return toTextFallback(block);
}

// Tool implementations may return MCP content blocks, plain strings, or
// arbitrary JSON. Preserve valid structured blocks and safely stringify unknown ones.
function normalizeToolCallContent(result: unknown): NonNullable<CallToolResult["content"]> {
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    return content.map(normalizeToolCallBlock);
  }
  return [toTextFallback(result)];
}

/** Handles one MCP loopback JSON-RPC message and returns a response or notification null. */
export async function handleMcpJsonRpc(params: {
  message: JsonRpcRequest;
  tools: McpLoopbackTool[];
  toolSchema: McpToolSchemaEntry[];
  hookContext?: HookContext;
  signal?: AbortSignal;
  onToolCallResult?: (call: {
    toolName: string;
    args: Record<string, unknown>;
    result?: unknown;
    isError: boolean;
  }) => void;
  onToolCallPrepared?: (call: { toolName: string; args: Record<string, unknown> }) => void;
}): Promise<object | null> {
  const { id, method, params: methodParams } = params.message;

  switch (method) {
    case "initialize": {
      const clientVersion = (methodParams?.protocolVersion as string) ?? "";
      // Prefer the client-requested protocol when supported, otherwise fall
      // back to the newest/first supported version advertised by this server.
      const negotiated =
        MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === clientVersion) ??
        MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS[0];
      return jsonRpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: {
          name: MCP_LOOPBACK_SERVER_NAME,
          version: MCP_LOOPBACK_SERVER_VERSION,
        },
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "tools/list":
      return jsonRpcResult(id, { tools: params.toolSchema });
    case "tools/call": {
      const toolName = typeof methodParams?.name === "string" ? methodParams.name.trim() : "";
      const toolArgs = (methodParams?.arguments ?? {}) as Record<string, unknown>;
      if (!toolName) {
        return jsonRpcResult(id, {
          content: [{ type: "text", text: "Tool not available: unknown" }],
          isError: true,
        });
      }
      if (!params.toolSchema.some((tool) => tool.name === toolName)) {
        return jsonRpcResult(id, {
          content: [{ type: "text", text: `Tool not available: ${toolName}` }],
          isError: true,
        });
      }
      const tool = params.tools.find(
        (candidate) => readMcpLoopbackToolName(candidate) === toolName,
      );
      if (!tool) {
        return jsonRpcResult(id, {
          content: [{ type: "text", text: `Tool not available: ${toolName}` }],
          isError: true,
        });
      }
      const toolCallId = `mcp-${crypto.randomUUID()}`;
      let executedToolArgs = toolArgs;
      const reportToolCallResult = (result: unknown, isError: boolean) => {
        try {
          params.onToolCallResult?.({
            toolName,
            args: executedToolArgs,
            result,
            isError,
          });
        } catch {
          // Observability callbacks must never alter the tool result returned to the MCP client.
        }
      };
      try {
        // Gateway before-tool hooks still run for loopback MCP calls so policy
        // and audit behavior matches native tool calls from normal chat runs.
        const hookResult = await runBeforeToolCallHook({
          toolName,
          params: toolArgs,
          toolCallId,
          ctx: params.hookContext,
          signal: params.signal,
        });
        if (hookResult.blocked) {
          return jsonRpcResult(id, {
            content: [{ type: "text", text: hookResult.reason }],
            isError: true,
          });
        }
        executedToolArgs = hookResult.params as Record<string, unknown>;
        try {
          params.onToolCallPrepared?.({ toolName, args: executedToolArgs });
        } catch {
          // Observability callbacks must never alter the tool result returned to the MCP client.
        }
        const result = await tool.execute(toolCallId, hookResult.params, params.signal);
        reportToolCallResult(result, false);
        return jsonRpcResult(id, {
          content: normalizeToolCallContent(result),
          isError: false,
        });
      } catch (error) {
        reportToolCallResult(error, true);
        const message = formatErrorMessage(error);
        return jsonRpcResult(id, {
          content: [{ type: "text", text: message || "tool execution failed" }],
          isError: true,
        });
      }
    }
    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}
