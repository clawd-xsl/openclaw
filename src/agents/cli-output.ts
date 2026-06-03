import type { CliBackendConfig } from "../config/types.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import {
  sanitizeAssistantVisibleText,
  sanitizeAssistantVisibleTextWithOptions,
} from "../shared/text/assistant-visible-text.js";
import { isRecord } from "../utils.js";
import { extractAssistantText } from "./tools/chat-history-text.js";

export type CliUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type CliOutput = {
  text: string;
  payloads?: Array<{ text: string }>;
  rawText?: string;
  sessionId?: string;
  usage?: CliUsage;
  finalPromptText?: string;
  streamedAssistantTexts?: string[];
};

export type CliStreamingDelta = {
  text: string;
  delta: string;
  rawText?: string;
  sessionId?: string;
  usage?: CliUsage;
};

export type CliStreamingBoundary = {
  type: "assistant_message";
};

type CliStreamingUpdate = CliStreamingDelta | { rawText: string };
type CliStreamContentBlockTypes = Map<number, string>;

function isClaudeCliProvider(providerId: string): boolean {
  return normalizeLowercaseStringOrEmpty(providerId) === "claude-cli";
}

function usesClaudeStreamJsonDialect(params: {
  backend: CliBackendConfig;
  providerId: string;
}): boolean {
  return (
    params.backend.jsonlDialect === "claude-stream-json" || isClaudeCliProvider(params.providerId)
  );
}

function extractJsonObjectCandidates(raw: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      if (inString) {
        escaped = true;
      }
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(raw.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function parseJsonRecordCandidates(raw: string): Record<string, unknown>[] {
  const parsedRecords: Record<string, unknown>[] = [];
  const trimmed = raw.trim();
  if (!trimmed) {
    return parsedRecords;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      parsedRecords.push(parsed);
      return parsedRecords;
    }
  } catch {
    // Fall back to scanning for top-level JSON objects embedded in mixed output.
  }

  for (const candidate of extractJsonObjectCandidates(trimmed)) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) {
        parsedRecords.push(parsed);
      }
    } catch {
      // Ignore malformed fragments and keep scanning remaining objects.
    }
  }

  return parsedRecords;
}

function readNestedErrorMessage(parsed: Record<string, unknown>): string | undefined {
  if (isRecord(parsed.error)) {
    const errorMessage = readNestedErrorMessage(parsed.error);
    if (errorMessage) {
      return errorMessage;
    }
  }
  if (typeof parsed.message === "string") {
    const trimmed = parsed.message.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (typeof parsed.error === "string") {
    const trimmed = parsed.error.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function unwrapCliErrorText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  for (const parsed of parseJsonRecordCandidates(trimmed)) {
    const nested = readNestedErrorMessage(parsed);
    if (nested) {
      return nested;
    }
  }
  return trimmed;
}

function toCliUsage(raw: Record<string, unknown>): CliUsage | undefined {
  const readNestedCached = (key: "input_tokens_details" | "prompt_tokens_details") => {
    const nested = raw[key];
    if (!isRecord(nested)) {
      return undefined;
    }
    return typeof nested.cached_tokens === "number" && nested.cached_tokens > 0
      ? nested.cached_tokens
      : undefined;
  };
  const pick = (key: string) =>
    typeof raw[key] === "number" && raw[key] > 0 ? raw[key] : undefined;
  const totalInput = pick("input_tokens") ?? pick("inputTokens");
  const output = pick("output_tokens") ?? pick("outputTokens");
  const nestedCached =
    readNestedCached("input_tokens_details") ?? readNestedCached("prompt_tokens_details");
  const cacheRead =
    pick("cache_read_input_tokens") ??
    pick("cached_input_tokens") ??
    pick("cacheRead") ??
    pick("cached") ??
    nestedCached;
  const input =
    pick("input") ??
    ((Object.hasOwn(raw, "cached") || nestedCached !== undefined) && typeof totalInput === "number"
      ? Math.max(0, totalInput - (cacheRead ?? 0))
      : totalInput);
  const cacheWrite =
    pick("cache_creation_input_tokens") ?? pick("cache_write_input_tokens") ?? pick("cacheWrite");
  const total = pick("total_tokens") ?? pick("total");
  if (!input && !output && !cacheRead && !cacheWrite && !total) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, total };
}

function readCliUsage(parsed: Record<string, unknown>): CliUsage | undefined {
  if (isRecord(parsed.usage)) {
    const usage = toCliUsage(parsed.usage);
    if (usage) {
      return usage;
    }
  }
  if (isRecord(parsed.stats)) {
    return toCliUsage(parsed.stats);
  }
  return undefined;
}

function collectCliText(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectCliText(entry)).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.response === "string") {
    return value.response;
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.result === "string") {
    return value.result;
  }
  if (typeof value.content === "string") {
    return value.content;
  }
  if (Array.isArray(value.content)) {
    return value.content.map((entry) => collectCliText(entry)).join("");
  }
  if (isRecord(value.message)) {
    return collectCliText(value.message);
  }
  return "";
}

