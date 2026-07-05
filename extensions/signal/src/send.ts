// Signal plugin module implements send behavior.
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptPartKind,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { resolveOutboundAttachmentFromUrl } from "openclaw/plugin-sdk/media-runtime";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSignalAccount, resolveSignalBackend } from "./accounts.js";
import { signalRpcRequest } from "./client-adapter.js";
import { markdownToSignalText, type SignalTextStyleRange } from "./format.js";
import { resolveSignalRpcContext } from "./rpc-context.js";

export type SignalSendOpts = {
  cfg: OpenClawConfig;
  baseUrl?: string;
  account?: string;
  accountId?: string;
  mediaUrl?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  maxBytes?: number;
  timeoutMs?: number;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  textMode?: "markdown" | "plain";
  textStyles?: SignalTextStyleRange[];
  replyToId?: string;
  quoteAuthor?: string;
};

export type SignalSendResult = {
  messageId: string;
  timestamp?: number;
  receipt: MessageReceipt;
};

export type SignalRpcOpts = Pick<
  SignalSendOpts,
  "cfg" | "baseUrl" | "account" | "accountId" | "timeoutMs" | "runtime" | "abortSignal"
>;

export type SignalReceiptType = "read" | "viewed";

type SignalTarget =
  | { type: "recipient"; recipient: string }
  | { type: "group"; groupId: string }
  | { type: "username"; username: string };

let signalTsRuntimePromise: Promise<typeof import("./signal-ts-runtime.js")> | undefined;

async function loadSignalTsRuntime() {
  signalTsRuntimePromise ??= import("./signal-ts-runtime.js");
  return await signalTsRuntimePromise;
}

async function resolveSignalRpcAccountInfo(opts: SignalRpcOpts) {
  if (opts.baseUrl?.trim() && opts.account?.trim() && !opts.accountId?.trim()) {
    return undefined;
  }
  if (!opts.cfg) {
    throw new Error(
      "Signal RPC account resolution requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
    );
  }
  const cfg = requireRuntimeConfig(opts.cfg, "Signal RPC account resolution");
  return resolveSignalAccount({
    cfg,
    accountId: opts.accountId,
  });
}

function parseTarget(raw: string): SignalTarget {
  let value = raw.trim();
  if (!value) {
    throw new Error("Signal recipient is required");
  }
  const lower = normalizeLowercaseStringOrEmpty(value);
  if (lower.startsWith("signal:")) {
    value = value.slice("signal:".length).trim();
  }
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (normalized.startsWith("group:")) {
    return { type: "group", groupId: value.slice("group:".length).trim() };
  }
  if (normalized.startsWith("username:")) {
    return {
      type: "username",
      username: value.slice("username:".length).trim(),
    };
  }
  if (normalized.startsWith("u:")) {
    return { type: "username", username: value.trim() };
  }
  return { type: "recipient", recipient: value };
}

type SignalTargetParams = {
  recipient?: string[];
  groupId?: string;
  username?: string[];
};

type SignalTargetAllowlist = {
  recipient?: boolean;
  group?: boolean;
  username?: boolean;
};

function buildTargetParams(
  target: SignalTarget,
  allow: SignalTargetAllowlist,
): SignalTargetParams | null {
  if (target.type === "recipient") {
    if (!allow.recipient) {
      return null;
    }
    return { recipient: [target.recipient] };
  }
  if (target.type === "group") {
    if (!allow.group) {
      return null;
    }
    return { groupId: target.groupId };
  }
  if (target.type === "username") {
    if (!allow.username) {
      return null;
    }
    return { username: [target.username] };
  }
  return null;
}

