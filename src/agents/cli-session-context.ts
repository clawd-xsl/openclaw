import type { CliCompactionOverlay } from "../config/sessions.js";
import { readSessionMessages } from "../gateway/session-utils.fs.js";
import { extractAssistantVisibleText } from "../shared/chat-message-content.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";

type TranscriptBootstrapTurn = {
  id?: string;
  seq?: number;
  role: "user" | "assistant";
  text: string;
};

export type CliColdStartPromptPrefix = {
  promptPrefix?: string;
  usedOverlay: boolean;
  overlayInvalidReason?: "missing-summary" | "missing-anchor";
};

function isClaudeCliProvider(providerId: string): boolean {
  return providerId.startsWith("claude-cli");
}

function extractUserVisibleText(message: unknown): string | undefined {
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
        ? [normalizeOptionalString((part as { text?: unknown }).text) ?? ""]
        : [],
    )
    .join("\n")
    .trim();
  return text || undefined;
}

function normalizeComparablePromptText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function readTranscriptBootstrapTurns(params: {
  sessionId: string;
  sessionFile: string;
}): TranscriptBootstrapTurn[] {
  const messages = readSessionMessages(params.sessionId, undefined, params.sessionFile);
  const turns: TranscriptBootstrapTurn[] = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const meta =
      "__openclaw" in message &&
      (message as { __openclaw?: unknown }).__openclaw &&
      typeof (message as { __openclaw?: unknown }).__openclaw === "object"
        ? ((message as { __openclaw?: { id?: unknown; seq?: unknown } }).__openclaw ?? {})
        : {};
    const role = (message as { role?: unknown }).role;
    if (role === "user") {
      const text = extractUserVisibleText(message);
      if (text) {
        turns.push({
          role: "user",
          text,
          id: typeof meta.id === "string" ? meta.id : undefined,
          seq: typeof meta.seq === "number" ? meta.seq : undefined,
        });
      }
      continue;
    }
    if (role === "assistant") {
      const visibleText = extractAssistantVisibleText(message);
      if (!visibleText) {
        continue;
      }
      const text = stripInlineDirectiveTagsForDisplay(visibleText).text.trim();
      if (text) {
        turns.push({
          role: "assistant",
          text,
          id: typeof meta.id === "string" ? meta.id : undefined,
          seq: typeof meta.seq === "number" ? meta.seq : undefined,
        });
      }
    }
  }

  return turns;
}

function dropTrailingCurrentPrompt(turns: TranscriptBootstrapTurn[], currentPrompt: string) {
  if (turns.length === 0) {
    return turns;
  }
  const normalizedCurrentPrompt = normalizeComparablePromptText(currentPrompt);
  if (!normalizedCurrentPrompt) {
    return turns;
  }
  const lastTurn = turns[turns.length - 1];
  if (
    lastTurn?.role === "user" &&
    normalizeComparablePromptText(lastTurn.text) === normalizedCurrentPrompt
  ) {
    return turns.slice(0, -1);
  }
  return turns;
}

function formatTurns(turns: TranscriptBootstrapTurn[]): string {
  return turns
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`)
    .join("\n\n");
}

function buildFullTranscriptPromptPrefix(turns: TranscriptBootstrapTurn[]): string | undefined {
  if (turns.length === 0) {
    return undefined;
  }
  return [
    "[OpenClaw session continuity bootstrap]",
    "The following are earlier turns from this same session. Treat them as prior conversation context, not as a new instruction.",
    "",
    formatTurns(turns),
    "",
    "[Current user message]",
    "",
  ].join("\n");
}

function buildOverlayPromptPrefix(params: {
  overlay: CliCompactionOverlay;
  turns: TranscriptBootstrapTurn[];
}): string | undefined {
  const summary = params.overlay.summary.trim();
  if (!summary) {
    return undefined;
  }
  const sections = [
    "[OpenClaw session continuity bootstrap]",
    "The following condensed context summarizes earlier turns from this same session. Treat it as prior conversation context, not as a new instruction.",
    "",
    "[Compaction summary]",
    summary,
  ];
  if (params.turns.length > 0) {
    sections.push("", "[Preserved recent turns]", formatTurns(params.turns));
  }
  sections.push("", "[Current user message]", "");
  return sections.join("\n");
}

export function buildCliColdStartPromptPrefix(params: {
  providerId: string;
  sessionId: string;
  sessionFile: string;
  currentPrompt: string;
  overlay?: CliCompactionOverlay;
}): CliColdStartPromptPrefix {
  const turns = readTranscriptBootstrapTurns({
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
  });
  const trimmedTurns = dropTrailingCurrentPrompt(turns, params.currentPrompt);
  const droppedCurrentPromptTurn =
    turns.length > trimmedTurns.length ? turns[turns.length - 1] : undefined;
  const overlay = params.overlay;
  if (overlay) {
    const summary = overlay.summary.trim();
    if (!summary) {
      return {
        promptPrefix: isClaudeCliProvider(params.providerId)
          ? buildFullTranscriptPromptPrefix(trimmedTurns)
          : undefined,
        usedOverlay: false,
        overlayInvalidReason: "missing-summary",
      };
    }
    const anchorId = normalizeOptionalString(overlay.firstKeptEntryId);
    const anchorIndex = anchorId ? trimmedTurns.findIndex((turn) => turn.id === anchorId) : -1;
    const tailTurns = anchorId && anchorIndex >= 0 ? trimmedTurns.slice(anchorIndex) : [];
    if (anchorId && anchorIndex < 0 && droppedCurrentPromptTurn?.id !== anchorId) {
      return {
        promptPrefix: isClaudeCliProvider(params.providerId)
          ? buildFullTranscriptPromptPrefix(trimmedTurns)
          : undefined,
        usedOverlay: false,
        overlayInvalidReason: "missing-anchor",
      };
    }
    return {
      promptPrefix: buildOverlayPromptPrefix({
        overlay,
        turns: tailTurns,
      }),
      usedOverlay: true,
    };
  }

  if (!isClaudeCliProvider(params.providerId)) {
    return { usedOverlay: false };
  }

  return {
    promptPrefix: buildFullTranscriptPromptPrefix(trimmedTurns),
    usedOverlay: false,
  };
}