function collectExplicitCliErrorText(parsed: Record<string, unknown>): string {
  const nested = readNestedErrorMessage(parsed);
  if (nested) {
    return unwrapCliErrorText(nested);
  }

  if (parsed.is_error === true && typeof parsed.result === "string") {
    return unwrapCliErrorText(parsed.result);
  }

  if (parsed.type === "assistant") {
    const text = collectCliText(parsed.message);
    if (/^\s*API Error:/i.test(text)) {
      return unwrapCliErrorText(text);
    }
  }

  if (parsed.type === "error") {
    const text =
      collectCliText(parsed.message) ||
      collectCliText(parsed.content) ||
      collectCliText(parsed.result) ||
      collectCliText(parsed);
    return unwrapCliErrorText(text);
  }

  return "";
}

function collectCliAssistantVisibleContentText(message: Record<string, unknown>): string {
  if (typeof message.text === "string") {
    return message.text;
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .map((block) => {
      if (!isRecord(block)) {
        return "";
      }
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .join("");
}

export function normalizeCliAssistantVisibleText(text: unknown): string | undefined {
  const normalized = typeof text === "string" ? normalizeOptionalString(text) : undefined;
  if (!normalized) {
    return undefined;
  }
  return normalizeOptionalString(sanitizeAssistantVisibleText(normalized));
}

export function normalizeCliAssistantVisibleDelta(text: unknown): string | undefined {
  if (typeof text !== "string" || text.length === 0) {
    return undefined;
  }
  const sanitized = sanitizeAssistantVisibleTextWithOptions(text, { trim: "none" });
  return sanitized.length > 0 ? sanitized : undefined;
}

function pickCliSessionId(
  parsed: Record<string, unknown>,
  backend: CliBackendConfig,
): string | undefined {
  const fields = backend.sessionIdFields ?? [
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
  ];
  for (const field of fields) {
    const value = parsed[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function parseCliJson(raw: string, backend: CliBackendConfig): CliOutput | null {
  const parsedRecords = parseJsonRecordCandidates(raw);
  if (parsedRecords.length === 0) {
    return null;
  }

  let sessionId: string | undefined;
  let usage: CliUsage | undefined;
  let text = "";
  let sawStructuredOutput = false;
  for (const parsed of parsedRecords) {
    sessionId = pickCliSessionId(parsed, backend) ?? sessionId;
    usage = readCliUsage(parsed) ?? usage;
    const nextText =
      collectCliText(parsed.message) ||
      collectCliText(parsed.content) ||
      collectCliText(parsed.result) ||
      collectCliText(parsed.response) ||
      collectCliText(parsed);
    const trimmedText = normalizeCliAssistantVisibleText(nextText);
    if (trimmedText) {
      text = trimmedText;
      sawStructuredOutput = true;
      continue;
    }
    if (sessionId || usage) {
      sawStructuredOutput = true;
    }
  }

  if (!text && !sawStructuredOutput) {
    return null;
  }
  return { text, sessionId, usage };
}

function parseClaudeCliJsonlResult(params: {
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
  sessionId?: string;
  usage?: CliUsage;
}): CliOutput | null {
  if (!usesClaudeStreamJsonDialect(params)) {
    return null;
  }
  if (
    typeof params.parsed.type === "string" &&
    params.parsed.type === "result" &&
    typeof params.parsed.result === "string"
  ) {
    const resultText = normalizeCliAssistantVisibleText(params.parsed.result);
    if (resultText) {
      return { text: resultText, sessionId: params.sessionId, usage: params.usage };
    }
    // Claude may finish with an empty result after tool-only work. Keep the
    // resolved session handle and usage instead of dropping them.
    return { text: "", sessionId: params.sessionId, usage: params.usage };
  }
  return null;
}

function readCliAssistantMessageText(parsed: Record<string, unknown>): string | undefined {
  if (parsed.type !== "assistant" || !isRecord(parsed.message)) {
    return undefined;
  }
  const message = parsed.message;
  if (collectExplicitCliErrorText(parsed)) {
    return undefined;
  }
  return normalizeCliAssistantVisibleText(
    collectCliAssistantVisibleContentText(message) || extractAssistantText(message),
  );
}

function readClaudeStreamEventIndex(event: Record<string, unknown>): number | undefined {
  return typeof event.index === "number" && Number.isInteger(event.index) && event.index >= 0
    ? event.index
    : undefined;
}

function readClaudeContentBlockType(block: unknown): string | undefined {
  if (!isRecord(block) || typeof block.type !== "string") {
    return undefined;
  }
  const normalized = normalizeOptionalString(block.type);
  return normalized;
}

function readCliStreamingBoundary(params: {
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
}): CliStreamingBoundary | undefined {
  if (!usesClaudeStreamJsonDialect(params)) {
    return undefined;
  }
  if (params.parsed.type !== "assistant" || !isRecord(params.parsed.message)) {
    return undefined;
  }
  if (normalizeCliAssistantVisibleText(readCliAssistantMessageText(params.parsed))) {
    return { type: "assistant_message" };
  }
  return undefined;
}

function buildCliStreamingDeltaFromNextText(params: {
  nextText: string | undefined;
  textSoFar: string;
  sessionId?: string;
  usage?: CliUsage;
}): CliStreamingDelta | null {
  const nextText = normalizeCliAssistantVisibleText(params.nextText);
  if (!nextText) {
    return null;
  }
  if (nextText === params.textSoFar) {
    return null;
  }
  if (!nextText.startsWith(params.textSoFar)) {
    return null;
  }
  const delta = nextText.slice(params.textSoFar.length);
  if (!delta) {
    return null;
  }
  return {
    text: nextText,
    delta,
    sessionId: params.sessionId,
    usage: params.usage,
  };
}

function appendCliPayloadText(texts: string[], nextText: string | undefined): void {
  const trimmed = normalizeOptionalString(nextText);
  if (!trimmed) {
    return;
  }
  const last = texts[texts.length - 1];
  if (!last) {
    texts.push(trimmed);
    return;
  }
  if (last === trimmed) {
    return;
  }
  // Claude stream-json may emit a growing snapshot of the same assistant
  // message before the message is finalized. Replace the last payload when the
  // next snapshot is a strict extension instead of turning it into a second
  // outbound reply.
  if (trimmed.startsWith(last) && trimmed.length > last.length) {
    texts[texts.length - 1] = trimmed;
    return;
  }
  texts.push(trimmed);
}

function parseClaudeCliStreamingDelta(params: {
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
  rawTextSoFar: string;
  visibleTextSoFar: string;
  activeContentBlockTypes: CliStreamContentBlockTypes;
  sessionId?: string;
  usage?: CliUsage;
}): CliStreamingUpdate | null {
  if (!usesClaudeStreamJsonDialect(params)) {
    return null;
  }
  const snapshotDelta = buildCliStreamingDeltaFromNextText({
    nextText: readCliAssistantMessageText(params.parsed),
    textSoFar: params.visibleTextSoFar,
    sessionId: params.sessionId,
    usage: params.usage,
  });
  if (snapshotDelta) {
    return snapshotDelta;
  }
  if (params.parsed.type !== "stream_event" || !isRecord(params.parsed.event)) {
    return null;
  }
  const event = params.parsed.event;
  if (event.type === "message_start" || event.type === "message_stop") {
    params.activeContentBlockTypes.clear();
    return null;
  }
  const index = readClaudeStreamEventIndex(event);
  if (event.type === "content_block_start") {
    if (index !== undefined) {
      params.activeContentBlockTypes.set(
        index,
        readClaudeContentBlockType(event.content_block) ?? "unknown",
      );
    }
    if (
      isRecord(event.content_block) &&
      event.content_block.type === "text" &&
      typeof event.content_block.text === "string" &&
      event.content_block.text.length > 0
    ) {
      const nextRawText = `${params.rawTextSoFar}${event.content_block.text}`;
      const streamingDelta = buildCliStreamingDeltaFromNextText({
        nextText: nextRawText,
        textSoFar: params.visibleTextSoFar,
        sessionId: params.sessionId,
        usage: params.usage,
      });
      return streamingDelta
        ? { ...streamingDelta, rawText: nextRawText }
        : { rawText: nextRawText };
    }
    return null;
  }
  if (event.type === "content_block_stop") {
    if (index !== undefined) {
      params.activeContentBlockTypes.delete(index);
    }
    return null;
  }
  if (event.type !== "content_block_delta" || !isRecord(event.delta)) {
    return null;
  }
  const blockType = index === undefined ? undefined : params.activeContentBlockTypes.get(index);
  if (blockType && blockType !== "text") {
    return null;
  }
  if (blockType === undefined && params.activeContentBlockTypes.size > 0) {
    return null;
  }
  const delta = event.delta;
  if (delta.type !== "text_delta" || typeof delta.text !== "string") {
    return null;
  }
  if (!delta.text) {
    return null;
  }
  const nextRawText = `${params.rawTextSoFar}${delta.text}`;
  const streamingDelta = buildCliStreamingDeltaFromNextText({
    nextText: nextRawText,
    textSoFar: params.visibleTextSoFar,
    sessionId: params.sessionId,
    usage: params.usage,
  });
  return streamingDelta ? { ...streamingDelta, rawText: nextRawText } : { rawText: nextRawText };
}

export function createCliJsonlStreamingParser(params: {
  backend: CliBackendConfig;
  providerId: string;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  onAssistantBoundary?: (boundary: CliStreamingBoundary) => void;
}) {
  let lineBuffer = "";
  let assistantRawText = "";
  let assistantVisibleText = "";
  const activeContentBlockTypes: CliStreamContentBlockTypes = new Map();
  let sessionId: string | undefined;
  let usage: CliUsage | undefined;

  const handleParsedRecord = (parsed: Record<string, unknown>) => {
    sessionId = pickCliSessionId(parsed, params.backend) ?? sessionId;
    if (!sessionId && typeof parsed.thread_id === "string") {
      sessionId = parsed.thread_id.trim();
    }
    if (isRecord(parsed.usage)) {
      usage = toCliUsage(parsed.usage) ?? usage;
    }

    const boundary = readCliStreamingBoundary({
      backend: params.backend,
      providerId: params.providerId,
      parsed,
    });
    const update = parseClaudeCliStreamingDelta({
      backend: params.backend,
      providerId: params.providerId,
      parsed,
      rawTextSoFar: assistantRawText,
      visibleTextSoFar: assistantVisibleText,
      activeContentBlockTypes,
      sessionId,
      usage,
    });
    if (update) {
      if (!("delta" in update)) {
        assistantRawText = update.rawText;
      } else {
        assistantRawText = update.rawText ?? update.text;
        assistantVisibleText = update.text;
        params.onAssistantDelta({
          text: update.text,
          delta: update.delta,
          sessionId: update.sessionId,
          usage: update.usage,
        });
      }
    }
    if (boundary) {
      params.onAssistantBoundary?.(boundary);
    }
  };

  const flushLines = (flushPartial: boolean) => {
    while (true) {
      const newlineIndex = lineBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = lineBuffer.slice(0, newlineIndex).trim();
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      for (const parsed of parseJsonRecordCandidates(line)) {
        handleParsedRecord(parsed);
      }
    }
    if (!flushPartial) {
      return;
    }
    const tail = lineBuffer.trim();
    lineBuffer = "";
    if (!tail) {
      return;
    }
    for (const parsed of parseJsonRecordCandidates(tail)) {
      handleParsedRecord(parsed);
    }
  };

  return {
    push(chunk: string) {
      if (!chunk) {
        return;
      }
      lineBuffer += chunk;
      flushLines(false);
    },
    finish() {
      flushLines(true);
    },
  };
}

export function parseCliJsonl(
  raw: string,
  backend: CliBackendConfig,
  providerId: string,
): CliOutput | null {
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  let sessionId: string | undefined;
  let usage: CliUsage | undefined;
  let finalClaudeResult: CliOutput | null = null;
  const assistantPayloadTexts: string[] = [];
  const texts: string[] = [];
  for (const line of lines) {
    for (const parsed of parseJsonRecordCandidates(line)) {
      if (!sessionId) {
        sessionId = pickCliSessionId(parsed, backend);
      }
      if (!sessionId && typeof parsed.thread_id === "string") {
        sessionId = parsed.thread_id.trim();
      }
      usage = readCliUsage(parsed) ?? usage;

      const claudeResult = parseClaudeCliJsonlResult({
        backend,
        providerId,
        parsed,
        sessionId,
        usage,
      });
      if (claudeResult) {
        finalClaudeResult = claudeResult;
      }

      appendCliPayloadText(assistantPayloadTexts, readCliAssistantMessageText(parsed));

      if (finalClaudeResult) {
        continue;
      }

      const item = isRecord(parsed.item) ? parsed.item : null;
      if (item && typeof item.text === "string") {
        const type = normalizeLowercaseStringOrEmpty(item.type);
        const itemText = normalizeCliAssistantVisibleText(item.text);
        if (itemText && (!type || type.includes("message"))) {
          texts.push(itemText);
        }
      }
    }
  }
  if (assistantPayloadTexts.length > 0) {
    const text = assistantPayloadTexts[assistantPayloadTexts.length - 1] ?? "";
    return {
      text,
      payloads: assistantPayloadTexts.map((entry) => ({ text: entry })),
      sessionId,
      usage,
    };
  }
  if (finalClaudeResult) {
    if (finalClaudeResult.text) {
      finalClaudeResult.payloads = [{ text: finalClaudeResult.text }];
    }
    return finalClaudeResult;
  }
  const text = texts.join("\n").trim();
  if (!text) {
    return null;
  }
  return { text, payloads: [{ text }], sessionId, usage };
}

export function parseCliOutput(params: {
  raw: string;
  backend: CliBackendConfig;
  providerId: string;
  outputMode?: "json" | "jsonl" | "text";
  fallbackSessionId?: string;
}): CliOutput {
  const outputMode = params.outputMode ?? "text";
  if (outputMode === "text") {
    return { text: params.raw.trim(), sessionId: params.fallbackSessionId };
  }
  if (outputMode === "jsonl") {
    return (
      parseCliJsonl(params.raw, params.backend, params.providerId) ?? {
        text: params.raw.trim(),
        sessionId: params.fallbackSessionId,
      }
    );
  }
  return (
    parseCliJson(params.raw, params.backend) ?? {
      text: params.raw.trim(),
      sessionId: params.fallbackSessionId,
    }
  );
}

export function hasStructuredCliOutput(params: {
  raw: string;
  backend: CliBackendConfig;
  providerId: string;
  outputMode?: "json" | "jsonl" | "text";
}): boolean {
  const outputMode = params.outputMode ?? "text";
  if (outputMode === "jsonl") {
    return parseCliJsonl(params.raw, params.backend, params.providerId) !== null;
  }
  if (outputMode === "json") {
    return parseCliJson(params.raw, params.backend) !== null;
  }
  return false;
}

function truncateCliLogDetail(text: string, maxChars = 160): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars - 1)}…`;
}

export function summarizeCliOutputForLog(params: {
  raw: string;
  backend: CliBackendConfig;
  providerId: string;
  outputMode?: "json" | "jsonl" | "text";
  fallbackSessionId?: string;
}): string | null {
  const trimmed = params.raw.trim();
  if (!trimmed) {
    return null;
  }

  if (
    !hasStructuredCliOutput({
      raw: trimmed,
      backend: params.backend,
      providerId: params.providerId,
      outputMode: params.outputMode,
    })
  ) {
    return trimmed;
  }

  const parsed = parseCliOutput({
    raw: trimmed,
    backend: params.backend,
    providerId: params.providerId,
    outputMode: params.outputMode,
    fallbackSessionId: params.fallbackSessionId,
  });
  const detailParts: string[] = [];
  if (parsed.sessionId) {
    detailParts.push(`session=${parsed.sessionId}`);
  }
  if (parsed.payloads && parsed.payloads.length > 0) {
    detailParts.push(`payloads=${parsed.payloads.length}`);
  }
  if (parsed.text) {
    detailParts.push(`textChars=${parsed.text.length}`);
    detailParts.push(`text=${truncateCliLogDetail(parsed.text)}`);
  }
  const outputMode = params.outputMode ?? "text";
  const outputLabel = outputMode === "jsonl" ? "structured jsonl" : "structured json";
  return `<${outputLabel} output suppressed${detailParts.length > 0 ? ` (${detailParts.join(", ")})` : ""}>`;
}

export function extractCliErrorMessage(raw: string): string | null {
  const parsedRecords = parseJsonRecordCandidates(raw);
  if (parsedRecords.length === 0) {
    return null;
  }

  let errorText = "";
  for (const parsed of parsedRecords) {
    const next = collectExplicitCliErrorText(parsed);
    if (next) {
      errorText = next;
    }
  }

  return errorText || null;
}
