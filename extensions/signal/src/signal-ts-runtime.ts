import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FileSignalRepository,
  SignalTsClient,
  SignalTsDecryptionError,
  base64ToBytes,
  bytesToBase64,
  createSignalLocalAddress,
  createLibsignalStores,
  decodeSignalEnvelope,
  decryptIncomingEnvelope,
  deriveAccessKeyBase64FromProfileKeyBase64,
  downloadSignalAttachment,
  hexToBytes,
  normalizeDecryptedIncomingMessage,
  parseSignalRecipientTarget,
  preKeyAuthFromBase64,
  type FileSignalGroupState,
  type FileSignalRecipientState,
  type PreKeyAuth,
  type SignalAttachmentPointer,
  type SignalBodyRange,
  type SignalEnvelope as SignalTsEnvelope,
  type SignalIncomingMessage,
  type SignalQuote,
  type SignalReaction,
  type SignalRecipientTarget,
  type SignalSticker,
} from "@openclaw/signal-ts";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import {
  computeBackoff,
  sleepWithAbort,
  type BackoffPolicy,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import type { ResolvedSignalAccount } from "./accounts.js";
import type { SignalTextStyleRange } from "./format.js";
import type {
  SignalAttachment,
  SignalDataMessage,
  SignalEnvelope,
  SignalReceivePayload,
} from "./monitor/event-handler.types.js";

type SignalAttachmentFetch = NonNullable<Parameters<typeof downloadSignalAttachment>[0]["fetch"]>;
type SignalAttachmentUploadFetch = NonNullable<
  Parameters<SignalTsClient["uploadAttachment"]>[0]["fetch"]
>;
type RequestInitWithDispatcher = UndiciRequestInit & { dispatcher?: Agent };

const SIGNAL_CDN_HOSTS = new Set(["cdn.signal.org", "cdn2.signal.org", "cdn3.signal.org"]);

let signalCdnTlsFallbackAgent: Agent | undefined;

export type SignalTsAttachmentInput = {
  path: string;
  contentType?: string;
  fileName?: string;
};

export type SignalTsSendParams = {
  cfg: OpenClawConfig;
  accountInfo: ResolvedSignalAccount;
  to: string;
  message: string;
  runtime?: RuntimeEnv;
  textStyles?: SignalTextStyleRange[];
  attachments?: SignalTsAttachmentInput[];
  replyToId?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
};

export type SignalTsRpcLikeParams = {
  accountInfo: ResolvedSignalAccount;
  to: string;
  runtime?: RuntimeEnv;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
};

export type SignalTsStickerParams = SignalTsRpcLikeParams & {
  sticker: string;
};

export type SignalTsReactionParams = SignalTsRpcLikeParams & {
  targetTimestamp: number;
  emoji: string;
  remove?: boolean;
  targetAuthor?: string;
  targetAuthorUuid?: string;
  groupId?: string;
};

export type SignalTsMonitorParams = {
  accountInfo: ResolvedSignalAccount;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  reconnectPolicy?: Partial<BackoffPolicy>;
  onEvent: (event: { event: "receive"; data: string }) => Promise<void>;
};

export type SignalTsFetchAttachmentParams = {
  accountInfo: ResolvedSignalAccount;
  attachment: SignalAttachment;
  maxBytes: number;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const SIGNAL_TS_RECONNECT_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 10_000,
  factor: 2,
  jitter: 0.2,
};
const SIGNAL_TS_ENVELOPE_TYPE_LABELS: Record<number, string> = {
  0: "UNKNOWN",
  1: "DOUBLE_RATCHET",
  3: "PREKEY_MESSAGE",
  5: "SERVER_DELIVERY_RECEIPT",
  6: "UNIDENTIFIED_SENDER",
  8: "PLAINTEXT_CONTENT",
};

let signalTsRuntimeTraceSequence = 0;
let signalTsLogDay: string | undefined;

type ActiveSignalTsClient = {
  client: SignalTsClient;
  repository: FileSignalRepository;
};

const activeSignalTsClients = new Map<string, ActiveSignalTsClient>();

export function isSignalTsBackend(accountInfo: ResolvedSignalAccount): boolean {
  return accountInfo.config.backend === "signal-ts";
}

export function resolveSignalTsStatePath(accountInfo: ResolvedSignalAccount): string {
  const configured = normalizeOptionalString(accountInfo.config.signalTsStatePath);
  const raw =
    configured ??
    normalizeOptionalString(process.env["OPENCLAW_SIGNAL_TS_STATE"]) ??
    path.join(os.homedir(), ".openclaw", "signal-ts", `${accountInfo.accountId}.json`);
  return raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
}

function createSignalTsRuntimeTraceId(prefix: string): string {
  signalTsRuntimeTraceSequence = (signalTsRuntimeTraceSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now().toString(36)}-${signalTsRuntimeTraceSequence.toString(36)}`;
}

function resolveSignalTsLogFile(): string {
  return path.join(process.env["CODEX_LOG_DIR"] ?? "/root/.codex/logs", "signal-ts.log");
}

function formatLocalSignalTsLogDay(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function ensureSignalTsLogFile(logFile: string): void {
  const today = formatLocalSignalTsLogDay();
  if (signalTsLogDay === today) {
    return;
  }
  const dateFile = `${logFile}.date`;
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    const previousDay = readFileSync(dateFile, "utf8").trim();
    if (previousDay !== today) {
      rmSync(logFile, { force: true });
      writeFileSync(dateFile, `${today}\n`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      appendFileSync(
        logFile,
        `${new Date().toISOString()} [signal-ts:error] log rollover check failed: ${String(err)}\n`,
      );
    }
    rmSync(logFile, { force: true });
    writeFileSync(dateFile, `${today}\n`);
  }
  signalTsLogDay = today;
}

function appendSignalTsLog(level: "debug" | "info" | "warn" | "error", message: string): void {
  try {
    const logFile = resolveSignalTsLogFile();
    ensureSignalTsLogFile(logFile);
    appendFileSync(logFile, `${new Date().toISOString()} [signal-ts:${level}] ${message}\n`);
  } catch {
    // Logging must not interfere with message delivery.
  }
}

function logSignalTsInfo(message: string): void {
  appendSignalTsLog("info", message);
}

function logSignalTsError(runtime: RuntimeEnv | undefined, message: string): void {
  appendSignalTsLog("error", message);
  runtime?.error?.(message);
}

function createSignalTsLogger(runtime: RuntimeEnv | undefined):
  | {
      debug: (message: string) => void;
      info: (message: string) => void;
      warn: (message: string) => void;
      error: (message: string, err?: unknown) => void;
    }
  | undefined {
  if (!runtime) {
    return undefined;
  }
  return {
    debug: (message) => appendSignalTsLog("debug", message),
    info: (message) => appendSignalTsLog("info", message),
    warn: (message) => {
      appendSignalTsLog("warn", message);
      runtime.error?.(`signal-ts: ${message}`);
    },
    error: (message, err) => {
      const fullMessage = `${message}${err === undefined ? "" : `: ${describeSignalTsDisconnectError(err)}`}`;
      appendSignalTsLog("error", fullMessage);
      runtime.error?.(`signal-ts: ${fullMessage}`);
    },
  };
}

export async function sendMessageSignalTs(params: SignalTsSendParams): Promise<{
  messageId: string;
  timestamp: number;
}> {
  const traceId = createSignalTsRuntimeTraceId("openclaw-signal-message");
  return await withSignalTsClient(params, async ({ client, repository, abortSignal }) => {
    const attachments = await uploadSignalTsAttachments({
      client,
      attachments: params.attachments ?? [],
      traceId,
      abortSignal,
    });
    const bodyRanges = mapTextStyles(params.textStyles ?? []);
    const quote = await resolveSignalTsQuote({
      to: params.to,
      replyToId: params.replyToId,
      repository,
    });
    const group = await resolveSignalTsGroup(params.to, repository);
    if (group) {
      const result = await sendSignalTsGroupMessage({
        client,
        repository,
        group,
        traceId,
        body: params.message,
        attachments,
        ...(bodyRanges ? { bodyRanges } : {}),
        quote,
        abortSignal,
      });
      return {
        messageId: String(result.timestamp),
        timestamp: result.timestamp,
      };
    }
    const target = await resolveSignalTsTarget(params.to, repository);
    const preKeyAuth = await resolveSignalTsPreKeyAuth(params.to, repository);
    const result = await client.sendMessage({
      traceId,
      destination: target,
      body: params.message,
      attachments,
      ...(bodyRanges ? { bodyRanges } : {}),
      ...(quote ? { quote } : {}),
      stores: createLibsignalStores(repository),
      ...(preKeyAuth ? { preKeyAuth } : {}),
      abortSignal,
    });
    return {
      messageId: String(result.timestamp),
      timestamp: result.timestamp,
    };
  });
}

export async function sendStickerSignalTs(params: SignalTsStickerParams): Promise<{
  messageId: string;
  timestamp: number;
}> {
  const traceId = createSignalTsRuntimeTraceId("openclaw-signal-sticker");
  return await withSignalTsClient(params, async ({ client, repository, abortSignal }) => {
    const sticker = await resolveSignalTsSticker({
      client,
      repository,
      stickerSpec: params.sticker,
      traceId,
      abortSignal,
    });
    const group = await resolveSignalTsGroup(params.to, repository);
    if (group) {
      const result = await sendSignalTsGroupStickerMessage({
        client,
        repository,
        group,
        traceId,
        sticker,
        abortSignal,
      });
      return {
        messageId: String(result.timestamp),
        timestamp: result.timestamp,
      };
    }
    const target = await resolveSignalTsTarget(params.to, repository);
    const preKeyAuth = await resolveSignalTsPreKeyAuth(params.to, repository);
    const result = await client.sendStickerMessage({
      traceId,
      destination: target,
      sticker,
      stores: createLibsignalStores(repository),
      ...(preKeyAuth ? { preKeyAuth } : {}),
      abortSignal,
    });
    return {
      messageId: String(result.timestamp),
      timestamp: result.timestamp,
    };
  });
}

export async function sendReactionSignalTs(params: SignalTsReactionParams): Promise<{
  messageId: string;
  timestamp: number;
}> {
  if (!Number.isFinite(params.targetTimestamp) || params.targetTimestamp <= 0) {
    throw new Error("Valid targetTimestamp is required for Signal reaction");
  }
  const emoji = params.emoji.trim();
  if (!emoji) {
    throw new Error("Emoji is required for Signal reaction");
  }
  const traceId = createSignalTsRuntimeTraceId("openclaw-signal-reaction");
  return await withSignalTsClient(params, async ({ client, repository, abortSignal }) => {
    const reaction = await resolveSignalTsReaction({
      recipient: params.to,
      targetTimestamp: params.targetTimestamp,
      emoji,
      remove: params.remove,
      targetAuthor: params.targetAuthor,
      targetAuthorUuid: params.targetAuthorUuid,
      repository,
    });
    const groupTarget = params.groupId?.trim()
      ? `signal:group:${params.groupId.trim()}`
      : params.to;
    const group = await resolveSignalTsGroup(groupTarget, repository);
    if (group) {
      const result = await sendSignalTsGroupReactionMessage({
        client,
        repository,
        group,
        traceId,
        reaction,
        abortSignal,
      });
      return {
        messageId: String(result.timestamp),
        timestamp: result.timestamp,
      };
    }
    const target = await resolveSignalTsTarget(params.to, repository);
    const preKeyAuth = await resolveSignalTsPreKeyAuth(params.to, repository);
    const result = await client.sendReactionMessage({
      traceId,
      destination: target,
      reaction,
      stores: createLibsignalStores(repository),
      ...(preKeyAuth ? { preKeyAuth } : {}),
      abortSignal,
    });
    return {
      messageId: String(result.timestamp),
      timestamp: result.timestamp,
    };
  });
}

export async function fetchSignalTsAttachment(
  params: SignalTsFetchAttachmentParams,
): Promise<{ path: string; contentType?: string } | null> {
  const traceId = createSignalTsRuntimeTraceId("openclaw-signal-fetch-attachment");
  const pointer = deserializeSignalTsAttachmentPointer(params.attachment.signalTsPointer);
  if (!pointer) {
    logSignalTsInfo(
      `signal-ts ${traceId} attachment-fetch skipped: missing signal-ts pointer id=${params.attachment.id ?? "unknown"}`,
    );
    return null;
  }
  logSignalTsInfo(
    `signal-ts ${traceId} attachment-fetch start id=${params.attachment.id ?? "unknown"} cdnKey=${pointer.cdnKey ?? "none"} cdnNumber=${pointer.cdnNumber ?? "none"} contentType=${pointer.contentType ?? params.attachment.contentType ?? "none"} size=${pointer.size ?? params.attachment.size ?? "none"} fileName=${pointer.fileName ?? params.attachment.filename ?? "none"} caption=${JSON.stringify(pointer.caption ?? null)}`,
  );
  if (typeof pointer.size === "number" && pointer.size > params.maxBytes) {
    throw new Error(
      `Signal attachment ${params.attachment.id ?? pointer.cdnKey ?? "unknown"} exceeds ${(
        params.maxBytes /
        (1024 * 1024)
      ).toFixed(0)}MB limit`,
    );
  }
  const data = await downloadSignalAttachment({
    pointer,
    fetch: fetchSignalCdnAttachment,
    abortSignal: params.abortSignal,
  });
  logSignalTsInfo(
    `signal-ts ${traceId} attachment-fetch downloaded bytes=${data.byteLength} id=${params.attachment.id ?? pointer.cdnKey ?? "unknown"}`,
  );
  if (data.byteLength > params.maxBytes) {
    throw new Error(
      `Signal attachment ${params.attachment.id ?? pointer.cdnKey ?? "unknown"} exceeds ${(
        params.maxBytes /
        (1024 * 1024)
      ).toFixed(0)}MB limit`,
    );
  }
  const saved = await saveMediaBuffer(
    Buffer.from(data),
    pointer.contentType ?? params.attachment.contentType ?? undefined,
    "inbound",
    params.maxBytes,
  );
  logSignalTsInfo(
    `signal-ts ${traceId} attachment-fetch saved path=${saved.path} contentType=${saved.contentType ?? "none"} bytes=${data.byteLength}`,
  );
  return { path: saved.path, contentType: saved.contentType };
}

function isSignalCdnRequest(input: string | URL): boolean {
  try {
    const url = typeof input === "string" ? new URL(input) : input;
    return url.protocol === "https:" && SIGNAL_CDN_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function isHttpsRequest(input: RequestInfo | URL): boolean {
  try {
    const url =
      input instanceof URL
        ? input
        : typeof input === "string"
          ? new URL(input)
          : new URL(input.url);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function getSignalCdnTlsFallbackAgent(): Agent {
  signalCdnTlsFallbackAgent ??= new Agent({
    allowH2: false,
    connect: { rejectUnauthorized: false },
  });
  return signalCdnTlsFallbackAgent;
}

const fetchSignalCdnAttachment: SignalAttachmentFetch = async (input, init) => {
  try {
    return await globalThis.fetch(input, init);
  } catch (err) {
    if (!isSignalCdnRequest(input)) {
      throw err;
    }
    // Signal attachment ciphertext is still authenticated by the pointer key/digest
    // after download. This fallback is scoped to Signal CDN requests for hosts where
    // the local runtime's CA bundle rejects the CDN chain.
    return (await undiciFetch(input, {
      ...(init as UndiciRequestInit | undefined),
      dispatcher: getSignalCdnTlsFallbackAgent(),
    } satisfies RequestInitWithDispatcher)) as unknown as Response;
  }
};

const fetchSignalAttachmentUpload: SignalAttachmentUploadFetch = async (input, init) => {
  try {
    return await globalThis.fetch(input, init);
  } catch (err) {
    if (!isHttpsRequest(input)) {
      throw err;
    }
    // Attachments are encrypted and authenticated before upload. This mirrors the
    // scoped download fallback for runtimes whose local CA bundle rejects Signal's
    // upload endpoint chain.
    return (await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as UndiciRequestInit | undefined),
      dispatcher: getSignalCdnTlsFallbackAgent(),
    } satisfies RequestInitWithDispatcher)) as unknown as Response;
  }
};

export async function sendTypingSignalTs(
  params: SignalTsRpcLikeParams & { stop?: boolean },
): Promise<boolean> {
  const traceId = createSignalTsRuntimeTraceId("openclaw-signal-typing");
  return await withSignalTsClient(params, async ({ client, repository, abortSignal }) => {
    const target = await resolveSignalTsTarget(params.to, repository);
    const preKeyAuth = await resolveSignalTsPreKeyAuth(params.to, repository);
    await client.sendTypingMessage({
      traceId,
      destination: target,
      typing: {
        timestamp: Date.now(),
        action: params.stop ? "stopped" : "started",
      },
      stores: createLibsignalStores(repository),
      ...(preKeyAuth ? { preKeyAuth } : {}),
      abortSignal,
    });
    return true;
  });
}

export async function sendReadReceiptSignalTs(
  params: SignalTsRpcLikeParams & { targetTimestamp: number; type?: "read" | "viewed" },
): Promise<boolean> {
  const traceId = createSignalTsRuntimeTraceId("openclaw-signal-read-receipt");
  return await withSignalTsClient(params, async ({ client, repository, abortSignal }) => {
    const target = await resolveSignalTsTarget(params.to, repository);
    const preKeyAuth = await resolveSignalTsPreKeyAuth(params.to, repository);
    await client.sendReceiptMessage({
      traceId,
      destination: target,
      receipt: {
        type: params.type ?? "read",
        timestamps: [params.targetTimestamp],
      },
      stores: createLibsignalStores(repository),
      ...(preKeyAuth ? { preKeyAuth } : {}),
      abortSignal,
    });
    return true;
  });
}

export async function monitorSignalTsProvider(params: SignalTsMonitorParams): Promise<void> {
  const reconnectPolicy = {
    ...SIGNAL_TS_RECONNECT_POLICY,
    ...params.reconnectPolicy,
  };
  let reconnectAttempts = 0;

  for (;;) {
    if (params.abortSignal?.aborted) {
      return;
    }
    const result = await runSignalTsMonitorConnection(params);
    if (params.abortSignal?.aborted) {
      return;
    }
    if (result.fatalError) {
      const message = `signal-ts monitor fatal: ${describeSignalTsDisconnectError(result.fatalError)}`;
      logSignalTsError(params.runtime, message);
      await sendSignalTsFatalDiagnosticMessage({
        params,
        message,
        envelope: result.diagnosticEnvelope,
      });
      throw result.fatalError;
    }
    reconnectAttempts += 1;
    const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
    const reason = result.error ? `: ${describeSignalTsDisconnectError(result.error)}` : "";
    logSignalTsError(
      params.runtime,
      `signal-ts: connection lost${reason}; reconnecting in ${delayMs / 1000}s...`,
    );
    await sleepWithAbort(delayMs, params.abortSignal);
  }
}

async function runSignalTsMonitorConnection(params: SignalTsMonitorParams): Promise<{
  error?: unknown;
  fatalError?: unknown;
  diagnosticEnvelope?: SignalEnvelope;
}> {
  const repository = await FileSignalRepository.open(resolveSignalTsStatePath(params.accountInfo));
  const account = await repository.getAccount();
  if (!account) {
    throw new Error("Signal-ts state is missing account data");
  }
  const stores = createLibsignalStores(repository);
  const localAddress = createSignalLocalAddress(account.account);
  const client = new SignalTsClient({
    account: account.account,
    environment: "production",
    userAgent: account.userAgent ?? "OpenClaw signal-ts",
    ...(() => {
      const logger = createSignalTsLogger(params.runtime);
      return logger ? { logger } : {};
    })(),
  });
  const activeClientKey = resolveSignalTsActiveClientKey(params.accountInfo);
  const activeClient: ActiveSignalTsClient = { client, repository };
  let latestDiagnosticEnvelope: SignalEnvelope | undefined;
  const offIncoming = client.on("incoming", (incoming) => {
    void (async () => {
      try {
        logSignalTsInfo(
          `signal-ts inbound decrypt start ${describeSignalTsIncomingEnvelope(
            incoming.envelope,
            incoming.timestamp,
          )}`,
        );
        const decrypted = await decryptIncomingEnvelope({
          envelope: incoming.envelope,
          localAddress,
          sealedSender: {
            localAci: account.account.device.aci,
            localDeviceId: account.account.device.deviceId,
            localE164: account.account.device.e164 ?? null,
          },
          stores,
        });
        const messages = normalizeDecryptedIncomingMessage(decrypted);
        logSignalTsInfo(`signal-ts inbound decrypt done normalized=${messages.length}`);
        for (const message of messages) {
          logSignalTsInfo(
            `signal-ts inbound normalized ${describeSignalTsIncomingMessage(message)}`,
          );
          const envelope = await toSignalCliEnvelope(message, repository);
          if (!envelope) {
            logSignalTsInfo(`signal-ts inbound skipped signal-cli envelope kind=${message.kind}`);
            continue;
          }
          latestDiagnosticEnvelope = envelope;
          const payload: SignalReceivePayload = { envelope };
          logSignalTsInfo(
            `signal-ts inbound dispatch start kind=${message.kind} source=${envelope.sourceUuid ?? envelope.sourceNumber ?? "unknown"} timestamp=${envelope.timestamp ?? "none"}`,
          );
          await params.onEvent({ event: "receive", data: JSON.stringify(payload) });
          logSignalTsInfo(
            `signal-ts inbound dispatch done kind=${message.kind} source=${envelope.sourceUuid ?? envelope.sourceNumber ?? "unknown"} timestamp=${envelope.timestamp ?? "none"}`,
          );
        }
      } catch (err) {
        if (isIgnorableSignalTsIncomingError(err, incoming.envelope)) {
          logSignalTsInfo(
            `signal-ts inbound ignored ${describeSignalTsIncomingEnvelope(
              incoming.envelope,
              incoming.timestamp,
            )}`,
          );
          return;
        }
        await maybeSendSignalTsRetryReceipt({
          client,
          repository,
          err,
          runtime: params.runtime,
          abortSignal: params.abortSignal,
        });
        logSignalTsError(
          params.runtime,
          `signal-ts inbound failed: ${String(err)} ${describeSignalTsIncomingEnvelope(
            incoming.envelope,
            incoming.timestamp,
          )}`,
        );
      } finally {
        try {
          await Promise.resolve((incoming.ack as () => unknown)());
        } catch (err) {
          logSignalTsError(params.runtime, `signal-ts inbound ack failed: ${String(err)}`);
        }
      }
    })();
  });
  const disconnected = waitForSignalTsDisconnect(client, params.abortSignal);
  try {
    activeSignalTsClients.set(activeClientKey, activeClient);
    await client.connect(params.abortSignal);
    await Promise.race([waitForAbort(params.abortSignal), disconnected]);
    return { diagnosticEnvelope: latestDiagnosticEnvelope };
  } catch (err) {
    unregisterSignalTsActiveClient(activeClientKey, activeClient);
    if (params.abortSignal?.aborted) {
      return { diagnosticEnvelope: latestDiagnosticEnvelope };
    }
    if (isFatalSignalTsDisconnect(err)) {
      return { fatalError: err, diagnosticEnvelope: latestDiagnosticEnvelope };
    }
    return { error: err, diagnosticEnvelope: latestDiagnosticEnvelope };
  } finally {
    unregisterSignalTsActiveClient(activeClientKey, activeClient);
    offIncoming();
    await client.disconnect();
  }
}

async function sendSignalTsFatalDiagnosticMessage({
  params,
  message,
  envelope,
}: {
  params: SignalTsMonitorParams;
  message: string;
  envelope?: SignalEnvelope;
}): Promise<void> {
  const target = resolveSignalTsDiagnosticTarget(envelope);
  if (!target) {
    logSignalTsError(
      params.runtime,
      "signal-ts fatal diagnostic skipped: no previous Signal target",
    );
    return;
  }
  try {
    await sendMessageSignalTs({
      cfg: {},
      accountInfo: params.accountInfo,
      to: target,
      message: `[OpenClaw channel error] ${message}`,
      runtime: params.runtime,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  } catch (err) {
    logSignalTsError(
      params.runtime,
      `signal-ts fatal diagnostic send failed: ${describeSignalTsDisconnectError(err)}`,
    );
  }
}

function resolveSignalTsDiagnosticTarget(envelope?: SignalEnvelope): string | undefined {
  if (!envelope) {
    return undefined;
  }
  const groupId = resolveSignalTsDiagnosticGroupInfo(envelope)?.groupId?.trim();
  if (groupId) {
    return `signal:group:${groupId}`;
  }
  const sourceUuid = envelope.sourceUuid?.trim();
  if (sourceUuid) {
    return `signal:uuid:${sourceUuid}`;
  }
  const sourceNumber = envelope.sourceNumber?.trim();
  return sourceNumber ? `signal:${sourceNumber}` : undefined;
}

function resolveSignalTsDiagnosticGroupInfo(
  envelope: SignalEnvelope,
): SignalDataMessage["groupInfo"] | undefined {
  return (
    envelope.dataMessage?.groupInfo ??
    envelope.editMessage?.dataMessage?.groupInfo ??
    envelope.reactionMessage?.groupInfo ??
    undefined
  );
}

function describeSignalTsIncomingMessage(message: SignalIncomingMessage): string {
  const base = [
    `kind=${message.kind}`,
    `source=${message.sender.serviceId ?? "unknown"}`,
    `device=${message.sender.deviceId ?? "unknown"}`,
    `timestamp=${message.timestamp ?? "none"}`,
    `serverTimestamp=${message.serverTimestamp ?? "none"}`,
  ];
  const group = "group" in message ? message.group : undefined;
  if (group?.id) {
    base.push(`group=${group.id}`);
  }
  if (message.kind === "data") {
    base.push(`bodyChars=${message.body?.length ?? 0}`);
    base.push(`body=${JSON.stringify(message.body ?? "")}`);
    base.push(`attachments=${message.attachments.length}`);
    if (message.attachments.length > 0) {
      base.push(
        `attachmentMeta=${JSON.stringify(message.attachments.map(describeSignalTsAttachmentPointerForLog))}`,
      );
    }
    base.push(`bodyRanges=${message.bodyRanges.length}`);
    if (message.message.quote) {
      base.push(
        `quote=${JSON.stringify({
          id: message.message.quote.id ?? null,
          authorAci: message.message.quote.authorAci ?? null,
          text: message.message.quote.text ?? null,
        })}`,
      );
    }
    if (message.message.reaction) {
      base.push(
        `reaction=${JSON.stringify({
          emoji: message.message.reaction.emoji ?? null,
          remove: message.message.reaction.remove ?? null,
          targetAuthorAci: message.message.reaction.targetAuthorAci ?? null,
          targetSentTimestamp: message.message.reaction.targetSentTimestamp ?? null,
        })}`,
      );
    }
    if (message.message.sticker) {
      base.push(
        `sticker=${JSON.stringify({
          stickerId: message.message.sticker.stickerId ?? null,
          emoji: message.message.sticker.emoji ?? null,
          hasData: Boolean(message.message.sticker.data),
        })}`,
      );
    }
  } else if (message.kind === "reaction") {
    base.push(
      `reaction=${JSON.stringify({
        emoji: message.reaction.emoji ?? null,
        remove: message.reaction.remove ?? null,
        targetAuthorAci: message.reaction.targetAuthorAci ?? null,
        targetSentTimestamp: message.reaction.targetSentTimestamp ?? null,
      })}`,
    );
  } else if (message.kind === "edit") {
    base.push(`targetSentTimestamp=${message.targetSentTimestamp ?? "none"}`);
    base.push(`bodyChars=${message.message?.body?.length ?? 0}`);
    base.push(`body=${JSON.stringify(message.message?.body ?? "")}`);
    base.push(`attachments=${message.message?.attachments?.length ?? 0}`);
  } else if (message.kind === "receipt") {
    base.push(
      `receipt=${JSON.stringify({
        type: message.receipt.type ?? null,
        timestamps: message.receipt.timestamps ?? [],
      })}`,
    );
  } else if (message.kind === "typing") {
    base.push(
      `typing=${JSON.stringify({
        action: message.typing.action ?? null,
        timestamp: message.typing.timestamp ?? null,
      })}`,
    );
  } else if (message.kind === "decryption-error") {
    base.push(
      `decryptionError=${JSON.stringify({
        timestamp: message.decryptionError.timestamp,
        deviceId: message.decryptionError.deviceId,
        ratchetKey: message.decryptionError.ratchetKey ? "present" : "missing",
      })}`,
    );
  } else if (message.kind === "sync") {
    base.push(`syncKeys=${Object.keys(message.syncMessage).toSorted().join(",") || "none"}`);
  } else if (message.kind === "unknown") {
    base.push(`contentKeys=${Object.keys(message.content).toSorted().join(",") || "none"}`);
  }
  return base.join(" ");
}

function describeSignalTsAttachmentPointerForLog(
  pointer: SignalAttachmentPointer,
): Record<string, unknown> {
  return {
    id: pointer.cdnKey ?? pointer.cdnId ?? pointer.clientUuid ?? null,
    cdnNumber: pointer.cdnNumber ?? null,
    contentType: pointer.contentType ?? null,
    size: pointer.size ?? null,
    fileName: pointer.fileName ?? null,
    caption: pointer.caption ?? null,
    width: pointer.width ?? null,
    height: pointer.height ?? null,
    flags: pointer.flags ?? null,
    hasKey: Boolean(pointer.key),
    hasDigest: Boolean(pointer.digest),
    hasIncrementalMac: Boolean(pointer.incrementalMac),
  };
}

function isFatalSignalTsDisconnect(err: unknown): boolean {
  const text = describeSignalTsDisconnectError(err).toLowerCase();
  return text.includes("connectedelsewhere") || text.includes("connected elsewhere");
}

function describeSignalTsDisconnectError(err: unknown): string {
  if (err instanceof Error) {
    const cause =
      "cause" in err && err.cause !== undefined
        ? `; cause: ${describeSignalTsDisconnectError(err.cause)}`
        : "";
    return `${err.name}: ${err.message}${cause}`;
  }
  if (typeof err === "string") {
    return err;
  }
  if (err === undefined) {
    return "undefined";
  }
  if (err === null) {
    return "null";
  }
  if (typeof err === "object") {
    return JSON.stringify(err) ?? Object.prototype.toString.call(err);
  }
  if (typeof err === "function") {
    return `[function ${err.name || "anonymous"}]`;
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return err.toString();
  }
  if (typeof err === "symbol") {
    return err.description ? `Symbol(${err.description})` : "Symbol()";
  }
  return "unknown";
}

function isIgnorableSignalTsIncomingError(err: unknown, envelope: Uint8Array): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes("Signal envelope does not contain encrypted content")) {
    return false;
  }
  try {
    const decoded = decodeSignalEnvelope(envelope);
    return Number(decoded.type) === 5 && !decoded.content;
  } catch {
    return false;
  }
}

async function maybeSendSignalTsRetryReceipt({
  client,
  repository,
  err,
  runtime,
  abortSignal,
}: {
  client: SignalTsClient;
  repository: FileSignalRepository;
  err: unknown;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
}): Promise<void> {
  if (!(err instanceof SignalTsDecryptionError) || !err.retryReceipt) {
    return;
  }
  try {
    await client.sendRetryReceiptMessage({
      destination: err.retryReceipt.recipientServiceId,
      retry: err.retryReceipt,
      stores: createLibsignalStores(repository),
      abortSignal,
    });
    logSignalTsInfo(
      `signal-ts: sent retry receipt for ${err.retryReceipt.recipientServiceId}.${err.retryReceipt.senderDeviceId} timestamp=${err.retryReceipt.timestamp}`,
    );
  } catch (retryErr) {
    logSignalTsError(
      runtime,
      `signal-ts retry receipt failed: ${describeSignalTsDisconnectError(retryErr)}`,
    );
  }
}

function resolveSignalTsActiveClientKey(accountInfo: ResolvedSignalAccount): string {
  return resolveSignalTsStatePath(accountInfo);
}

function unregisterSignalTsActiveClient(key: string, activeClient: ActiveSignalTsClient): void {
  if (activeSignalTsClients.get(key) === activeClient) {
    activeSignalTsClients.delete(key);
  }
}

function describeSignalTsIncomingEnvelope(envelope: Uint8Array, timestamp: number): string {
  const parts = [
    `len=${envelope.byteLength}`,
    `serverDelivered=${timestamp}`,
    `prefix=${bytesToHexPrefix(envelope, 12)}`,
  ];
  const direct = tryDescribeSignalTsDecodedEnvelope(envelope);
  parts.push(direct ? `direct=${direct}` : "direct=decode-failed");
  const delimited = tryDescribeDelimitedSignalTsEnvelope(envelope);
  if (delimited) {
    parts.push(`delimited=${delimited}`);
  }
  const shifted = tryDescribeShiftedSignalTsEnvelope(envelope);
  if (shifted) {
    parts.push(`shifted=${shifted}`);
  }
  return `(${parts.join(" ")})`;
}

function tryDescribeDelimitedSignalTsEnvelope(envelope: Uint8Array): string | null {
  const leading = readLeadingVarint(envelope);
  if (!leading || leading.value <= 0 || leading.value > envelope.byteLength - leading.bytesRead) {
    return null;
  }
  const payload = envelope.subarray(leading.bytesRead, leading.bytesRead + leading.value);
  const decoded = tryDescribeSignalTsDecodedEnvelope(payload);
  return decoded ? `varintBytes=${leading.bytesRead} payloadLen=${leading.value} ${decoded}` : null;
}

function tryDescribeShiftedSignalTsEnvelope(envelope: Uint8Array): string | null {
  const maxOffset = Math.min(8, envelope.byteLength - 1);
  for (let offset = 1; offset <= maxOffset; offset += 1) {
    const decoded = tryDescribeSignalTsDecodedEnvelope(envelope.subarray(offset));
    if (decoded) {
      return `offset=${offset} ${decoded}`;
    }
  }
  return null;
}

function tryDescribeSignalTsDecodedEnvelope(envelope: Uint8Array): string | null {
  try {
    return describeSignalTsDecodedEnvelope(decodeSignalEnvelope(envelope));
  } catch {
    return null;
  }
}

function describeSignalTsDecodedEnvelope(envelope: SignalTsEnvelope): string {
  const type = envelope.type ?? 0;
  const typeLabel = SIGNAL_TS_ENVELOPE_TYPE_LABELS[type] ?? `TYPE_${type}`;
  return [
    `type=${typeLabel}`,
    `contentLen=${envelope.content?.byteLength ?? 0}`,
    `source=${envelope.sourceServiceId || envelope.sourceServiceIdBinary ? "yes" : "no"}`,
    `sourceDevice=${envelope.sourceDeviceId ?? "none"}`,
    `destination=${envelope.destinationServiceId || envelope.destinationServiceIdBinary ? "yes" : "no"}`,
    `clientTs=${envelope.clientTimestamp ?? "none"}`,
    `serverTs=${envelope.serverTimestamp ?? "none"}`,
  ].join(",");
}

function readLeadingVarint(bytes: Uint8Array): { value: number; bytesRead: number } | null {
  let value = 0;
  let shift = 0;
  for (let index = 0; index < Math.min(bytes.byteLength, 5); index += 1) {
    const byte = bytes[index];
    value |= (byte & 0x7f) << shift;
    if (byte < 0x80) {
      return { value, bytesRead: index + 1 };
    }
    shift += 7;
  }
  return null;
}

function bytesToHexPrefix(bytes: Uint8Array, maxBytes: number): string {
  return Array.from(bytes.subarray(0, maxBytes), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function resolveSignalTsTarget(
  raw: string,
  repository: FileSignalRepository,
): Promise<SignalRecipientTarget> {
  const parsed = parseSignalRecipientTarget(raw);
  if (parsed.kind === "e164") {
    const recipient = await repository.getRecipientByE164(parsed.e164);
    return recipient?.aci ?? { kind: "e164", e164: parsed.e164 };
  }
  return raw;
}

async function resolveSignalTsGroup(
  raw: string,
  repository: FileSignalRepository,
): Promise<FileSignalGroupState | undefined> {
  const groupId = parseSignalTsGroupTarget(raw);
  if (!groupId) {
    return undefined;
  }
  const group = await repository.getGroup(groupId);
  if (!group) {
    throw new Error(`Signal-ts state is missing group state for ${groupId}`);
  }
  return group;
}

function parseSignalTsGroupTarget(raw: string): string | undefined {
  let value = raw.trim();
  if (!value) {
    return undefined;
  }
  if (/^signal:/i.test(value)) {
    value = value.slice("signal:".length).trim();
  }
  if (!/^group:/i.test(value)) {
    return undefined;
  }
  const groupId = value.slice("group:".length).trim();
  if (!groupId) {
    throw new Error("Signal group id is required");
  }
  return groupId;
}

async function sendSignalTsGroupMessage({
  client,
  repository,
  group,
  traceId,
  body,
  attachments,
  bodyRanges,
  quote,
  abortSignal,
}: {
  client: SignalTsClient;
  repository: FileSignalRepository;
  group: FileSignalGroupState;
  traceId: string;
  body: string;
  attachments?: SignalAttachmentPointer[];
  bodyRanges?: SignalBodyRange[];
  quote?: SignalQuote;
  abortSignal: AbortSignal;
}): Promise<{ timestamp: number }> {
  const members = group.members ?? [];
  if (members.length === 0) {
    throw new Error(`Signal-ts state is missing members for group ${group.id}`);
  }
  const result = await client.sendGroupMessage({
    traceId,
    members,
    group: {
      masterKey: base64ToBytes(group.masterKey),
      distributionId: group.distributionId,
      ...(group.revision !== undefined ? { revision: group.revision } : {}),
    },
    body,
    attachments,
    ...(bodyRanges ? { bodyRanges } : {}),
    ...(quote ? { quote } : {}),
    stores: createLibsignalStores(repository),
    abortSignal,
  });
  return { timestamp: result.timestamp };
}

async function sendSignalTsGroupStickerMessage({
  client,
  repository,
  group,
  traceId,
  sticker,
  abortSignal,
}: {
  client: SignalTsClient;
  repository: FileSignalRepository;
  group: FileSignalGroupState;
  traceId: string;
  sticker: SignalSticker;
  abortSignal: AbortSignal;
}): Promise<{ timestamp: number }> {
  const members = group.members ?? [];
  if (members.length === 0) {
    throw new Error(`Signal-ts state is missing members for group ${group.id}`);
  }
  const result = await client.sendGroupStickerMessage({
    traceId,
    members,
    group: {
      masterKey: base64ToBytes(group.masterKey),
      distributionId: group.distributionId,
      ...(group.revision !== undefined ? { revision: group.revision } : {}),
    },
    sticker,
    stores: createLibsignalStores(repository),
    abortSignal,
  });
  return { timestamp: result.timestamp };
}

async function sendSignalTsGroupReactionMessage({
  client,
  repository,
  group,
  traceId,
  reaction,
  abortSignal,
}: {
  client: SignalTsClient;
  repository: FileSignalRepository;
  group: FileSignalGroupState;
  traceId: string;
  reaction: SignalReaction;
  abortSignal: AbortSignal;
}): Promise<{ timestamp: number }> {
  const members = group.members ?? [];
  if (members.length === 0) {
    throw new Error(`Signal-ts state is missing members for group ${group.id}`);
  }
  const result = await client.sendGroupReactionMessage({
    traceId,
    members,
    group: {
      masterKey: base64ToBytes(group.masterKey),
      distributionId: group.distributionId,
      ...(group.revision !== undefined ? { revision: group.revision } : {}),
    },
    reaction,
    stores: createLibsignalStores(repository),
    abortSignal,
  });
  return { timestamp: result.timestamp };
}

async function resolveSignalTsSticker({
  client,
  repository,
  stickerSpec,
  traceId,
  abortSignal,
}: {
  client: SignalTsClient;
  repository: FileSignalRepository;
  stickerSpec: string;
  traceId: string;
  abortSignal: AbortSignal;
}): Promise<SignalSticker> {
  const { packId, stickerId } = parseSignalTsStickerSpec(stickerSpec);
  const pack = await repository.getStickerPack(packId);
  if (!pack || pack.installed === false) {
    throw new Error(`Signal-ts state is missing installed sticker pack ${packId}`);
  }
  const stickerState = pack.stickers[String(stickerId)];
  if (!stickerState) {
    throw new Error(`Signal-ts sticker pack ${packId} is missing sticker ${stickerId}`);
  }
  const data = new Uint8Array(
    await readFile(repository.getStickerFilePath(pack.id, stickerState.fileName)),
  );
  const uploaded = await client.uploadAttachment({
    traceId: `${traceId}:sticker-upload`,
    attachment: {
      data,
      contentType: stickerState.contentType ?? "image/webp",
    },
    fetch: fetchSignalAttachmentUpload,
    abortSignal,
  });
  const sticker: SignalSticker = {
    packId: hexToBytes(pack.id),
    packKey: base64ToBytes(pack.key),
    stickerId,
    data: uploaded.pointer,
  };
  if (stickerState.emoji) {
    sticker.emoji = stickerState.emoji;
  }
  return sticker;
}

function parseSignalTsStickerSpec(raw: string): { packId: string; stickerId: number } {
  const match = /^\s*([0-9a-fA-F]+):(\d+)\s*$/.exec(raw);
  if (!match) {
    throw new Error("Signal sticker id must be pack-id:sticker-id");
  }
  const packId = match[1].toLowerCase();
  if (packId.length % 2 !== 0) {
    throw new Error("Signal sticker pack id must be even-length hex");
  }
  const stickerId = Number(match[2]);
  if (!Number.isSafeInteger(stickerId) || stickerId < 0) {
    throw new Error("Signal sticker id must be a non-negative integer");
  }
  return { packId, stickerId };
}

async function resolveSignalTsPreKeyAuth(
  raw: string,
  repository: FileSignalRepository,
): Promise<PreKeyAuth | undefined> {
  const recipient = await resolveKnownSignalTsRecipient(raw, repository);
  if (!recipient) {
    return undefined;
  }
  if (recipient.accessKey) {
    return preKeyAuthFromBase64(recipient.accessKey);
  }
  if (recipient.profileKey) {
    const accessKey = deriveAccessKeyBase64FromProfileKeyBase64(recipient.profileKey);
    await repository.setRecipient({ ...recipient, accessKey });
    return preKeyAuthFromBase64(accessKey);
  }
  return undefined;
}

async function resolveSignalTsQuote({
  to,
  replyToId,
  repository,
}: {
  to: string;
  replyToId?: string;
  repository: FileSignalRepository;
}): Promise<SignalQuote | undefined> {
  const id = parseSignalTimestamp(replyToId);
  if (id === undefined) {
    return undefined;
  }
  if (parseSignalTsGroupTarget(to)) {
    return undefined;
  }
  const authorAci = await resolveSignalTsAuthorAci(to, repository);
  if (!authorAci) {
    throw new Error("Signal-ts quote reply requires a known author ACI for the target message");
  }
  return { id, authorAci };
}

async function resolveSignalTsReaction({
  recipient,
  targetTimestamp,
  emoji,
  remove,
  targetAuthor,
  targetAuthorUuid,
  repository,
}: {
  recipient: string;
  targetTimestamp: number;
  emoji: string;
  remove?: boolean;
  targetAuthor?: string;
  targetAuthorUuid?: string;
  repository: FileSignalRepository;
}): Promise<SignalReaction> {
  const authorAci =
    (await resolveSignalTsAuthorAci(targetAuthorUuid, repository)) ??
    (await resolveSignalTsAuthorAci(targetAuthor, repository)) ??
    (await resolveSignalTsAuthorAci(recipient, repository));
  if (!authorAci) {
    throw new Error("Signal-ts reaction requires a known target author ACI");
  }
  return {
    emoji,
    targetAuthorAci: authorAci,
    targetSentTimestamp: targetTimestamp,
    ...(remove ? { remove: true } : {}),
  };
}

async function resolveSignalTsAuthorAci(
  raw: string | undefined,
  repository: FileSignalRepository,
): Promise<string | undefined> {
  const normalized = normalizeSignalTsAci(raw);
  if (normalized) {
    return normalized;
  }
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  const recipient = await resolveKnownSignalTsRecipient(value, repository);
  return normalizeSignalTsAci(recipient?.aci);
}

function parseSignalTimestamp(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return undefined;
  }
  return timestamp;
}

function normalizeSignalTsAci(raw: string | undefined): string | undefined {
  let value = raw?.trim();
  if (!value) {
    return undefined;
  }
  if (/^signal:/i.test(value)) {
    value = value.slice("signal:".length).trim();
  }
  if (/^uuid:/i.test(value)) {
    value = value.slice("uuid:".length).trim();
  } else if (/^aci:/i.test(value)) {
    value = value.slice("aci:".length).trim();
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

async function resolveKnownSignalTsRecipient(
  raw: string,
  repository: FileSignalRepository,
): Promise<FileSignalRecipientState | undefined> {
  const parsed = parseSignalRecipientTarget(raw);
  if (parsed.kind === "e164") {
    return await repository.getRecipientByE164(parsed.e164);
  }
  if (parsed.kind !== "aci") {
    return undefined;
  }
  const aci = typeof parsed.aci === "string" ? parsed.aci : parsed.aci.getServiceIdString();
  return await repository.getRecipientByAci(aci);
}

async function withSignalTsClient<T>(
  params: {
    accountInfo: ResolvedSignalAccount;
    runtime?: RuntimeEnv;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  },
  run: (context: {
    client: SignalTsClient;
    repository: FileSignalRepository;
    abortSignal: AbortSignal;
  }) => Promise<T>,
): Promise<T> {
  const abortSignal =
    params.abortSignal ?? AbortSignal.timeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const activeClient = activeSignalTsClients.get(
    resolveSignalTsActiveClientKey(params.accountInfo),
  );
  if (activeClient) {
    return await run({
      client: activeClient.client,
      repository: activeClient.repository,
      abortSignal,
    });
  }

  const repository = await FileSignalRepository.open(resolveSignalTsStatePath(params.accountInfo));
  const account = await repository.getAccount();
  if (!account) {
    throw new Error("Signal-ts state is missing account data");
  }
  const client = new SignalTsClient({
    account: account.account,
    environment: "production",
    userAgent: account.userAgent ?? "OpenClaw signal-ts",
    ...(() => {
      const logger = createSignalTsLogger(params.runtime);
      return logger ? { logger } : {};
    })(),
  });
  try {
    await client.connect(abortSignal);
    return await run({ client, repository, abortSignal });
  } finally {
    await client.disconnect();
  }
}

async function uploadSignalTsAttachments({
  client,
  attachments,
  traceId,
  abortSignal,
}: {
  client: SignalTsClient;
  attachments: SignalTsAttachmentInput[];
  traceId: string;
  abortSignal: AbortSignal;
}): Promise<SignalAttachmentPointer[] | undefined> {
  if (attachments.length === 0) {
    return undefined;
  }
  const uploaded: SignalAttachmentPointer[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const data = new Uint8Array(await readFile(attachment.path));
    const fileName = attachment.fileName ?? path.basename(attachment.path);
    const result = await client.uploadAttachment({
      traceId: `${traceId}:attachment:${index}`,
      attachment: {
        data,
        ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
        fileName,
      },
      fetch: fetchSignalAttachmentUpload,
      abortSignal,
    });
    uploaded.push(result.pointer);
  }
  return uploaded;
}

function mapTextStyles(styles: SignalTextStyleRange[]): SignalBodyRange[] | undefined {
  if (styles.length === 0) {
    return undefined;
  }
  // Signal TS rich text has produced server-acked messages that real clients did not show.
  // Keep outbound text plain until body range sends have real-client E2E coverage.
  return undefined;
}

async function toSignalCliEnvelope(
  incoming: SignalIncomingMessage,
  repository: FileSignalRepository,
): Promise<SignalEnvelope | null> {
  if (incoming.kind === "sync") {
    return { syncMessage: incoming.syncMessage };
  }
  const sourceUuid = incoming.sender.serviceId;
  const recipient = sourceUuid ? await repository.getRecipientByAci(sourceUuid) : undefined;
  const base: SignalEnvelope = {
    sourceUuid: sourceUuid ?? null,
    sourceNumber: recipient?.e164 ?? null,
    sourceName: recipient?.name ?? null,
    timestamp: incoming.timestamp ?? incoming.serverTimestamp ?? null,
  };
  if (incoming.kind === "data") {
    const dataMessage = signalTsDataMessageToSignalCli(incoming);
    return { ...base, dataMessage };
  }
  if (incoming.kind === "reaction") {
    return {
      ...base,
      reactionMessage: {
        emoji: incoming.reaction.emoji,
        isRemove: incoming.reaction.remove,
        targetAuthorUuid: incoming.reaction.targetAuthorAci,
        targetSentTimestamp: incoming.reaction.targetSentTimestamp,
        groupInfo: incoming.group?.id ? { groupId: incoming.group.id } : undefined,
      },
    };
  }
  if (incoming.kind === "typing" || incoming.kind === "receipt") {
    return null;
  }
  if (incoming.kind === "edit") {
    const dataMessage = incoming.message
      ? signalTsDataMessageToSignalCli({
          ...incoming,
          kind: "data",
          message: incoming.message,
          attachments: incoming.message.attachments ?? [],
          bodyRanges: incoming.message.bodyRanges ?? [],
          body: incoming.message.body,
        })
      : undefined;
    return { ...base, editMessage: dataMessage ? { dataMessage } : null };
  }
  return null;
}

function signalTsDataMessageToSignalCli(
  incoming: Extract<SignalIncomingMessage, { kind: "data" }>,
): SignalDataMessage {
  const dataMessage: SignalDataMessage = {
    timestamp: incoming.timestamp,
    message: incoming.body ?? null,
    attachments: incoming.attachments.map(signalTsAttachmentPointerToSignalCliAttachment),
  };
  if (incoming.group?.id) {
    dataMessage.groupInfo = { groupId: incoming.group.id };
  }
  if (incoming.message.quote) {
    dataMessage.quote = {
      text: incoming.message.quote.text ?? null,
      authorUuid: incoming.message.quote.authorAci ?? null,
    };
  }
  if (incoming.message.reaction) {
    dataMessage.reaction = {
      emoji: incoming.message.reaction.emoji,
      isRemove: incoming.message.reaction.remove,
      targetAuthorUuid: incoming.message.reaction.targetAuthorAci,
      targetSentTimestamp: incoming.message.reaction.targetSentTimestamp,
      groupInfo: incoming.group?.id ? { groupId: incoming.group.id } : undefined,
    };
  }
  if (incoming.message.sticker) {
    dataMessage.sticker = {
      packId: bytesToBase64OrUndefined(incoming.message.sticker.packId) ?? null,
      packKey: bytesToBase64OrUndefined(incoming.message.sticker.packKey) ?? null,
      stickerId: incoming.message.sticker.stickerId ?? null,
    };
  }
  if (incoming.group?.masterKey && !dataMessage.groupInfo?.groupId) {
    dataMessage.groupInfo = { groupId: bytesToBase64(incoming.group.masterKey) };
  }
  return dataMessage;
}

function signalTsAttachmentPointerToSignalCliAttachment(
  pointer: SignalAttachmentPointer,
  index: number,
): SignalAttachment {
  return {
    id: `signal-ts:${pointer.cdnKey ?? pointer.cdnId ?? index}`,
    contentType: pointer.contentType ?? null,
    filename: pointer.fileName ?? null,
    size: pointer.size ?? null,
    signalTsPointer: serializeSignalTsAttachmentPointer(pointer),
  };
}

function serializeSignalTsAttachmentPointer(
  pointer: SignalAttachmentPointer,
): NonNullable<SignalAttachment["signalTsPointer"]> {
  const serialized: NonNullable<SignalAttachment["signalTsPointer"]> = {};
  assignIfDefined(serialized, "cdnId", pointer.cdnId);
  assignIfDefined(serialized, "cdnKey", pointer.cdnKey);
  assignIfDefined(serialized, "clientUuid", bytesToBase64OrUndefined(pointer.clientUuid));
  assignIfDefined(serialized, "key", bytesToBase64OrUndefined(pointer.key));
  assignIfDefined(serialized, "digest", bytesToBase64OrUndefined(pointer.digest));
  assignIfDefined(serialized, "incrementalMac", bytesToBase64OrUndefined(pointer.incrementalMac));
  assignIfDefined(serialized, "contentType", pointer.contentType);
  assignIfDefined(serialized, "size", pointer.size);
  assignIfDefined(serialized, "fileName", pointer.fileName);
  assignIfDefined(serialized, "flags", pointer.flags);
  assignIfDefined(serialized, "width", pointer.width);
  assignIfDefined(serialized, "height", pointer.height);
  assignIfDefined(serialized, "caption", pointer.caption);
  assignIfDefined(serialized, "blurHash", pointer.blurHash);
  assignIfDefined(serialized, "uploadTimestamp", pointer.uploadTimestamp);
  assignIfDefined(serialized, "cdnNumber", pointer.cdnNumber);
  return serialized;
}

function deserializeSignalTsAttachmentPointer(
  pointer: SignalAttachment["signalTsPointer"] | undefined,
): SignalAttachmentPointer | null {
  if (!pointer) {
    return null;
  }
  const parsed: SignalAttachmentPointer = {};
  assignIfDefined(parsed, "cdnId", pointer.cdnId);
  assignIfDefined(parsed, "cdnKey", pointer.cdnKey);
  assignIfDefined(parsed, "clientUuid", base64ToBytesOrUndefined(pointer.clientUuid));
  assignIfDefined(parsed, "key", base64ToBytesOrUndefined(pointer.key));
  assignIfDefined(parsed, "digest", base64ToBytesOrUndefined(pointer.digest));
  assignIfDefined(parsed, "incrementalMac", base64ToBytesOrUndefined(pointer.incrementalMac));
  assignIfDefined(parsed, "contentType", pointer.contentType);
  assignIfDefined(parsed, "size", pointer.size);
  assignIfDefined(parsed, "fileName", pointer.fileName);
  assignIfDefined(parsed, "flags", pointer.flags);
  assignIfDefined(parsed, "width", pointer.width);
  assignIfDefined(parsed, "height", pointer.height);
  assignIfDefined(parsed, "caption", pointer.caption);
  assignIfDefined(parsed, "blurHash", pointer.blurHash);
  assignIfDefined(parsed, "uploadTimestamp", pointer.uploadTimestamp);
  assignIfDefined(parsed, "cdnNumber", pointer.cdnNumber);
  return parsed;
}

function bytesToBase64OrUndefined(bytes: Uint8Array | undefined): string | undefined {
  return bytes ? bytesToBase64(bytes) : undefined;
}

function base64ToBytesOrUndefined(raw: string | undefined): Uint8Array<ArrayBuffer> | undefined {
  return raw ? base64ToBytes(raw) : undefined;
}

function assignIfDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

async function waitForAbort(abortSignal: AbortSignal | undefined): Promise<void> {
  if (!abortSignal) {
    await new Promise(() => {});
    return;
  }
  if (abortSignal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function waitForSignalTsDisconnect(
  client: SignalTsClient,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  if (abortSignal?.aborted) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let offDisconnected: (() => void) | undefined;
    let onAbort: (() => void) | undefined;

    const cleanup = () => {
      offDisconnected?.();
      if (abortSignal && onAbort) {
        abortSignal.removeEventListener("abort", onAbort);
      }
    };

    onAbort = () => {
      cleanup();
      resolve();
    };
    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    offDisconnected = client.on("disconnected", (err) => {
      cleanup();
      reject(err ?? new Error("Signal chat connection interrupted"));
    });
  });
}
