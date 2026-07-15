// Pre-call context brief, two-stage so call pickup never waits on the slow part:
//
// 1. PERSONA brief — who the agent is and how it talks. Derived from the run's
//    own composed system prompt (persona/memory), independent of any caller, and
//    stable — so it is generated OFF the call path and cached in plugin state
//    (SQLite), keyed by agentId. The cache invalidates ONLY when the persona
//    workspace files (SOUL/IDENTITY/USER/AGENTS/MEMORY.md) change content —
//    no TTL, so an unchanged persona is never recomputed.
// 2. RECENT-TOPICS brief — a fast live compression of the last few caller
//    messages (tool calls already stripped) plus the spoken-language instruction.
//    Small input => seconds, overlapped with ringing/ICE setup.
//
// Both stages run as fully isolated one-shot embedded agents: a fresh randomUUID
// session on a throwaway session file (never the caller's session, no store
// entry, no pollution). The compressor model is config-selected
// (contextBrief.model) — an anthropic/* ref is a lean API call, a claude-cli/*
// ref spawns a separate throwaway CLI process; either way it is isolated from
// the caller's warm process (distinct sessionId => distinct live-session key).
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  collectRealtimeVoiceAgentConsultVisibleText,
  type RealtimeVoiceAgentConsultRuntime,
} from "openclaw/plugin-sdk/realtime-voice";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { readBoundedSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { getOptionalSignalRuntime } from "../runtime.js";
import type { SignalVoiceCallConfig } from "./config.js";

const log = createSubsystemLogger("signal/voice");

const DEFAULT_BRIEF_MAX_TOKENS = 1500;
const DEFAULT_BRIEF_TIMEOUT_MS = 4_000;
// Persona-forward split of contextBrief.maxTokens across the two stages.
const PERSONA_TOKEN_SHARE = 0.6;
// Workspace files that feed the persona portion of the composed system prompt
// (well-known OpenClaw workspace bootstrap names). The cached persona
// regenerates ONLY when one of these changes content — deliberately no TTL:
// they change rarely, and a timer would re-run the compressor on calls whose
// persona had not actually changed.
const PERSONA_SOURCE_FILES = ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "MEMORY.md"];
const PERSONA_STORE_NAMESPACE = "voice.persona-brief";
const PERSONA_STORE_MAX_ENTRIES = 64;
// Bound the topics compression INPUT: recent messages only, so the live run
// stays small and fast on the call-setup path.
const TOPICS_TRANSCRIPT_MAX_BYTES = 64 * 1024;
const TOPICS_TRANSCRIPT_MAX_EVENTS = 160;
const TOPICS_RECENT_MESSAGES = 30;

export type SignalVoiceContextBriefParams = {
  cfg: OpenClawConfig;
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  voiceConfig: SignalVoiceCallConfig;
  route: { agentId: string; sessionKey: string };
  peerAci: string;
};

type SignalVoicePersonaParams = Omit<SignalVoiceContextBriefParams, "peerAci">;

type PersonaBriefEntry = {
  brief: string;
  // Compressor identity at generation time; a config change invalidates the cache.
  modelKey: string;
  // Content hash of PERSONA_SOURCE_FILES at generation time.
  sourceHash: string;
};

/**
 * Generates the bounded briefing to inject into the realtime instructions.
 * Returns undefined ONLY when the feature is disabled. When enabled it is
 * fail-closed: any failure (timeout, model error, empty result) THROWS so the
 * caller declines/hangs up the call instead of answering without context.
 */
export async function generateSignalVoiceContextBrief(
  params: SignalVoiceContextBriefParams,
): Promise<string | undefined> {
  const brief = params.voiceConfig.contextBrief;
  if (!brief?.enabled) {
    return undefined;
  }
  // Persona first (cache hit is ~0ms; a miss generates live, fail-closed), then
  // the small live topics run. Sequential is fine: topics is the only live model
  // call on a warm cache and it overlaps ringing/ICE setup.
  const persona = await getPersonaBrief(params);
  const topics = await generateRecentTopicsBrief(params);
  return topics ? `${persona}\n\n${topics}` : persona;
}

