/**
 * Shared Claude CLI constants. These identify the synthetic backend, default
 * model refs, aliases, and session-id fields used across runtime and setup.
 */
/** Synthetic provider/backend id for Claude Code CLI-backed Anthropic models. */
export const CLAUDE_CLI_BACKEND_ID = "claude-cli";
/** Canonical model id for Claude Fable 5 when routed through Claude Code. */
export const CLAUDE_CLI_FABLE_MODEL_ID = "claude-fable-5";
/** Default Claude CLI model ref for agent defaults and live tests. */
export const CLAUDE_CLI_DEFAULT_MODEL_REF = `${CLAUDE_CLI_BACKEND_ID}/claude-opus-4-8`;
/** Default Claude CLI models allowed when setup seeds the model allowlist. */
export const CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS = [
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  `${CLAUDE_CLI_BACKEND_ID}/${CLAUDE_CLI_FABLE_MODEL_ID}`,
  `${CLAUDE_CLI_BACKEND_ID}/${CLAUDE_CLI_FABLE_MODEL_ID}[1m]`,
  `${CLAUDE_CLI_BACKEND_ID}/claude-opus-4-8[1m]`,
  `${CLAUDE_CLI_BACKEND_ID}/claude-opus-4-7`,
  `${CLAUDE_CLI_BACKEND_ID}/claude-sonnet-4-6`,
  `${CLAUDE_CLI_BACKEND_ID}/claude-opus-4-6`,
] as const;

/** User-facing Claude CLI model aliases normalized before execution. */
export const CLAUDE_CLI_MODEL_ALIASES: Record<string, string> = {
  fable: "fable",
  "fable-5": "fable",
  "fable[1m]": "fable[1m]",
  "claude-fable-5": "fable",
  "claude-fable-5[1m]": "fable[1m]",
  opus: "opus",
  "opus-4.8": "claude-opus-4-8",
  "opus-4.8[1m]": "claude-opus-4-8[1m]",
  "opus-4.8-1m": "claude-opus-4-8[1m]",
  "opus-4.7": "claude-opus-4-7",
  "opus-4.6": "claude-opus-4-6[1m]",
  "opus-4.6[1m]": "claude-opus-4-6[1m]",
  "opus-4.6-1m": "claude-opus-4-6[1m]",
  "claude-opus-4-8": "claude-opus-4-8",
  "claude-opus-4-8[1m]": "claude-opus-4-8[1m]",
  "claude-opus-4-7": "claude-opus-4-7",
  "claude-opus-4-6": "claude-opus-4-6[1m]",
  "claude-opus-4-6[1m]": "claude-opus-4-6[1m]",
  sonnet: "sonnet",
  "sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  haiku: "haiku",
};

/** JSONL fields that may contain Claude CLI session ids. */
export const CLAUDE_CLI_SESSION_ID_FIELDS = [
  "session_id",
  "sessionId",
  "conversation_id",
  "conversationId",
] as const;