function createSignalSendReceipt(params: {
  messageId: string;
  timestamp?: number;
  target: SignalTarget;
  kind: MessageReceiptPartKind;
  replyToId?: string;
}): MessageReceipt {
  const messageId = params.messageId.trim();
  const results: MessageReceiptSourceResult[] =
    messageId && messageId !== "unknown"
      ? [
          {
            channel: "signal",
            messageId,
            meta: {
              targetType: params.target.type,
            },
          },
        ]
      : [];
  if (results[0]) {
    if (params.timestamp != null) {
      results[0].timestamp = params.timestamp;
    }
    if (params.target.type === "group") {
      results[0].chatId = params.target.groupId;
    } else if (params.target.type === "recipient") {
      results[0].toJid = params.target.recipient;
    } else {
      results[0].toJid = params.target.username;
    }
  }
  return createMessageReceiptFromOutboundResults({
    results,
    kind: params.kind,
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
  });
}

function resolveSignalQuote(params: {
  target: SignalTarget;
  replyToId?: string;
  quoteAuthor?: string;
}): { quoteTimestamp: number; quoteAuthor?: string } | null {
  const quoteTimestamp = parseStrictNonNegativeInteger(params.replyToId);
  if (quoteTimestamp === undefined || quoteTimestamp <= 0) {
    return null;
  }
  const explicitAuthor = params.quoteAuthor?.replace(/^signal:/i, "").trim();
  const quoteAuthor =
    explicitAuthor || (params.target.type === "recipient" ? params.target.recipient : undefined);
  return {
    quoteTimestamp,
    ...(quoteAuthor ? { quoteAuthor } : {}),
  };
}

// Signal sticker specs are action input. Keep the accepted representation bounded
// while leaving ample headroom for signal-cli pack identifiers.
const MAX_SIGNAL_STICKER_SPEC_LENGTH = 256;
const MAX_SIGNAL_STICKER_PACK_ID_LENGTH = 128;

function normalizeSignalStickerSpec(raw: string): string {
  const sticker = raw.trim();
  if (sticker.length > MAX_SIGNAL_STICKER_SPEC_LENGTH) {
    throw new Error(
      `Signal sticker id must be at most ${MAX_SIGNAL_STICKER_SPEC_LENGTH} characters`,
    );
  }
  const match = /^([0-9a-f]+):(\d+)$/i.exec(sticker);
  if (!match) {
    throw new Error("Signal sticker id must use packId:stickerId format");
  }
  const packId = match[1].toLowerCase();
  if (packId.length > MAX_SIGNAL_STICKER_PACK_ID_LENGTH) {
    throw new Error(
      `Signal sticker pack id must be at most ${MAX_SIGNAL_STICKER_PACK_ID_LENGTH} hex characters`,
    );
  }
  if (packId.length % 2 !== 0) {
    throw new Error("Signal sticker pack id must be even-length hex");
  }
  const stickerId = Number(match[2]);
  if (!Number.isSafeInteger(stickerId) || stickerId < 0) {
    throw new Error("Signal sticker id must be a non-negative integer");
  }
  return `${packId}:${stickerId}`;
}