/**
 * Warms the persona cache in the background at voice-runtime start. Reruns the
 * compressor ONLY when the persona source files changed since the cached copy
 * was generated (or the compressor config changed); otherwise it is a no-op
 * beyond hashing a handful of small files. Never throws; deduped per agent.
 */
export function refreshSignalVoicePersonaBrief(params: SignalVoicePersonaParams): void {
  const brief = params.voiceConfig.contextBrief;
  if (!brief?.enabled) {
    return;
  }
  const agentId = params.route.agentId;
  if (personaRefreshInFlight.has(agentId)) {
    return;
  }
  const task = (async () => {
    const { cached, sourceHash, modelKey } = await lookupPersonaBrief(params);
    if (cached) {
      return;
    }
    const persona = await runPersonaBriefAgent(params);
    storePersonaBrief(agentId, { brief: persona, modelKey, sourceHash });
    log.info(`signal voice: persona brief refreshed agent=${agentId} chars=${persona.length}`);
  })();
  personaRefreshInFlight.set(agentId, task);
  void task
    .catch((err) => {
      log.warn(`signal voice: persona brief refresh failed agent=${agentId}: ${String(err)}`);
    })
    .finally(() => {
      personaRefreshInFlight.delete(agentId);
    });
}

const personaRefreshInFlight = new Map<string, Promise<void>>();

async function getPersonaBrief(params: SignalVoiceContextBriefParams): Promise<string> {
  const { cached, sourceHash, modelKey } = await lookupPersonaBrief(params);
  if (cached) {
    return cached;
  }
  // Cache miss (first call for this agent, persona files changed, or the
  // compressor config changed): generate live — slower, but fail-closed
  // correctness beats answering blind — and cache for every following call.
  const persona = await runPersonaBriefAgent(params);
  storePersonaBrief(params.route.agentId, { brief: persona, modelKey, sourceHash });
  return persona;
}

async function lookupPersonaBrief(
  params: SignalVoicePersonaParams,
): Promise<{ cached: string | undefined; sourceHash: string; modelKey: string }> {
  const { cfg, agentRuntime, route } = params;
  const workspaceDir = agentRuntime.resolveAgentWorkspaceDir(cfg, route.agentId);
  const sourceHash = await computePersonaSourceHash(workspaceDir);
  const modelKey = personaModelKey(params.voiceConfig);
  const entry = openPersonaStore()?.lookup(route.agentId);
  const fresh = entry && entry.modelKey === modelKey && entry.sourceHash === sourceHash;
  return { cached: fresh ? entry.brief : undefined, sourceHash, modelKey };
}

