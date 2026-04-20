import crypto from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  MCP_LOOPBACK_SERVER_NAME,
  MCP_LOOPBACK_SERVER_VERSION,
  MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS,
  jsonRpcError,
  jsonRpcResult,
  type JsonRpcRequest,
} from "./mcp-http.protocol.js";
import type { McpLoopbackTool, McpToolSchemaEntry } from "./mcp-http.schema.js";

type McpTextContent = Extract<NonNullable<CallToolResult["content"]>[number], { type: "text" }>;
type McpImageContent = Extract<NonNullable<CallToolResult["content"]>[number], { type: "image" }>;
type McpAudioContent = Extract<NonNullable<CallToolResult["content"]>[number], { type: "audio" }>;
type McpResourceLinkContent = Extract<
  NonNullable<CallToolResult["content"]>[number],
  { type: "resource_link" }
>;
type McpResourceContent = Extract<
  NonNullable<CallToolResult["content"]>[number],
  { type: "resource" }
>;
type McpToolCallContent = NonNullable<CallToolResult["content"]>[number];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toTextFallback(block: unknown): McpTextContent {
  return {
    type: "text",
    text: typeof block === "string" ? block : JSON.stringify(block),
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
    } satisfies McpResourceLinkContent;
  }

  if (block.type === "resource" && isPlainRecord(block.resource)) {
    return {
      type: "resource",
      resource: block.resource as McpResourceContent["resource"],
    } satisfies McpResourceContent;
  }

  return toTextFallback(block);
}

function normalizeToolCallContent(result: unknown): NonNullable<CallToolResult["content"]> {
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    return content.map((block) => normalizeToolCallBlock(block));
  }
  return [toTextFallback(result)];
}

export async function handleMcpJsonRpc(params: {
  message: JsonRpcRequest;
  tools: McpLoopbackTool[];
  toolSchema: McpToolSchemaEntry[];
}): Promise<object | null> {
  const { id, method, params: methodParams } = params.message;

  switch (method) {
    case "initialize": {
      const clientVersion = (methodParams?.protocolVersion as string) ?? "";
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
      const toolName = methodParams?.name as string;
      const toolArgs = (methodParams?.arguments ?? {}) as Record<string, unknown>;
      const tool = params.tools.find((candidate) => candidate.name === toolName);
      if (!tool) {
        return jsonRpcResult(id, {
          content: [{ type: "text", text: `Tool not available: ${toolName}` }],
          isError: true,
        });
      }
      const toolCallId = `mcp-${crypto.randomUUID()}`;
      try {
        const result = await tool.execute(toolCallId, toolArgs);
        return jsonRpcResult(id, {
          content: normalizeToolCallContent(result),
          isError: false,
        });
      } catch (error) {
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
