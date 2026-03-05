import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSession } from "@mariozechner/pi-coding-agent";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { getApiKeyForModel } from "../agents/model-auth.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { ensureSessionSummariesSchema } from "./session-summary-schema.js";

const log = createSubsystemLogger("session-summary");

const SUMMARY_SYSTEM_PROMPT = `You are summarizing a conversation session between a user and their AI assistant.

Write a summary that would help the assistant quickly catch up if they lost all memory of this session. Cover:
- What topics were discussed
- What decisions were made
- What's unresolved or needs follow-up
- The emotional tone and relationship dynamics
- Key details: names, file paths, numbers, dates, error messages, commits

Write naturally, like a detailed journal entry. Use the same language as the conversation (if mostly Chinese, write in Chinese).

Target length based on session size:
- Short session (< 50 messages): 100-200 words
- Medium session (50-200 messages): 200-500 words
- Long session (200+ messages): 500-1000 words

Output plain text only. No JSON, no markdown headers, no structured format.`;

const SLICE_SUMMARY_PROMPT_TEMPLATE = `You are summarizing PART {N} of {M} of a conversation session.
This part covers messages {startIdx}-{endIdx} of {totalMessages} total messages.

Write a summary that would help the assistant quickly catch up on what happened in this portion. Cover:
- What topics were discussed
- What decisions were made
- What's unresolved or needs follow-up
- The emotional tone and relationship dynamics
- Key details: names, file paths, numbers, dates, error messages, commits

Write naturally, like a detailed journal entry. Use the same language as the conversation (if mostly Chinese, write in Chinese).

Since this is only a portion of the session, focus on what happened in this specific part.
Aim for 200-400 words.

Output plain text only. No JSON, no markdown headers, no structured format.`;

// ~60k tokens per slice (chars / 3.5 ≈ tokens)
const MAX_CHARS_PER_SLICE = 210_000;
// Sessions under this threshold get single-pass summary
const SINGLE_PASS_MAX_CHARS = 280_000;
// Minimum messages to generate a summary
const MIN_MESSAGES = 3;
// Max chars per individual message
const MAX_MESSAGE_CHARS = 4000;

export interface SessionSummaryRecord {
  session_id: string;
  previous_session_id: string | null;
  session_key: string;
  agent_id: string;
  created_at: number;
  ended_at: number;
  message_count: number;
  summary: string;
  model: string | null;
  summary_model: string | null;
  generated_at: number;
}

function resolveMemoryDbPath(agentId: string): string {
  const stateDir = resolveStateDir(process.env, os.homedir);
  return path.join(stateDir, "memory", `${agentId}.sqlite`);
}

function openSummaryDb(agentId: string) {
  const dbPath = resolveMemoryDbPath(agentId);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);
  ensureSessionSummariesSchema(db);
  return db;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  index: number;
}

export interface ExtractedTranscript {
  messages: TranscriptMessage[];
  messageCount: number;
  totalChars: number;
  sessionMeta?: { createdAt?: number };
}

/**
 * Extract full transcript from a session JSONL file.
 * Reads ALL user/assistant messages, ignoring compaction entries and tool calls.
 */
export function extractFullTranscript(sessionFilePath: string): ExtractedTranscript {
  if (!fs.existsSync(sessionFilePath)) {
    return { messages: [], messageCount: 0, totalChars: 0 };
  }
  const raw = fs.readFileSync(sessionFilePath, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  const messages: TranscriptMessage[] = [];
  let totalChars = 0;
  let sessionMeta: { createdAt?: number } | undefined;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "session") {
      sessionMeta = entry as unknown as { createdAt?: number };
      continue;
    }

    // Skip compaction entries entirely — we read all messages from the JSONL
    if (entry.type === "compaction") {
      continue;
    }

    if (entry.type !== "message") {
      continue;
    }

    const msg = entry.message as { role?: string; content?: unknown } | undefined;
    if (!msg || !msg.role || !["user", "assistant"].includes(msg.role)) {
      continue;
    }

    // Skip tool calls and tool results (messages that contain ONLY tool content)
    if (Array.isArray(msg.content)) {
      const hasOnlyToolContent = (msg.content as Array<{ type?: string }>).every(
        (block) =>
          block.type === "tool_use" || block.type === "tool_result" || block.type === "tool_call",
      );
      if (hasOnlyToolContent && msg.content.length > 0) {
        continue;
      }
    }

    const text = extractTextFromContent(msg.content);
    if (!text.trim()) {
      continue;
    }

    const truncated =
      text.length > MAX_MESSAGE_CHARS
        ? text.slice(0, MAX_MESSAGE_CHARS) + "\n...[truncated]"
        : text;
    messages.push({
      role: msg.role as "user" | "assistant",
      text: truncated,
      index: messages.length,
    });
    totalChars += truncated.length;
  }

  return { messages, messageCount: messages.length, totalChars, sessionMeta };
}

