import { loadConfig, type OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import { kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { resolveOutboundAttachmentFromUrl } from "openclaw/plugin-sdk/media-runtime";
import { createTimingTrace } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { resolveSignalAccount } from "./accounts.js";
import { signalRpcRequest } from "./client.js";
import { markdownToSignalText, type SignalTextStyleRange } from "./format.js";
import { resolveSignalRpcContext } from "./rpc-context.js";

export type SignalSendOpts = {
  cfg?: OpenClawConfig;
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
  abortSignal?: AbortSignal;
  textMode?: "markdown" | "plain";
  textStyles?: SignalTextStyleRange[];
  replyToId?: string;
  traceLabel?: string;
};

export type SignalSendResult = {
  messageId: string;
  timestamp?: number;
};

export type SignalRpcOpts = Pick<
  SignalSendOpts,
  "baseUrl" | "account" | "accountId" | "timeoutMs" | "abortSignal" | "traceLabel"
>;

export type SignalReceiptType = "read" | "viewed";

type SignalTarget =
  | { type: "recipient"; recipient: string }
  | { type: "group"; groupId: string }
  | { type: "username"; username: string };

let signalConfigRuntimePromise:
  | Promise<typeof import("openclaw/plugin-sdk/config-runtime")>
  | undefined;
let signalTsRuntimePromise: Promise<typeof import("./signal-ts-runtime.js")> | undefined;

async function loadSignalConfigRuntime() {
  signalConfigRuntimePromise ??= import("openclaw/plugin-sdk/config-runtime");
  return await signalConfigRuntimePromise;
}

async function loadSignalTsRuntime() {
  signalTsRuntimePromise ??= import("./signal-ts-runtime.js");
  return await signalTsRuntimePromise;
}

async function resolveSignalRpcAccountInfo(
  opts: Pick<SignalSendOpts, "cfg" | "baseUrl" | "account" | "accountId">,
) {
  if (!opts.cfg && !opts.accountId?.trim() && opts.baseUrl?.trim() && opts.account?.trim()) {
    return undefined;
  }
  const cfg = opts.cfg ?? (await loadSignalConfigRuntime()).loadConfig();
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

export async function sendMessageSignal(
  to: string,
  text: string,
  opts: SignalSendOpts = {},
): Promise<SignalSendResult> {
  const trace = opts.traceLabel
    ? createTimingTrace({
        channel: "signal-trace",
        label: opts.traceLabel,
        scope: "sendMessageSignal",
        sink: "stderr",
      })
    : (_stage: string, _details?: string) => {};
  const cfg = opts.cfg ?? loadConfig();
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
      }>
    | undefined;
  if (opts.mediaUrl?.trim()) {
    const resolved = await resolveOutboundAttachmentFromUrl(opts.mediaUrl.trim(), maxBytes, {
      mediaAccess: opts.mediaAccess,
      localRoots: opts.mediaLocalRoots,
      readFile: opts.mediaReadFile,
    });
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

  if (accountInfo.config.backend === "signal-ts") {
    const signalTsRuntime = await loadSignalTsRuntime();
    trace(
      "signal-ts-start",
      `targetType=${target.type} replyTo=${opts.replyToId ?? "none"} textChars=${message.length} attachments=${signalTsAttachments?.length ?? 0}`,
    );
    const result = await signalTsRuntime.sendMessageSignalTs({
      cfg,
      accountInfo,
      to,
      message,
      textStyles,
      attachments: signalTsAttachments,
      replyToId: opts.replyToId,
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
    });
    trace(
      "signal-ts-done",
      `timestamp=${result.timestamp ?? "none"} messageId=${result.messageId}`,
    );
    return result;
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

  const quoteTs = Number(opts.replyToId);
  if (Number.isFinite(quoteTs) && quoteTs > 0) {
    params["quote-timestamp"] = quoteTs;
    if (target.type === "recipient") {
      params["quote-author"] = target.recipient;
    }
  }

  trace(
    "rpc-start",
    `targetType=${target.type} replyTo=${opts.replyToId ?? "none"} textChars=${message.length} attachments=${attachments?.length ?? 0}`,
  );
  const result = await signalRpcRequest<{ timestamp?: number }>("send", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
    abortSignal: opts.abortSignal,
  });
  trace("rpc-done", `timestamp=${result?.timestamp ?? "none"}`);
  const timestamp = result?.timestamp;
  return {
    messageId: timestamp ? String(timestamp) : "unknown",
    timestamp,
  };
}

export async function sendTypingSignal(
  to: string,
  opts: SignalRpcOpts & { stop?: boolean } = {},
): Promise<boolean> {
  const trace = opts.traceLabel
    ? createTimingTrace({
        channel: "signal-trace",
        label: opts.traceLabel,
        scope: "sendTypingSignal",
        sink: "stderr",
      })
    : (_stage: string, _details?: string) => {};
  const accountInfo = await resolveSignalRpcAccountInfo(opts);
  if (accountInfo?.config.backend === "signal-ts") {
    const signalTsRuntime = await loadSignalTsRuntime();
    return await signalTsRuntime.sendTypingSignalTs({
      accountInfo,
      to,
      stop: opts.stop,
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
    });
  }
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const target = parseTarget(to);
  const targetParams = buildTargetParams(target, {
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
  trace("rpc-start", `targetType=${target.type} stop=${opts.stop === true ? "yes" : "no"}`);
  await signalRpcRequest("sendTyping", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
    abortSignal: opts.abortSignal,
  });
  trace("rpc-done");
  return true;
}

export async function sendStickerSignal(
  to: string,
  stickerSpec: string,
  opts: Pick<
    SignalSendOpts,
    "cfg" | "baseUrl" | "account" | "accountId" | "timeoutMs" | "abortSignal"
  > = {},
): Promise<SignalSendResult> {
  const sticker = stickerSpec.trim();
  if (!sticker) {
    throw new Error("Signal sticker id is required");
  }
  const accountInfo = await resolveSignalRpcAccountInfo(opts);
  if (accountInfo?.config.backend === "signal-ts") {
    const signalTsRuntime = await loadSignalTsRuntime();
    return await signalTsRuntime.sendStickerSignalTs({
      accountInfo,
      to,
      sticker,
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
    });
  }
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const target = parseTarget(to);
  const params: Record<string, unknown> = {
    sticker,
  };
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
    abortSignal: opts.abortSignal,
  });
  const timestamp = result?.timestamp;
  return {
    messageId: timestamp ? String(timestamp) : "unknown",
    timestamp,
  };
}

export async function sendReadReceiptSignal(
  to: string,
  targetTimestamp: number,
  opts: SignalRpcOpts & { type?: SignalReceiptType } = {},
): Promise<boolean> {
  if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) {
    return false;
  }
  const accountInfo = await resolveSignalRpcAccountInfo(opts);
  if (accountInfo?.config.backend === "signal-ts") {
    const signalTsRuntime = await loadSignalTsRuntime();
    return await signalTsRuntime.sendReadReceiptSignalTs({
      accountInfo,
      to,
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
    abortSignal: opts.abortSignal,
  });
  return true;
}