async function computePersonaSourceHash(workspaceDir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const name of PERSONA_SOURCE_FILES) {
    hash.update(name);
    hash.update("\0");
    try {
      hash.update(await readFile(join(workspaceDir, name)));
    } catch {
      // Absent files hash distinctly from empty ones so adding a file later
      // still invalidates.
      hash.update("<absent>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function personaModelKey(voiceConfig: SignalVoiceCallConfig): string {
  const brief = voiceConfig.contextBrief;
  return `${brief?.provider ?? ""}\0${brief?.model ?? ""}`;
}

// Single-slot module cache: openSyncKeyedStore validates + touches SQLite.
let personaStore: PluginStateSyncKeyedStore<PersonaBriefEntry> | undefined;
function openPersonaStore(): PluginStateSyncKeyedStore<PersonaBriefEntry> | undefined {
  if (personaStore) {
    return personaStore;
  }
  const state = getOptionalSignalRuntime()?.state;
  if (!state) {
    // No runtime (tests/probe): persona still generates live, just uncached.
    return undefined;
  }
  personaStore = state.openSyncKeyedStore<PersonaBriefEntry>({
    namespace: PERSONA_STORE_NAMESPACE,
    maxEntries: PERSONA_STORE_MAX_ENTRIES,
  });
  return personaStore;
}

function storePersonaBrief(agentId: string, entry: PersonaBriefEntry): void {
  try {
    openPersonaStore()?.register(agentId, entry);
  } catch (err) {
    log.warn(`signal voice: persona brief store failed agent=${agentId}: ${String(err)}`);
  }
}

async function runPersonaBriefAgent(params: SignalVoicePersonaParams): Promise<string> {
  const maxTokens = params.voiceConfig.contextBrief?.maxTokens ?? DEFAULT_BRIEF_MAX_TOKENS;
  const personaTokens = Math.round(maxTokens * PERSONA_TOKEN_SHARE);
  return await runBriefAgent({
    params,
    prompt: "Write the persona briefing now.",
    instruction: buildPersonaInstruction(personaTokens),
    label: "persona brief",
  });
}

async function generateRecentTopicsBrief(
  params: SignalVoiceContextBriefParams,
): Promise<string | undefined> {
  const maxTokens = params.voiceConfig.contextBrief?.maxTokens ?? DEFAULT_BRIEF_MAX_TOKENS;
  const topicsTokens = maxTokens - Math.round(maxTokens * PERSONA_TOKEN_SHARE);
  const transcriptText = await readRecentCallerTranscriptText(params);
  if (!transcriptText) {
    // Brand-new caller: nothing to summarize (and no history to detect a
    // language from) — the persona alone is the briefing.
    return undefined;
  }
  const text = await runBriefAgent({
    params,
    prompt: `Recent conversation with the caller:\n\n${transcriptText}\n\n---\nWrite the recent-topics briefing now.`,
    instruction: buildTopicsInstruction(topicsTokens),
    label: "recent-topics brief",
  });
  log.info(
    `signal voice: recent-topics brief ready peer=${params.peerAci} agent=${params.route.agentId} chars=${text.length}`,
  );
  return text;
}

async function runBriefAgent(args: {
  params: SignalVoicePersonaParams;
  prompt: string;
  instruction: string;
  label: string;
}): Promise<string> {
  const { cfg, agentRuntime, voiceConfig, route } = args.params;
  const brief = voiceConfig.contextBrief;
  const timeoutMs = brief?.timeoutMs ?? DEFAULT_BRIEF_TIMEOUT_MS;
  const agentId = route.agentId;
  const workspaceDir = agentRuntime.resolveAgentWorkspaceDir(cfg, agentId);
  await agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });
  const agentDir = agentRuntime.resolveAgentDir(cfg, agentId);
  const runSessionId = randomUUID();
  const workspace = await tempWorkspace({
    rootDir: workspaceDir,
    prefix: "voice-brief-",
    dirMode: 0o700,
    mode: 0o600,
  });
  try {
    const sessionFile = await workspace.writeText(`${runSessionId}.jsonl`, "");
    const result = await agentRuntime.runEmbeddedAgent({
      sessionId: runSessionId,
      // Links the isolated run to the caller's agent context (workspace/sandbox)
      // without running on — or writing to — the caller's session.
      sandboxSessionKey: route.sessionKey,
      agentId,
      workspaceDir,
      agentDir,
      config: cfg,
      sessionFile,
      transcriptPrompt: "",
      prompt: args.prompt,
      extraSystemPrompt: args.instruction,
      timeoutMs,
      runId: randomUUID(),
      verboseLevel: "off",
      reasoningLevel: "off",
      toolsAllow: [],
      disableMessageTool: true,
      allowGatewaySubagentBinding: false,
      cleanupBundleMcpOnRunEnd: true,
      cleanupCliLiveSessionOnRunEnd: true,
      oneShotCliRun: true,
      suppressLiveStreamOutput: true,
      suppressToolErrorWarnings: true,
      silentExpected: true,
      ...(brief?.model ? { model: brief.model, modelFallbacksOverride: [] } : {}),
      ...(brief?.provider ? { provider: brief.provider } : {}),
    });
    const text = collectRealtimeVoiceAgentConsultVisibleText(result.payloads ?? [])?.trim();
    if (!text) {
      // Fail-closed: an empty brief must not silently become "no context".
      throw new Error(
        result.meta?.aborted
          ? `${args.label} run aborted before producing text`
          : `${args.label} run produced no text`,
      );
    }
    return text;
  } finally {
    await workspace.cleanup();
  }
}