/**
 * Slice messages into chunks that fit within maxCharsPerSlice.
 * Cuts at message boundaries only.
 */
export function sliceMessages(
  messages: TranscriptMessage[],
  maxCharsPerSlice: number = MAX_CHARS_PER_SLICE,
): TranscriptMessage[][] {
  if (messages.length === 0) {
    return [];
  }

  const slices: TranscriptMessage[][] = [];
  let currentSlice: TranscriptMessage[] = [];
  let currentChars = 0;

  for (const msg of messages) {
    if (currentChars + msg.text.length > maxCharsPerSlice && currentSlice.length > 0) {
      slices.push(currentSlice);
      currentSlice = [];
      currentChars = 0;
    }
    currentSlice.push(msg);
    currentChars += msg.text.length;
  }

  if (currentSlice.length > 0) {
    slices.push(currentSlice);
  }

  return slices;
}

function formatMessagesForLlm(messages: TranscriptMessage[]): string {
  const transcript = messages.map((m) => `[${m.role}]: ${m.text}`).join("\n\n");
  return `Here is the full conversation transcript to summarize:\n\n---BEGIN TRANSCRIPT---\n${transcript}\n---END TRANSCRIPT---\n\nNow write a summary of the above conversation.`;
}

async function callLlm(
  systemPrompt: string,
  userContent: string,
  config: OpenClawConfig | undefined,
): Promise<{ text: string; modelLabel: string }> {
  const cfgAny = config as unknown as { agents?: { session?: { summaryModel?: string } } };
  const summaryModelRef = cfgAny?.agents?.session?.summaryModel ?? "anthropic/claude-sonnet-4-6";
  const slashIdx = summaryModelRef.indexOf("/");
  const provider = slashIdx > 0 ? summaryModelRef.slice(0, slashIdx) : "anthropic";
  const modelId = slashIdx > 0 ? summaryModelRef.slice(slashIdx + 1) : summaryModelRef;
  const modelLabel = `${provider}/${modelId}`;

  const agentDir = resolveOpenClawAgentDir();

  log.info(`Resolving model ${modelLabel}...`);
  const { model, authStorage, modelRegistry, error } = resolveModel(
    provider,
    modelId,
    agentDir,
    config,
  );
  if (!model) {
    throw new Error(`Cannot resolve summary model ${modelLabel}: ${error}`);
  }

  log.info(`Getting API key for ${modelLabel}...`);
  const apiKeyInfo = await getApiKeyForModel({
    model,
    cfg: config,
    agentDir,
  });
  if (apiKeyInfo.apiKey) {
    authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
  } else {
    log.error(`No API key found for provider ${model.provider}`);
    throw new Error(`No API key available for provider ${model.provider}`);
  }

  log.info(`Creating agent session for summary generation...`);
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir,
    authStorage,
    modelRegistry,
    model,
    tools: [],
    customTools: [],
  });
  session.agent.setSystemPrompt(systemPrompt);

  try {
    log.info(`Sending prompt to LLM (${userContent.length} chars input)...`);
    await session.prompt(userContent);

    const messages = session.messages;
    const lastMsg = messages[messages.length - 1];
    const lastMsgAny = lastMsg as unknown as { content?: unknown } | undefined;
    const responseText =
      typeof lastMsgAny?.content === "string"
        ? lastMsgAny.content
        : extractTextFromContent(lastMsgAny?.content);

    if (!responseText.trim()) {
      throw new Error("LLM returned empty response");
    }

    return { text: responseText.trim(), modelLabel };
  } finally {
    session.dispose();
  }
}

// ---- Legacy interface (kept for backward compat with readTranscriptFromSessionFile callers) ----

export interface SessionTranscriptData {
  compactionSummaries: string[];
  recentTranscript: string;
  messageCount: number;
}

/**
 * @deprecated Use extractFullTranscript instead
 */
