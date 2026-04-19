import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearActiveMcpLoopbackRuntime,
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  setActiveMcpLoopbackRuntime,
} from "./mcp-http.loopback-runtime.js";
import {
  buildMcpToolSchema,
  type McpLoopbackTool,
  type McpToolSchemaEntry,
} from "./mcp-http.schema.js";
import { resolveGatewayScopedTools, type GatewayLoopbackToolSurface } from "./tool-resolution.js";

const TOOL_CACHE_TTL_MS = 30_000;
const NATIVE_TOOL_EXCLUDE = new Set(["read", "write", "edit", "apply_patch", "exec", "process"]);

function resolveLoopbackToolSurface(cfg: OpenClawConfig): GatewayLoopbackToolSurface {
  return cfg.gateway?.cliMcp?.toolSurface === "full" ? "full" : "filtered";
}

type CachedScopedTools = {
  tools: McpLoopbackTool[];
  toolSchema: McpToolSchemaEntry[];
  configRef: OpenClawConfig;
  time: number;
};

export class McpLoopbackToolCache {
  #entries = new Map<string, CachedScopedTools>();

  #sortTools(tools: McpLoopbackTool[]): McpLoopbackTool[] {
    return [...tools].toSorted((left, right) => left.name.localeCompare(right.name));
  }

  resolve(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    messageProvider: string | undefined;
    accountId: string | undefined;
    senderIsOwner: boolean | undefined;
  }): CachedScopedTools {
    const cacheKey = [
      params.sessionKey,
      params.messageProvider ?? "",
      params.accountId ?? "",
      params.senderIsOwner === true ? "owner" : params.senderIsOwner === false ? "non-owner" : "",
    ].join("\u0000");
    const now = Date.now();
    const cached = this.#entries.get(cacheKey);
    if (cached && cached.configRef === params.cfg && now - cached.time < TOOL_CACHE_TTL_MS) {
      return cached;
    }

    const toolSurface = resolveLoopbackToolSurface(params.cfg);
    const next = resolveGatewayScopedTools({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      messageProvider: params.messageProvider,
      accountId: params.accountId,
      senderIsOwner: params.senderIsOwner,
      surface: "loopback",
      loopbackToolSurface: toolSurface,
      excludeToolNames: toolSurface === "filtered" ? NATIVE_TOOL_EXCLUDE : undefined,
    });
    // Keep Claude-facing MCP tool bytes stable across turns. Internal plugin or
    // policy resolution can legitimately produce the same tool set in a
    // different order; sorting here avoids gratuitous prompt-cache churn.
    const sortedTools = this.#sortTools(next.tools);
    const nextEntry: CachedScopedTools = {
      tools: sortedTools,
      toolSchema: buildMcpToolSchema(sortedTools),
      configRef: params.cfg,
      time: now,
    };
    this.#entries.set(cacheKey, nextEntry);
    for (const [key, entry] of this.#entries) {
      if (now - entry.time >= TOOL_CACHE_TTL_MS) {
        this.#entries.delete(key);
      }
    }
    return nextEntry;
  }
}

export {
  clearActiveMcpLoopbackRuntime,
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  setActiveMcpLoopbackRuntime,
};
