import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import { getApiKeyForModel } from "../agents/model-auth.js";
import { ensureOpenClawModelsJson } from "../agents/models-config.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { resolveUserPath } from "../utils.js";
import { ensureSessionSummariesSchema } from "./session-summary-schema.js";

const log = createSubsystemLogger("session-summary");

export const DEFAULT_SESSION_SUMMARY_MODEL = "anthropic/claude-sonnet-4-6";
export const DEFAULT_SESSION_SUMMARY_DAYS = 7;
export const DEFAULT_SESSION_SUMMARY_MAX_CHARS = 8_000;

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

const MAX_CHARS_PER_SLICE = 210_000;
const SINGLE_PASS_MAX_CHARS = 280_000;
const MIN_MESSAGES = 3;
const MIN_TRANSCRIPT_CHARS = 500;
const MAX_MESSAGE_CHARS = 4_000;

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

export interface SessionTranscriptData {
  compactionSummaries: string[];
  recentTranscript: string;
  messageCount: number;
}

function resolvePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.trunc(value);
}

export function resolveSessionSummarySettings(config?: OpenClawConfig): {
  summaryModel: string;
  summaryDays: number;
  summaryMaxChars: number;
} {
  const sessionConfig = config?.agents?.session;
  const summaryModel =
    typeof sessionConfig?.summaryModel === "string" && sessionConfig.summaryModel.trim()
      ? sessionConfig.summaryModel.trim()
      : DEFAULT_SESSION_SUMMARY_MODEL;
  return {
    summaryModel,
    summaryDays: resolvePositiveInteger(sessionConfig?.summaryDays) ?? DEFAULT_SESSION_SUMMARY_DAYS,
    summaryMaxChars:
      resolvePositiveInteger(sessionConfig?.summaryMaxChars) ?? DEFAULT_SESSION_SUMMARY_MAX_CHARS,
  };
}

export function resolveSessionSummaryDbPath(agentId: string, config?: OpenClawConfig): string {
  const stateDir = resolveStateDir(process.env, os.homedir);
  const fallback = path.join(stateDir, "memory", `${agentId}.sqlite`);
  const agentMemoryPath = config && resolveAgentConfig(config, agentId)?.memorySearch?.store?.path;
  const defaultMemoryPath = config?.agents?.defaults?.memorySearch?.store?.path;
  const rawPath = agentMemoryPath ?? defaultMemoryPath;
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return fallback;
  }
  const withAgentToken = rawPath.includes("{agentId}")
    ? rawPath.replaceAll("{agentId}", agentId)
    : rawPath;
  return resolveUserPath(withAgentToken);
}

function openSummaryDb(agentId: string, config?: OpenClawConfig) {
  const dbPath = resolveSessionSummaryDbPath(agentId, config);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
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

function formatMessagesForLlm(messages: TranscriptMessage[]): string {
  const transcript = messages.map((message) => `[${message.role}]: ${message.text}`).join("\n\n");
  return [
    "Here is the full conversation transcript to summarize:",
    "",
    "---BEGIN TRANSCRIPT---",
    transcript,
    "---END TRANSCRIPT---",
    "",
    "Now write a summary of the above conversation.",
  ].join("\n");
}

function extractAssistantTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const role = "role" in message ? message.role : undefined;
  if (role !== "assistant") {
    return "";
  }
  const content = "content" in message ? message.content : undefined;
  return extractTextFromChatContent(content, { joinWith: "\n" }) ?? "";
}

function findLastAssistantResponseText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = extractAssistantTextFromMessage(messages[index]);
    if (text.trim()) {
      return text;
    }
  }
  return "";
}

async function callLlm(
  systemPrompt: string,
  userContent: string,
  config: OpenClawConfig | undefined,
): Promise<{ text: string; modelLabel: string }> {
  const { summaryModel } = resolveSessionSummarySettings(config);
  const slashIndex = summaryModel.indexOf("/");
  const provider = slashIndex > 0 ? summaryModel.slice(0, slashIndex) : "anthropic";
  const modelId = slashIndex > 0 ? summaryModel.slice(slashIndex + 1) : summaryModel;
  const modelLabel = `${provider}/${modelId}`;
  const agentDir = resolveOpenClawAgentDir();

  await ensureOpenClawModelsJson(config, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const { model, authStorage, modelRegistry, error } = resolveModel(
    provider,
    modelId,
    agentDir,
    config,
  );
  if (!model) {
    throw new Error(`Cannot resolve summary model ${modelLabel}: ${error ?? "unknown model"}`);
  }

  const apiKeyInfo = await getApiKeyForModel({
    model,
    cfg: config,
    agentDir,
  });
  if (apiKeyInfo.apiKey) {
    authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
  } else if (apiKeyInfo.mode !== "aws-sdk") {
    throw new Error(`No API key available for provider ${model.provider}`);
  }

  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir,
    authStorage,
    modelRegistry,
    model,
    tools: [],
    customTools: [],
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
  });

  try {
    await session.prompt(userContent);
    const responseText = findLastAssistantResponseText(session.messages);
    if (!responseText.trim()) {
      throw new Error("LLM returned empty response");
    }
    return { text: responseText.trim(), modelLabel };
  } finally {
    session.dispose();
  }
}

/**
 * Extract actual start/end timestamps from a JSONL session file.
 */
