import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FileSignalRepository,
  SignalTsClient,
  base64ToBytes,
  bytesToBase64,
  createSignalLocalAddress,
  createLibsignalStores,
  decodeSignalEnvelope,
  decryptIncomingEnvelope,
  deriveAccessKeyBase64FromProfileKeyBase64,
  downloadSignalAttachment,
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
  type SignalRecipientTarget,
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
import type { ResolvedSignalAccount } from "./accounts.js";
import type { SignalTextStyleRange } from "./format.js";
import type {
  SignalAttachment,
  SignalDataMessage,
  SignalEnvelope,
  SignalReceivePayload,
} from "./monitor/event-handler.types.js";

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
  textStyles?: SignalTextStyleRange[];
  attachments?: SignalTsAttachmentInput[];
  timeoutMs?: number;
  abortSignal?: AbortSignal;
};

export type SignalTsRpcLikeParams = {
  accountInfo: ResolvedSignalAccount;
  to: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
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

export async function sendMessageSignalTs(params: SignalTsSendParams): Promise<{
  messageId: string;
  timestamp: number;
}> {
  return await withSignalTsClient(params, async ({ client, repository, abortSignal }) => {
    const attachments = await uploadSignalTsAttachments({
      client,
      attachments: params.attachments ?? [],
      abortSignal,
    });
    const bodyRanges = mapTextStyles(params.textStyles ?? []);
    const group = await resolveSignalTsGroup(params.to, repository);
    if (group) {
      const result = await sendSignalTsGroupMessage({
        client,
        repository,
        group,
        body: params.message,
        attachments,
        bodyRanges,
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
      destination: target,
      body: params.message,
      attachments,
      bodyRanges,
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
  const pointer = deserializeSignalTsAttachmentPointer(params.attachment.signalTsPointer);
  if (!pointer) {
    return null;
  }
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
    abortSignal: params.abortSignal,
  });
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
  return { path: saved.path, contentType: saved.contentType };
}

export async function sendTypingSignalTs(
  params: SignalTsRpcLikeParams & { stop?: boolean },
): Promise<boolean> {
  return await withSignalTsClient(params, async ({ client, repository, abortSignal }) => {
    const target = await resolveSignalTsTarget(params.to, repository);
    const preKeyAuth = await resolveSignalTsPreKeyAuth(params.to, repository);
    await client.sendTypingMessage({
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
  return await withSignalTsClient(params, async ({ client, repository, abortSignal }) => {
    const target = await resolveSignalTsTarget(params.to, repository);
    const preKeyAuth = await resolveSignalTsPreKeyAuth(params.to, repository);
    await client.sendReceiptMessage({
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
      params.runtime.error?.(message);
      await emitSignalTsFatalDiagnostic({
        params,
        message,
        envelope: result.diagnosticEnvelope,
      });
      throw result.fatalError;
    }
    reconnectAttempts += 1;
    const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
    const reason = result.error ? `: ${describeSignalTsDisconnectError(result.error)}` : "";
    params.runtime.error?.(
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
    logger: {
      info: (message) => params.runtime.log?.(`signal-ts: ${message}`),
      warn: (message) => params.runtime.error?.(`signal-ts: ${message}`),
    },
  });
  const activeClientKey = resolveSignalTsActiveClientKey(params.accountInfo);
  const activeClient: ActiveSignalTsClient = { client, repository };
  let latestDiagnosticEnvelope: SignalEnvelope | undefined;
  const offIncoming = client.on("incoming", (incoming) => {
    void (async () => {
      try {
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
        for (const message of normalizeDecryptedIncomingMessage(decrypted)) {
          const envelope = await toSignalCliEnvelope(message, repository);
          if (!envelope) {
            continue;
          }
          latestDiagnosticEnvelope = envelope;
          const payload: SignalReceivePayload = { envelope };
          await params.onEvent({ event: "receive", data: JSON.stringify(payload) });
        }
      } catch (err) {
        if (isIgnorableSignalTsIncomingError(err, incoming.envelope)) {
          return;
        }
        params.runtime.error?.(
          `signal-ts inbound failed: ${String(err)} ${describeSignalTsIncomingEnvelope(
            incoming.envelope,
            incoming.timestamp,
          )}`,
        );
      } finally {
        try {
          await Promise.resolve((incoming.ack as () => unknown)());
        } catch (err) {
          params.runtime.error?.(`signal-ts inbound ack failed: ${String(err)}`);
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

async function emitSignalTsFatalDiagnostic({
  params,
  message,
  envelope,
}: {
  params: SignalTsMonitorParams;
  message: string;
  envelope: SignalEnvelope | undefined;
}): Promise<void> {
  if (!envelope) {
    params.runtime.error?.(`signal-ts fatal diagnostic skipped: no previous Signal envelope`);
    return;
  }
  const timestamp = Date.now();
  const groupInfo = resolveSignalTsDiagnosticGroupInfo(envelope);
  const diagnosticEnvelope: SignalEnvelope = {
    sourceNumber: envelope.sourceNumber ?? null,
    sourceUuid: envelope.sourceUuid ?? null,
    sourceName: envelope.sourceName ?? null,
    timestamp,
    dataMessage: {
      timestamp,
      message,
      ...(groupInfo ? { groupInfo } : {}),
    },
  };
  await params.onEvent({
    event: "receive",
    data: JSON.stringify({ envelope: diagnosticEnvelope } satisfies SignalReceivePayload),
  });
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
  body,
  attachments,
  bodyRanges,
  abortSignal,
}: {
  client: SignalTsClient;
  repository: FileSignalRepository;
  group: FileSignalGroupState;
  body: string;
  attachments?: SignalAttachmentPointer[];
  bodyRanges?: SignalBodyRange[];
  abortSignal: AbortSignal;
}): Promise<{ timestamp: number }> {
  const members = group.members ?? [];
  if (members.length === 0) {
    throw new Error(`Signal-ts state is missing members for group ${group.id}`);
  }
  const result = await client.sendGroupMessage({
    members,
    group: {
      masterKey: base64ToBytes(group.masterKey),
      distributionId: group.distributionId,
      ...(group.revision !== undefined ? { revision: group.revision } : {}),
    },
    body,
    attachments,
    bodyRanges,
    stores: createLibsignalStores(repository),
    abortSignal,
  });
  return { timestamp: result.timestamp };
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
  params: { accountInfo: ResolvedSignalAccount; timeoutMs?: number; abortSignal?: AbortSignal },
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
  abortSignal,
}: {
  client: SignalTsClient;
  attachments: SignalTsAttachmentInput[];
  abortSignal: AbortSignal;
}): Promise<SignalAttachmentPointer[] | undefined> {
  if (attachments.length === 0) {
    return undefined;
  }
  const uploaded: SignalAttachmentPointer[] = [];
  for (const attachment of attachments) {
    const data = new Uint8Array(await readFile(attachment.path));
    const fileName = attachment.fileName ?? path.basename(attachment.path);
    const result = await client.uploadAttachment({
      attachment: {
        data,
        ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
        fileName,
      },
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
  return styles.map((style) => ({
    start: style.start,
    length: style.length,
    style: signalBodyRangeStyle(style.style),
  }));
}

function signalBodyRangeStyle(style: SignalTextStyleRange["style"]): number {
  switch (style) {
    case "BOLD":
      return 1;
    case "ITALIC":
      return 2;
    case "SPOILER":
      return 3;
    case "STRIKETHROUGH":
      return 4;
    case "MONOSPACE":
      return 5;
  }
  return 0;
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
