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
    const nextEntry: CachedScopedTools = {
      tools: next.tools,
      toolSchema: buildMcpToolSchema(next.tools),
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