export async function sendMessageSignal(
  to: string,
  text: string,
  opts: SignalSendOpts,
): Promise<SignalSendResult> {
  opts.abortSignal?.throwIfAborted();
  const cfg = requireRuntimeConfig(opts.cfg, "Signal send");
  const apiMode = cfg.channels?.signal?.apiMode;
  const accountInfo = resolveSignalAccount({
    cfg,
    accountId: opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const target = parseTarget(to);
  let message = text ?? "";
  let messageFromPlaceholder = false;
  let textStyles: SignalTextStyleRange[] = [];
  const textMode = opts.textMode ?? "markdown";
  const maxBytes = (() => {
    if (typeof opts.maxBytes === "number") {
      return opts.maxBytes;
    }
    if (typeof accountInfo.config.mediaMaxMb === "number") {
      return accountInfo.config.mediaMaxMb * 1024 * 1024;
    }
    if (typeof cfg.agents?.defaults?.mediaMaxMb === "number") {
      return cfg.agents.defaults.mediaMaxMb * 1024 * 1024;
    }
    return 8 * 1024 * 1024;
  })();

  let attachments: string[] | undefined;
  let signalTsAttachments:
    | Array<{
        path: string;
        contentType?: string;
        fileName?: string;
      }>
    | undefined;
  if (opts.mediaUrl?.trim()) {
    const resolved = await resolveOutboundAttachmentFromUrl(opts.mediaUrl.trim(), maxBytes, {
      mediaAccess: opts.mediaAccess,
      localRoots: opts.mediaLocalRoots,
      readFile: opts.mediaReadFile,
    });
    opts.abortSignal?.throwIfAborted();
    attachments = [resolved.path];
    signalTsAttachments = [
      {
        path: resolved.path,
        ...(resolved.contentType ? { contentType: resolved.contentType } : {}),
      },
    ];
    const kind = kindFromMime(resolved.contentType ?? undefined);
    if (!message && kind) {
      // Avoid sending an empty body when only attachments exist.
      message = kind === "image" ? "<media:image>" : `<media:${kind}>`;
      messageFromPlaceholder = true;
    }
  }

  if (message.trim() && !messageFromPlaceholder) {
    if (textMode === "plain") {
      textStyles = opts.textStyles ?? [];
    } else {
      const tableMode = resolveMarkdownTableMode({
        cfg,
        channel: "signal",
        accountId: accountInfo.accountId,
      });
      const formatted = markdownToSignalText(message, { tableMode });
      message = formatted.text;
      textStyles = formatted.styles;
    }
  }

  if (!message.trim() && (!attachments || attachments.length === 0)) {
    throw new Error("Signal send requires text or media");
  }

  if (resolveSignalBackend(accountInfo) === "signal-ts") {
    const signalTsRuntime = await loadSignalTsRuntime();
    const result = await signalTsRuntime.sendMessageSignalTs({
      cfg,
      accountInfo,
      to,
      message,
      ...(opts.runtime ? { runtime: opts.runtime } : {}),
      textStyles,
      attachments: signalTsAttachments,
      replyToId: opts.replyToId,
      quoteAuthor: opts.quoteAuthor,
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
    });
    const quote = resolveSignalQuote({
      target,
      replyToId: opts.replyToId,
      quoteAuthor: opts.quoteAuthor,
    });
    return {
      ...result,
      receipt: createSignalSendReceipt({
        messageId: result.messageId,
        timestamp: result.timestamp,
        target,
        kind: signalTsAttachments?.length ? "media" : "text",
        ...(quote ? { replyToId: String(quote.quoteTimestamp) } : {}),
      }),
    };
  }

  const params: Record<string, unknown> = { message };
  if (textStyles.length > 0) {
    params["text-style"] = textStyles.map(
      (style) => `${style.start}:${style.length}:${style.style}`,
    );
  }
  if (account) {
    params.account = account;
  }
  if (attachments && attachments.length > 0) {
    params.attachments = attachments;
  }

  const targetParams = buildTargetParams(target, {
    recipient: true,
    group: true,
    username: true,
  });
  if (!targetParams) {
    throw new Error("Signal recipient is required");
  }
  Object.assign(params, targetParams);

  const quote = resolveSignalQuote({
    target,
    replyToId: opts.replyToId,
    quoteAuthor: opts.quoteAuthor,
  });
  if (quote) {
    params.quoteTimestamp = quote.quoteTimestamp;
    if (quote.quoteAuthor) {
      params.quoteAuthor = quote.quoteAuthor;
    }
  }

  const result = await signalRpcRequest<{ timestamp?: number }>("send", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
    apiMode,
  });
  const timestamp = result?.timestamp;
  const messageId = timestamp ? String(timestamp) : "unknown";
  return {
    messageId,
    timestamp,
    receipt: createSignalSendReceipt({
      messageId,
      target,
      kind: attachments && attachments.length > 0 ? "media" : "text",
      ...(quote ? { replyToId: String(quote.quoteTimestamp) } : {}),
      ...(timestamp != null ? { timestamp } : {}),
    }),
  };
}

export async function sendStickerSignal(
  to: string,
  stickerSpec: string,
  opts: SignalRpcOpts,
): Promise<SignalSendResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "Signal sticker send");
  const apiMode = cfg.channels?.signal?.apiMode;
  const accountInfo = await resolveSignalRpcAccountInfo(opts);
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const target = parseTarget(to);
  const sticker = normalizeSignalStickerSpec(stickerSpec);
  if (accountInfo && resolveSignalBackend(accountInfo) === "signal-ts") {
    const signalTsRuntime = await loadSignalTsRuntime();
    const result = await signalTsRuntime.sendStickerSignalTs({
      accountInfo,
      to,
      sticker,
      ...(opts.runtime ? { runtime: opts.runtime } : {}),
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
    });
    return {
      ...result,
      receipt: createSignalSendReceipt({
        messageId: result.messageId,
        timestamp: result.timestamp,
        target,
        kind: "media",
      }),
    };
  }
  const params: Record<string, unknown> = { sticker };
  if (account) {
    params.account = account;
  }
  const targetParams = buildTargetParams(target, {
    recipient: true,
    group: true,
    username: true,
  });
  if (!targetParams) {
    throw new Error("Signal recipient is required");
  }
  Object.assign(params, targetParams);

  const result = await signalRpcRequest<{ timestamp?: number }>("send", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
    apiMode,
  });
  const timestamp = result?.timestamp;
  const messageId = timestamp ? String(timestamp) : "unknown";
  return {
    messageId,
    timestamp,
    receipt: createSignalSendReceipt({
      messageId,
      target,
      kind: "media",
      ...(timestamp != null ? { timestamp } : {}),
    }),
  };
}