async function readRecentCallerTranscriptText(
  params: SignalVoiceContextBriefParams,
): Promise<string> {
  const { agentRuntime, cfg, route } = params;
  const agentId = route.agentId;
  const storePath = agentRuntime.session.resolveStorePath(cfg.session?.store, { agentId });
  const callerEntry = agentRuntime.session.getSessionEntry({
    storePath,
    sessionKey: route.sessionKey,
  });
  const callerSessionId = callerEntry?.sessionId?.trim();
  if (!callerSessionId) {
    return "";
  }
  const transcript = await readBoundedSessionTranscriptEvents({
    agentId,
    sessionId: callerSessionId,
    sessionKey: route.sessionKey,
    ...(callerEntry?.sessionFile ? { sessionFile: callerEntry.sessionFile } : {}),
    maxBytes: TOPICS_TRANSCRIPT_MAX_BYTES,
    maxEvents: TOPICS_TRANSCRIPT_MAX_EVENTS,
  });
  if (!transcript.available) {
    return "";
  }
  return formatTranscriptForBrief(transcript.events, { maxMessages: TOPICS_RECENT_MESSAGES });
}

function buildPersonaInstruction(maxTokens: number): string {
  // Deliberately NOT a compaction/technical summary: this is who-you-are
  // material for sounding like the agent on a live call. Caller-independent so
  // it can be cached and reused across calls.
  return [
    `Write a persona briefing of at most ~${maxTokens} tokens for your realtime voice front-end,`,
    "which answers live voice calls with none of your context and must sound like you on the phone.",
    "",
    "Cover: your name, personality, how you talk, your tone and style, and how you should come",
    "across live on a call.",
    "",
    "Also cover your user: who they are, what you call them and how they address you, and the",
    "relationship and rapport between you two — familiarity, running jokes, how formal or casual",
    "you are with each other — so the voice front-end treats them the way you would.",
    "",
    "This is who-you-are material only — leave OUT technical details, implementation specifics,",
    "IDs, code, config, numbers, and fine-grained facts. The front-end delegates anything factual",
    "or substantive to the full agent, so it does not need those here.",
    "",
    "Write as direct second-person instructions to the voice front-end. Output ONLY the briefing text.",
  ].join("\n");
}

function buildTopicsInstruction(maxTokens: number): string {
  // Who the caller is and the relationship are already covered by the persona
  // briefing; this stage is only the recent substance of THIS conversation.
  return [
    `Write a recent-topics briefing of at most ~${maxTokens} tokens for your realtime voice`,
    "front-end, which is about to answer a live voice call from the caller in the conversation above.",
    "",
    "Cover the gist of what you two discussed most recently and any open threads worth continuing",
    "by voice. Leave OUT technical details, implementation specifics, IDs, code, config, numbers,",
    "and fine-grained facts — the front-end delegates anything substantive to the full agent.",
    "",
    "Finally, judge the dominant language of the conversation above and END the briefing with an",
    "explicit instruction telling the voice model which language to speak — e.g. if the history is",
    "mostly Chinese, instruct it to converse in Chinese; if English, English.",
    "",
    "Write as direct second-person instructions to the voice front-end. Output ONLY the briefing text.",
  ].join("\n");
}

// Minimal transcript formatter: session events are opaque (SessionTranscriptEvent
// is unknown), so narrow defensively to visible user/assistant message text.
// Tool calls/results are message-typed with other roles or no text and drop out.
export function formatTranscriptForBrief(
  events: readonly unknown[],
  opts?: { maxMessages?: number },
): string {
  const lines: string[] = [];
  for (const event of events) {
    const entry = asRecord(event);
    if (!entry || entry.type !== "message" || entry.appendMode === "side") {
      continue;
    }
    const message = asRecord(entry.message);
    const role = message?.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = extractContentText(message?.content);
    if (!text) {
      continue;
    }
    lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  const recent = opts?.maxMessages !== undefined ? lines.slice(-opts.maxMessages) : lines;
  return recent.join("\n").trim();
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const record = asRecord(part);
        return typeof record?.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
