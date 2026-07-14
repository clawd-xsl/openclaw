// Pre-call context brief. Before the realtime front-end connects, compress the
// caller's whole session (its composed system prompt + all turns) into a bounded
// briefing and inject it into the realtime instructions so the otherwise
// context-blind front-end knows who it is and who is calling.
//
// It runs as a fully isolated one-shot embedded agent: a fresh randomUUID session
// on a throwaway session file (never the caller's session, no store entry, no
// pollution). The run's OWN system prompt supplies the agent persona; the caller's
// transcript is stuffed into the prompt. The compressor model is config-selected
// (contextBrief.model) — an anthropic/* ref is a lean API call, a claude-cli/* ref
// spawns a separate throwaway CLI process; either way it is isolated from the
// caller's warm process (distinct sessionId => distinct live-session key).
import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  collectRealtimeVoiceAgentConsultVisibleText,
  type RealtimeVoiceAgentConsultRuntime,
} from "openclaw/plugin-sdk/realtime-voice";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { readBoundedSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import type { SignalVoiceCallConfig } from "./config.js";

const log = createSubsystemLogger("signal/voice");

const DEFAULT_BRIEF_MAX_TOKENS = 1500;
const DEFAULT_BRIEF_TIMEOUT_MS = 4_000;
// Bound the compression INPUT so a long history cannot blow the compressor's
// context or the call-setup budget.
const BRIEF_TRANSCRIPT_MAX_BYTES = 256 * 1024;
const BRIEF_TRANSCRIPT_MAX_EVENTS = 400;

export type SignalVoiceContextBriefParams = {
  cfg: OpenClawConfig;
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  voiceConfig: SignalVoiceCallConfig;
  route: { agentId: string; sessionKey: string };
  peerAci: string;
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
  const { cfg, agentRuntime, route, peerAci } = params;
  const agentId = route.agentId;
  const maxTokens = brief.maxTokens ?? DEFAULT_BRIEF_MAX_TOKENS;
  const timeoutMs = brief.timeoutMs ?? DEFAULT_BRIEF_TIMEOUT_MS;

  // Best-effort caller history: a brand-new caller has none, and the run still
  // produces a persona-only briefing from its own composed system prompt.
  const transcriptText = await readCallerTranscriptText({ agentRuntime, cfg, agentId, route });

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
      prompt: transcriptText
        ? `Conversation so far:\n\n${transcriptText}\n\n---\nWrite the briefing now.`
        : "There is no prior conversation with this caller yet. Write the briefing now.",
      extraSystemPrompt: buildBriefInstruction(maxTokens),
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
      ...(brief.model ? { model: brief.model, modelFallbacksOverride: [] } : {}),
      ...(brief.provider ? { provider: brief.provider } : {}),
    });
    const text = collectRealtimeVoiceAgentConsultVisibleText(result.payloads ?? [])?.trim();
    if (!text) {
      // Fail-closed: an empty brief must not silently become "no context".
      throw new Error(
        result.meta?.aborted
          ? "context brief run aborted before producing a briefing"
          : "context brief run produced no briefing text",
      );
    }
    log.info(
      `signal voice: context brief ready peer=${peerAci} agent=${agentId} chars=${text.length}`,
    );
    return text;
  } finally {
    await workspace.cleanup();
  }
}

async function readCallerTranscriptText(params: {
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  cfg: OpenClawConfig;
  agentId: string;
  route: { agentId: string; sessionKey: string };
}): Promise<string> {
  const { agentRuntime, cfg, agentId, route } = params;
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
    maxBytes: BRIEF_TRANSCRIPT_MAX_BYTES,
    maxEvents: BRIEF_TRANSCRIPT_MAX_EVENTS,
  });
  return transcript.available ? formatTranscriptForBrief(transcript.events) : "";
}

function buildBriefInstruction(maxTokens: number): string {
  // Deliberately NOT a compaction/technical summary: this is a persona-forward
  // briefing for talking to a person on a live call.
  return [
    `Write a pre-call briefing of at most ~${maxTokens} tokens for your realtime voice front-end,`,
    "which is about to answer a live voice call and starts with none of your context.",
    "This is a briefing for talking to a person on the phone — NOT a technical summary or a compaction.",
    "",
    "Weight it like this:",
    "- MOST of the briefing is your PERSONA: your name, personality, how you talk, your tone and style,",
    "  how you address this caller, and how you should come across live. Make the voice model sound like you.",
    "- Then the caller and your relationship, plus the gist of what you two discussed most recently in this",
    "  session — the recent topics and any open threads worth continuing by voice.",
    "",
    "Leave OUT technical details, implementation specifics, IDs, code, config, numbers, and fine-grained facts.",
    "The front-end delegates anything factual or substantive to the full agent, so it does not need those here.",
    "",
    "Finally, judge the dominant language of the conversation and memory above, and END the briefing with an",
    "explicit instruction telling the voice model which language to speak — e.g. if the history is mostly",
    "Chinese, instruct it to converse in Chinese; if English, English.",
    "",
    "Write as direct second-person instructions to the voice front-end. Output ONLY the briefing text.",
  ].join("\n");
}

// Minimal transcript formatter: session events are opaque (SessionTranscriptEvent
// is unknown), so narrow defensively to visible user/assistant message text.
export function formatTranscriptForBrief(events: readonly unknown[]): string {
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
  return lines.join("\n").trim();
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
