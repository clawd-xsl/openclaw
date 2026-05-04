import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import { buildMemoryFlushPlan } from "./flush-plan.js";

const MAX_HANDLED_SESSION_IDS = 512;
const handledSessionIds = new Map<string, number>();

type TranscriptTurn = {
  role: "user" | "assistant";
  text: string;
};

type ModelRef = {
  provider: string;
  model: string;
};

function isPrimaryMainSession(params: { agentId?: string; sessionKey?: string }): boolean {
  if (params.agentId !== "main") {
    return false;
  }
  return params.sessionKey === "main" || params.sessionKey === "agent:main:main";
}

function rememberHandledSession(sessionId: string): boolean {
  if (!sessionId) {
    return false;
  }
  if (handledSessionIds.has(sessionId)) {
    return true;
  }
  handledSessionIds.set(sessionId, Date.now());
  while (handledSessionIds.size > MAX_HANDLED_SESSION_IDS) {
    const oldest = handledSessionIds.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    handledSessionIds.delete(oldest);
  }
  return false;
}

function readPrimaryModelSelection(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed || undefined;
  }
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const primary = (raw as { primary?: unknown }).primary;
  if (typeof primary !== "string") {
    return undefined;
  }
  const trimmed = primary.trim();
  return trimmed || undefined;
}

function parseConfiguredModelRef(raw: string): ModelRef | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return undefined;
  }
  const provider = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  if (!provider || !model) {
    return undefined;
  }
  return { provider, model };
}

function buildConfiguredModelAliasIndex(cfg: OpenClawPluginApi["config"]): Map<string, ModelRef> {
  const aliases = new Map<string, ModelRef>();
  const configuredModels = cfg.agents?.defaults?.models;
  if (!configuredModels || typeof configuredModels !== "object") {
    return aliases;
  }
  for (const [rawKey, rawEntry] of Object.entries(configuredModels)) {
    const parsed = parseConfiguredModelRef(rawKey);
    if (!parsed) {
      continue;
    }
    const alias =
      rawEntry &&
      typeof rawEntry === "object" &&
      typeof (rawEntry as { alias?: unknown }).alias === "string"
        ? (rawEntry as { alias: string }).alias.trim()
        : "";
    if (!alias) {
      continue;
    }
    aliases.set(alias.toLowerCase(), parsed);
  }
  return aliases;
}

function inferUniqueProviderFromConfiguredModels(params: {
  cfg: OpenClawPluginApi["config"];
  model: string;
}): string | undefined {
  const trimmedModel = params.model.trim();
  if (!trimmedModel) {
    return undefined;
  }
  const normalizedModel = trimmedModel.toLowerCase();
  const providers = new Set<string>();
  const addProvider = (provider: string) => {
    const trimmedProvider = provider.trim();
    if (trimmedProvider) {
      providers.add(trimmedProvider);
    }
  };

  const configuredModels = params.cfg.agents?.defaults?.models;
  if (configuredModels && typeof configuredModels === "object") {
    for (const key of Object.keys(configuredModels)) {
      const parsed = parseConfiguredModelRef(key);
      if (!parsed) {
        continue;
      }
      if (parsed.model === trimmedModel || parsed.model.toLowerCase() === normalizedModel) {
        addProvider(parsed.provider);
        if (providers.size > 1) {
          return undefined;
        }
      }
    }
  }

  const configuredProviders = params.cfg.models?.providers;
  if (configuredProviders && typeof configuredProviders === "object") {
    for (const [providerId, providerConfig] of Object.entries(configuredProviders)) {
      const models =
        providerConfig && typeof providerConfig === "object"
          ? (providerConfig as { models?: Array<{ id?: string }> }).models
          : undefined;
      if (!Array.isArray(models)) {
        continue;
      }
      for (const entry of models) {
        const modelId = typeof entry?.id === "string" ? entry.id.trim() : "";
        if (!modelId) {
          continue;
        }
        if (modelId === trimmedModel || modelId.toLowerCase() === normalizedModel) {
          addProvider(providerId);
        }
      }
      if (providers.size > 1) {
        return undefined;
      }
    }
  }

  if (providers.size !== 1) {
    return undefined;
  }
  return providers.values().next().value;
}

function resolveAgentOverrideModelSelection(
  cfg: OpenClawPluginApi["config"],
  agentId?: string,
): string | undefined {
  if (!agentId || !Array.isArray(cfg.agents?.list)) {
    return undefined;
  }
  const agent = cfg.agents.list.find((entry) => entry?.id === agentId);
  return readPrimaryModelSelection(agent?.model);
}