export async function sendTypingSignal(
  to: string,
  opts: SignalRpcOpts & { stop?: boolean },
): Promise<boolean> {
  const accountInfo = await resolveSignalRpcAccountInfo(opts);
  const cfg = requireRuntimeConfig(opts.cfg, "Signal typing");
  if (accountInfo && resolveSignalBackend(accountInfo) === "signal-ts") {
    return await (
      await loadSignalTsRuntime()
    ).sendTypingSignalTs({
      accountInfo,
      to,
      ...(opts.runtime ? { runtime: opts.runtime } : {}),
      stop: opts.stop,
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
    });
  }
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
    group: true,
  });
  if (!targetParams) {
    return false;
  }
  const params: Record<string, unknown> = { ...targetParams };
  if (account) {
    params.account = account;
  }
  if (opts.stop) {
    params.stop = true;
  }
  await signalRpcRequest("sendTyping", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
    apiMode: cfg.channels?.signal?.apiMode,
  });
  return true;
}

export async function sendReadReceiptSignal(
  to: string,
  targetTimestamp: number,
  opts: SignalRpcOpts & { type?: SignalReceiptType },
): Promise<boolean> {
  if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) {
    return false;
  }
  const accountInfo = await resolveSignalRpcAccountInfo(opts);
  const cfg = requireRuntimeConfig(opts.cfg, "Signal read receipt");
  if (accountInfo && resolveSignalBackend(accountInfo) === "signal-ts") {
    return await (
      await loadSignalTsRuntime()
    ).sendReadReceiptSignalTs({
      accountInfo,
      to,
      ...(opts.runtime ? { runtime: opts.runtime } : {}),
      targetTimestamp,
      type: opts.type,
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
    });
  }
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
  });
  if (!targetParams) {
    return false;
  }
  const params: Record<string, unknown> = {
    ...targetParams,
    targetTimestamp,
    type: opts.type ?? "read",
  };
  if (account) {
    params.account = account;
  }
  await signalRpcRequest("sendReceipt", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
    apiMode: cfg.channels?.signal?.apiMode,
  });
  return true;
}
