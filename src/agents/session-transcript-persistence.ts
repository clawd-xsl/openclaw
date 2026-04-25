import fs from "node:fs/promises";
import type { Api, AssistantMessage, Usage } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { prepareSessionManagerForRun } from "./pi-embedded-runner/session-manager-init.js";

export type PersistedTranscriptUsage = Usage;

type PersistedTranscriptStopReason = AssistantMessage["stopReason"];

const ZERO_TRANSCRIPT_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function normalizeTranscriptStopReason(
  raw: string | undefined,
  hasError: boolean,
): PersistedTranscriptStopReason {
  switch (raw) {
    case "stop":
    case "error":
    case "toolUse":
    case "length":
      return raw;
    default:
      return hasError ? "error" : "stop";
  }
}

export async function persistSessionTurnTranscript(params: {
  promptText?: string;
  replyText?: string;
  errorMessage?: string;
  sessionId: string;
  sessionFile: string;
  sessionCwd: string;
  api?: Api;
  provider?: string;
  model?: string;
  usage?: PersistedTranscriptUsage;
  stopReason?: string;
}): Promise<void> {
  const promptText =
    typeof params.promptText === "string" && params.promptText.trim()
      ? params.promptText
      : undefined;
  const replyText = normalizeOptionalString(params.replyText);
  const errorMessage = normalizeOptionalString(params.errorMessage);
  if (!promptText && !replyText && !errorMessage) {
    return;
  }

  const hadSessionFile = await fs
    .access(params.sessionFile)
    .then(() => true)
    .catch(() => false);
  const sessionManager = SessionManager.open(params.sessionFile);
  await prepareSessionManagerForRun({
    sessionManager,
    sessionFile: params.sessionFile,
    hadSessionFile,
    sessionId: params.sessionId,
    cwd: params.sessionCwd,
  });

  if (promptText) {
    sessionManager.appendMessage({
      role: "user",
      content: promptText,
      timestamp: Date.now(),
    });
  }

  if (replyText || errorMessage) {
    sessionManager.appendMessage({
      role: "assistant",
      content: replyText ? [{ type: "text", text: replyText }] : [],
      api: params.api ?? "openclaw-transcript",
      provider: params.provider ?? "openclaw",
      model: params.model ?? "unknown",
      usage: params.usage ?? ZERO_TRANSCRIPT_USAGE,
      stopReason: normalizeTranscriptStopReason(params.stopReason, Boolean(errorMessage)),
      timestamp: Date.now(),
      ...(errorMessage ? { errorMessage } : {}),
    });
  }

  emitSessionTranscriptUpdate(params.sessionFile);
}