// memory-core runs across the plugin boundary, so it cannot import core model
// selection internals directly. Keep a narrow local resolver aligned with the
// default-model semantics needed for rollover flush runs.
function resolveRolloverModelRef(params: {
  cfg: OpenClawPluginApi["config"];
  agentId?: string;
  fallbackProvider: string;
  fallbackModel: string;
}): ModelRef {
  const configuredModel =
    resolveAgentOverrideModelSelection(params.cfg, params.agentId) ??
    readPrimaryModelSelection(params.cfg.agents?.defaults?.model);
  if (!configuredModel) {
    return {
      provider: params.fallbackProvider,
      model: params.fallbackModel,
    };
  }

  const parsed = parseConfiguredModelRef(configuredModel);
  if (parsed) {
    return parsed;
  }

  const aliasMatch = buildConfiguredModelAliasIndex(params.cfg).get(configuredModel.toLowerCase());
  if (aliasMatch) {
    return aliasMatch;
  }

  const inferredProvider = inferUniqueProviderFromConfiguredModels({
    cfg: params.cfg,
    model: configuredModel,
  });
  if (inferredProvider) {
    return {
      provider: inferredProvider,
      model: configuredModel,
    };
  }

  return {
    provider: params.fallbackProvider,
    model: configuredModel,
  };
}

function extractTranscriptText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as { content?: unknown; text?: unknown };
  if (typeof record.text === "string") {
    const trimmed = record.text.trim();
    return trimmed || undefined;
  }
  if (typeof record.content === "string") {
    const trimmed = record.content.trim();
    return trimmed || undefined;
  }
  if (!Array.isArray(record.content)) {
    return undefined;
  }
  const text = record.content
    .flatMap((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? [
            typeof (part as { text?: unknown }).text === "string"
              ? (part as { text: string }).text
              : "",
          ]
        : [],
    )
    .join("\n")
    .trim();
  return text || undefined;
}

async function readTranscriptTurns(sessionFile: string): Promise<TranscriptTurn[]> {
  const raw = await fs.readFile(sessionFile, "utf8");
  const turns: TranscriptTurn[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const message =
      parsed && typeof parsed === "object" && "message" in parsed
        ? (parsed as { message?: unknown }).message
        : undefined;
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = (message as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = extractTranscriptText(message);
    if (!text) {
      continue;
    }
    turns.push({ role, text });
  }
  return turns;
}

function buildTranscriptBootstrap(turns: TranscriptTurn[]): string {
  const lines = turns.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`);
  return [
    "The following is the full transcript of the session that just ended.",
    "Treat it as prior conversation context for memory extraction only.",
    "",
    "[Ended session transcript]",
    "",
    ...lines,
    "",
    "[Memory flush task]",
    "",
  ].join("\n");
}

function buildRolloverMemoryFlushPrompt(params: {
  transcriptTurns: TranscriptTurn[];
  flushPrompt: string;
}): string {
  return `${buildTranscriptBootstrap(params.transcriptTurns)}${params.flushPrompt}`;
}

export function registerSessionRolloverMemoryFlush(api: OpenClawPluginApi): void {
  api.on("session_end", async (event, ctx) => {
    if (
      !event.nextSessionId ||
      !event.sessionFile ||
      !isPrimaryMainSession({ agentId: ctx.agentId, sessionKey: ctx.sessionKey })
    ) {
      return;
    }
    if (rememberHandledSession(event.sessionId)) {
      return;
    }

    const cfg = api.runtime.config.loadConfig();
    const flushPlan = buildMemoryFlushPlan({ cfg });
    if (!flushPlan) {
      return;
    }

    let transcriptTurns: TranscriptTurn[];
    try {
      transcriptTurns = await readTranscriptTurns(event.sessionFile);
    } catch (error) {
      api.logger.warn(
        `memory-core: failed to read rollover transcript for ${event.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (transcriptTurns.length === 0) {
      return;
    }

    const agentId = ctx.agentId ?? "main";
    const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId);
    const agentDir = api.runtime.agent.resolveAgentDir(cfg, agentId);
    const rolloverDir = path.join(workspaceDir, ".openclaw-memory", "rollover-flush");
    const sessionId = `memory-rollover-${event.sessionId}`;
    const sessionFile = path.join(rolloverDir, `${sessionId}.jsonl`);
    const prompt = buildRolloverMemoryFlushPrompt({
      transcriptTurns,
      flushPrompt: flushPlan.prompt,
    });
    const { provider, model } = resolveRolloverModelRef({
      cfg,
      agentId,
      fallbackProvider: api.runtime.agent.defaults.provider,
      fallbackModel: api.runtime.agent.defaults.model,
    });

    try {
      await fs.mkdir(rolloverDir, { recursive: true });
      await api.runtime.agent.runEmbeddedPiAgent({
        sessionId,
        agentId,
        trigger: "memory",
        memoryFlushWritePath: flushPlan.relativePath,
        sessionFile,
        workspaceDir,
        agentDir,
        config: cfg,
        provider,
        model,
        prompt,
        extraSystemPrompt: `Session rollover memory flush.\n\n${flushPlan.systemPrompt}`,
        timeoutMs: api.runtime.agent.resolveAgentTimeoutMs({ cfg }),
        runId: sessionId,
        disableMessageTool: true,
        silentExpected: true,
        cleanupBundleMcpOnRunEnd: true,
      });
    } catch (error) {
      api.logger.warn(
        `memory-core: rollover memory flush failed for ${event.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await fs.rm(sessionFile, { force: true }).catch(() => {});
    }
  });
}

export const __testing = {
  buildRolloverMemoryFlushPrompt,
  readTranscriptTurns,
  resolveRolloverModelRef,
  resetHandledSessionIds: () => handledSessionIds.clear(),
};
