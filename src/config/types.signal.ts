// Defines Signal channel configuration types.
import type { ReplyToMode } from "./types.base.js";
import type { CommonChannelMessagingConfig } from "./types.channel-messaging-common.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type SignalReactionNotificationMode = "off" | "own" | "all" | "allowlist";
export type SignalReactionLevel = "off" | "ack" | "minimal" | "extensive";
export type SignalApiMode = "auto" | "native" | "container";

export type SignalGroupConfig = {
  requireMention?: boolean;
  /** Emit internal message hooks for mention-skipped group messages. */
  ingest?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

/**
 * Signal 1:1 voice calling (opt-in). Front-end is a realtime voice model bridged
 * over a headless PulseAudio pair inside the host signal-ts transport; the brain
 * delegates to the main agent via the realtime-voice consult tool.
 */
export type SignalVoiceCallConfig = {
  /** Master switch. Default: false. */
  enabled?: boolean;
  /** ACIs/e164 allowed to reach the bot by call. "*" = open. Default: deny all. */
  allowFrom?: Array<string | number>;
  /** Realtime voice provider id (e.g. "openai"). */
  realtimeProvider?: string;
  model?: string;
  voice?: string;
  instructions?: string;
  greeting?: string;
  toolPolicy?: "none" | "safe-read-only" | "owner";
  consultPolicy?: "auto" | "always";
  /** true => TURN-relay only (hide the server IP from the peer). */
  hideIp?: boolean;
  maxCallDurationMs?: number;
  /**
   * Pre-call context brief, two-stage: a cached persona briefing (generated off
   * the call path from the agent's own composed system prompt; regenerated only
   * when the persona workspace files — SOUL/IDENTITY/USER/AGENTS/MEMORY.md —
   * change) plus a fast live compression of the caller's recent messages with a
   * spoken-language instruction. Both are injected into the realtime
   * instructions so the front-end knows who it is and who is calling without
   * delaying pickup.
   */
  contextBrief?: {
    /** Master switch. Default: false. */
    enabled?: boolean;
    /** Compressor model ref (e.g. "sonnet"). Falls back to the agent default when unset. */
    model?: string;
    provider?: string;
    /** Target size of the combined injected briefing. Default: 1500. */
    maxTokens?: number;
    /** Per-stage compressor timeout; exceeding it fails call setup (fail-closed). Default: 4000. */
    timeoutMs?: number;
  };
  /**
   * Provider-specific realtime voice config keyed by provider id (same shape as
   * `voicecall.realtime.providers`), e.g. Qwen's `workspaceId`/`baseUrl`/`wsUrl`
   * and `apiKey`. Merged under the selected provider's own config resolution;
   * `model`/`voice` above still win as per-call overrides.
   */
  providers?: Record<string, Record<string, unknown> | undefined>;
  /** Optional overrides for the PulseAudio helper binaries used by the transport. */
  pulse?: { pactlPath?: string; pacatPath?: string };
};

export type SignalAccountConfig = CommonChannelMessagingConfig & {
  /** Optional explicit E.164 account for signal-cli. */
  account?: string;
  /** Optional account UUID for signal-cli (used for loop protection). */
  accountUuid?: string;
  /** Signal transport. signal-ts is selected automatically when durable state is configured. */
  backend?: "signal-cli" | "signal-ts";
  /** Durable linked-device state used by the host-provided direct signal-ts transport. */
  signalTsStatePath?: string;
  /** Optional signal-cli config directory path (passed as --config). */
  configPath?: string;
  /** Optional full base URL for signal-cli HTTP daemon. */
  httpUrl?: string;
  /** HTTP host for signal-cli daemon (default 127.0.0.1). */
  httpHost?: string;
  /** HTTP port for signal-cli daemon (default 8080). */
  httpPort?: number;
  /** signal-cli binary path (default: signal-cli). */
  cliPath?: string;
  /** Auto-start signal-cli daemon (default: true if httpUrl not set). */
  autoStart?: boolean;
  /** Max time to wait for signal-cli daemon startup (ms, cap 120000). */
  startupTimeoutMs?: number;
  receiveMode?: "on-start" | "manual";
  ignoreAttachments?: boolean;
  ignoreStories?: boolean;
  sendReadReceipts?: boolean;
  /** OpenClaw-side target aliases keyed by friendly name. */
  aliases?: Record<string, string>;
  /** Per-group overrides keyed by Signal group id (or "*"). */
  groups?: Record<string, SignalGroupConfig>;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Controls whether outbound replies quote the inbound Signal message. */
  replyToMode?: ReplyToMode;
  /** Reaction notification mode (off|own|all|allowlist). Default: own. */
  reactionNotifications?: SignalReactionNotificationMode;
  /** Allowlist for reaction notifications when mode is allowlist. */
  reactionAllowlist?: Array<string | number>;
  /** Action toggles for message tool capabilities. */
  actions?: {
    /** Enable/disable sending reactions via message tool (default: true). */
    reactions?: boolean;
  };
  /**
   * Controls agent reaction behavior:
   * - "off": No reactions
   * - "ack": Only automatic ack reactions (👀 when processing)
   * - "minimal": Agent can react sparingly (default)
   * - "extensive": Agent can react liberally
   */
  reactionLevel?: SignalReactionLevel;
  /** Signal 1:1 voice calling (opt-in); inherited per-account like allowFrom. */
  voiceCall?: SignalVoiceCallConfig;
};

export type SignalConfig = {
  /**
   * Signal API mode (channel-global):
   * - "auto" (default): Auto-detect based on available endpoints
   * - "native": Use native signal-cli with JSON-RPC + SSE (/api/v1/rpc, /api/v1/events)
   * - "container": Use bbernhard/signal-cli-rest-api with REST + WebSocket (/v2/send, /v1/receive/{account}).
   *   Requires the container to run with MODE=json-rpc for real-time message receiving.
   */
  apiMode?: SignalApiMode;
  /** Optional per-account Signal configuration (multi-account). */
  accounts?: Record<string, SignalAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & SignalAccountConfig;