export function readTranscriptFromSessionFile(sessionFilePath: string): SessionTranscriptData {
  if (!fs.existsSync(sessionFilePath)) {
    return { compactionSummaries: [], recentTranscript: "", messageCount: 0 };
  }
  const raw = fs.readFileSync(sessionFilePath, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  const compactionSummaries: string[] = [];
  const recentMessages: string[] = [];
  let messageCount = 0;

  for (const line of lines) {
    let entry: { type?: string; summary?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "compaction" && entry.summary) {
      compactionSummaries.push(entry.summary);
      recentMessages.length = 0;
      continue;
    }

    if (entry.type !== "message") {
      continue;
    }
    const msg = entry.message;
    if (!msg || !msg.role || !["user", "assistant"].includes(msg.role)) {
      continue;
    }
    messageCount++;

    const text = extractTextFromContent(msg.content);
    if (!text.trim()) {
      continue;
    }

    const truncated = text.length > 2000 ? text.slice(0, 2000) + "...[truncated]" : text;
    recentMessages.push(`[${msg.role}]: ${truncated}`);
  }

  let recentTranscript = recentMessages.join("\n\n");
  if (recentTranscript.length > 30000) {
    recentTranscript = recentTranscript.slice(-30000);
  }

  return { compactionSummaries, recentTranscript, messageCount };
}

// ---- V2 unified entry point ----

/**
 * Generate a session summary from a session JSONL file path.
 * Handles transcript extraction, slicing for long sessions, LLM calls, and DB storage.
 */
export async function generateSessionSummary(params: {
  sessionFilePath: string;
  sessionId: string;
  previousSessionId?: string;
  sessionKey: string;
  agentId: string;
  config?: OpenClawConfig;
  createdAt: number;
  endedAt: number;
  model?: string;
}): Promise<void> {
  const { sessionFilePath, sessionId, agentId } = params;

  log.info(`Extracting transcript from ${sessionFilePath} for session ${sessionId}`);

  let transcript: ExtractedTranscript;
  try {
    transcript = extractFullTranscript(sessionFilePath);
  } catch (err) {
    log.error(`Failed to extract transcript for session ${sessionId}: ${String(err)}`);
    throw err;
  }

  log.info(
    `Session ${sessionId}: ${transcript.messageCount} messages, ${transcript.totalChars} chars`,
  );

  if (transcript.messageCount < MIN_MESSAGES) {
    log.info(
      `Skipping summary for session ${sessionId}: only ${transcript.messageCount} messages (min: ${MIN_MESSAGES})`,
    );
    return;
  }

  if (transcript.totalChars < 500) {
    log.info(
      `Skipping summary for session ${sessionId}: too short (${transcript.totalChars} chars)`,
    );
    return;
  }

  let summaryText: string;
  let modelLabel: string;

  if (transcript.totalChars <= SINGLE_PASS_MAX_CHARS) {
    // Single-pass summary
    log.info(`Session ${sessionId}: single-pass summary (${transcript.totalChars} chars)`);
    const llmInput = formatMessagesForLlm(transcript.messages);
    const result = await callLlm(SUMMARY_SYSTEM_PROMPT, llmInput, params.config);
    summaryText = result.text;
    modelLabel = result.modelLabel;
  } else {
    // Multi-slice summary
    const slices = sliceMessages(transcript.messages, MAX_CHARS_PER_SLICE);
    log.info(
      `Session ${sessionId}: multi-slice summary (${slices.length} slices, ${transcript.totalChars} chars)`,
    );

    const summaryParts: string[] = [];
    modelLabel = "";

    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i];
      const startIdx = slice[0].index + 1;
      const endIdx = slice[slice.length - 1].index + 1;

      const slicePrompt = SLICE_SUMMARY_PROMPT_TEMPLATE.replace("{N}", String(i + 1))
        .replace("{M}", String(slices.length))
        .replace("{startIdx}", String(startIdx))
        .replace("{endIdx}", String(endIdx))
        .replace("{totalMessages}", String(transcript.messageCount));

      const llmInput = formatMessagesForLlm(slice);
      log.info(
        `Session ${sessionId}: processing slice ${i + 1}/${slices.length} (${llmInput.length} chars, messages ${startIdx}-${endIdx})`,
      );

      const result = await callLlm(slicePrompt, llmInput, params.config);
      summaryParts.push(result.text);
      modelLabel = result.modelLabel;
    }

    summaryText = summaryParts.join("\n\n---\n\n");
  }

  // Write to DB
  log.info(`Writing summary for session ${sessionId} to DB`);
  const db = openSummaryDb(agentId);
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO session_summaries
        (session_id, previous_session_id, session_key, agent_id, created_at, ended_at, message_count, summary, model, summary_model, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      params.sessionId,
      params.previousSessionId ?? null,
      params.sessionKey,
      agentId,
      params.createdAt,
      params.endedAt,
      transcript.messageCount,
      summaryText,
      params.model ?? null,
      modelLabel,
      Date.now(),
    );
    log.info(`Session summary saved for ${sessionId} (${summaryText.length} chars)`);
  } finally {
    db.close();
  }
}