export function extractSessionTimestamps(sessionFilePath: string): {
  createdAt: number;
  endedAt: number;
} {
  if (!fs.existsSync(sessionFilePath)) {
    return { createdAt: 0, endedAt: Date.now() };
  }
  const raw = fs.readFileSync(sessionFilePath, "utf-8");
  const lines = raw.split("\n").filter(Boolean);

  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = entry.timestamp;
    const timestampMs =
      typeof timestamp === "number"
        ? timestamp
        : typeof timestamp === "string"
          ? new Date(timestamp).getTime()
          : NaN;
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
      continue;
    }
    if (firstTimestamp === null) {
      firstTimestamp = timestampMs;
    }
    lastTimestamp = timestampMs;
  }

  return {
    createdAt: firstTimestamp ?? 0,
    endedAt: lastTimestamp ?? Date.now(),
  };
}

/**
 * Extract the user/assistant transcript from a session JSONL file.
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
      sessionMeta = entry as { createdAt?: number };
      continue;
    }
    if (entry.type === "compaction" || entry.type !== "message") {
      continue;
    }

    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (!message || !message.role || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }

    if (Array.isArray(message.content)) {
      const hasOnlyToolContent = message.content.every((block) => {
        if (!block || typeof block !== "object") {
          return false;
        }
        const type = "type" in block ? block.type : undefined;
        return type === "tool_use" || type === "tool_result" || type === "tool_call";
      });
      if (hasOnlyToolContent && message.content.length > 0) {
        continue;
      }
    }

    const text = extractTextFromContent(message.content);
    if (!text.trim()) {
      continue;
    }

    const truncated =
      text.length > MAX_MESSAGE_CHARS
        ? `${text.slice(0, MAX_MESSAGE_CHARS)}\n...[truncated]`
        : text;
    messages.push({
      role: message.role,
      text: truncated,
      index: messages.length,
    });
    totalChars += truncated.length;
  }

  return { messages, messageCount: messages.length, totalChars, sessionMeta };
}

/**
 * Slice transcript messages into prompt-sized chunks.
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

  for (const message of messages) {
    if (currentChars + message.text.length > maxCharsPerSlice && currentSlice.length > 0) {
      slices.push(currentSlice);
      currentSlice = [];
      currentChars = 0;
    }
    currentSlice.push(message);
    currentChars += message.text.length;
  }

  if (currentSlice.length > 0) {
    slices.push(currentSlice);
  }

  return slices;
}

/**
 * @deprecated Prefer extractFullTranscript for new callers.
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

    const message = entry.message;
    if (!message || !message.role || !["user", "assistant"].includes(message.role)) {
      continue;
    }
    messageCount += 1;

    const text = extractTextFromContent(message.content);
    if (!text.trim()) {
      continue;
    }

    const truncated = text.length > 2_000 ? `${text.slice(0, 2_000)}...[truncated]` : text;
    recentMessages.push(`[${message.role}]: ${truncated}`);
  }

  let recentTranscript = recentMessages.join("\n\n");
  if (recentTranscript.length > 30_000) {
    recentTranscript = recentTranscript.slice(-30_000);
  }

  return { compactionSummaries, recentTranscript, messageCount };
}

/**
 * Generate and persist a summary for the given completed session.
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
  log.info(`Extracting transcript for session ${params.sessionId}`);
  const transcript = extractFullTranscript(params.sessionFilePath);
  log.info(
    `Session ${params.sessionId}: ${transcript.messageCount} messages, ${transcript.totalChars} chars`,
  );

  if (transcript.messageCount < MIN_MESSAGES) {
    log.info(
      `Skipping session summary for ${params.sessionId}: only ${transcript.messageCount} messages`,
    );
    return;
  }
  if (transcript.totalChars < MIN_TRANSCRIPT_CHARS) {
    log.info(
      `Skipping session summary for ${params.sessionId}: transcript too short (${transcript.totalChars} chars)`,
    );
    return;
  }

  let summaryText = "";
  let summaryModel = "";

  if (transcript.totalChars <= SINGLE_PASS_MAX_CHARS) {
    const llmInput = formatMessagesForLlm(transcript.messages);
    const result = await callLlm(SUMMARY_SYSTEM_PROMPT, llmInput, params.config);
    summaryText = result.text;
    summaryModel = result.modelLabel;
  } else {
    const slices = sliceMessages(transcript.messages, MAX_CHARS_PER_SLICE);
    const parts: string[] = [];
    for (let index = 0; index < slices.length; index += 1) {
      const slice = slices[index];
      const startIdx = slice[0]?.index ?? 0;
      const endIdx = slice[slice.length - 1]?.index ?? startIdx;
      const slicePrompt = SLICE_SUMMARY_PROMPT_TEMPLATE.replace("{N}", String(index + 1))
        .replace("{M}", String(slices.length))
        .replace("{startIdx}", String(startIdx + 1))
        .replace("{endIdx}", String(endIdx + 1))
        .replace("{totalMessages}", String(transcript.messageCount));
      const llmInput = formatMessagesForLlm(slice);
      const result = await callLlm(slicePrompt, llmInput, params.config);
      parts.push(result.text);
      summaryModel = result.modelLabel;
    }
    summaryText = parts.join("\n\n---\n\n");
  }

  const db = openSummaryDb(params.agentId, params.config);
  try {
    db.prepare(`
      INSERT OR REPLACE INTO session_summaries (
        session_id,
        previous_session_id,
        session_key,
        agent_id,
        created_at,
        ended_at,
        message_count,
        summary,
        model,
        summary_model,
        generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.sessionId,
      params.previousSessionId ?? null,
      params.sessionKey,
      params.agentId,
      params.createdAt,
      params.endedAt,
      transcript.messageCount,
      summaryText,
      params.model ?? null,
      summaryModel || null,
      Date.now(),
    );
  } finally {
    db.close();
  }
}
