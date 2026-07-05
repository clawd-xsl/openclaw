import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  FileSignalRepository,
  SignalTsClient,
  base64ToBytes,
  createLibsignalStores,
  hexToBytes,
  signalAttachmentFetch,
  type FileSignalGroupState,
  type SignalAttachmentPointer,
  type SignalBodyRange,
  type SignalQuote,
  type SignalReaction,
  type SignalSticker,
} from "@openclaw/signal-ts";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { sleepWithAbort, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { ResolvedSignalAccount } from "./accounts.js";
import type { SignalTextStyleRange } from "./format.js";
import {
  createSignalTsRuntimeTraceId,
  describeSignalTsDisconnectError,
  isRetryableSignalTsSendError,
  logSignalTsWarn,
  resolveSignalTsGroup,
  resolveSignalTsPreKeyAuth,
  resolveSignalTsQuote,
  resolveSignalTsReaction,
  resolveSignalTsTarget,
  withSignalTsClient,
} from "./signal-ts-client.js";

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
  quoteAuthor?: string;
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

const SIGNAL_TS_SEND_RETRY_DELAYS_MS = [750, 2_000] as const;

async function sendSignalTsContentWithRetry<T>({
  traceId,
  operation,
  runtime,
  abortSignal,
  send,
}: {
  traceId: string;
  operation: string;
  runtime?: RuntimeEnv;
  abortSignal: AbortSignal;
  send: (timestamp: number) => Promise<T>;
}): Promise<T> {
  // Reuse the timestamp across retries so an ACK-lost first attempt and a retry
  // identify the same logical Signal send.
  const timestamp = Date.now();
  const runAttempt = async (retryIndex: number): Promise<T> => {
    try {
      return await send(timestamp);
    } catch (err) {
      const retryDelayMs = SIGNAL_TS_SEND_RETRY_DELAYS_MS[retryIndex];
      if (retryDelayMs === undefined || abortSignal.aborted || !isRetryableSignalTsSendError(err)) {
        throw err;
      }
      const maxAttempts = SIGNAL_TS_SEND_RETRY_DELAYS_MS.length + 1;
      logSignalTsWarn(
        runtime,
        `signal-ts ${traceId} ${operation} transient failure; retry ${retryIndex + 2}/${maxAttempts} in ${retryDelayMs}ms: ${describeSignalTsDisconnectError(err)}`,
      );
      await sleepWithAbort(retryDelayMs, abortSignal);
      return await runAttempt(retryIndex + 1);
    }
  };
  return await runAttempt(0);
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
      quoteAuthor: params.quoteAuthor,
      repository,
    });
    const group = await resolveSignalTsGroup(params.to, repository);
    if (group) {
      const result = await sendSignalTsGroupMessage({
        client,
        repository,
        group,
        traceId,
        runtime: params.runtime,
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
    const result = await sendSignalTsContentWithRetry({
      traceId,
      operation: "message",
      runtime: params.runtime,
      abortSignal,
      send: async (timestamp) =>
        await client.sendMessage({
          traceId,
          timestamp,
          destination: target,
          body: params.message,
          attachments,
          ...(bodyRanges ? { bodyRanges } : {}),
          ...(quote ? { quote } : {}),
          stores: createLibsignalStores(repository),
          ...(preKeyAuth ? { preKeyAuth } : {}),
          abortSignal,
        }),
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
        runtime: params.runtime,
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
    const result = await sendSignalTsContentWithRetry({
      traceId,
      operation: "sticker",
      runtime: params.runtime,
      abortSignal,
      send: async (timestamp) =>
        await client.sendStickerMessage({
          traceId,
          timestamp,
          destination: target,
          sticker,
          stores: createLibsignalStores(repository),
          ...(preKeyAuth ? { preKeyAuth } : {}),
          abortSignal,
        }),
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
        runtime: params.runtime,
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
    const result = await sendSignalTsContentWithRetry({
      traceId,
      operation: "reaction",
      runtime: params.runtime,
      abortSignal,
      send: async (timestamp) =>
        await client.sendReactionMessage({
          traceId,
          timestamp,
          destination: target,
          reaction,
          stores: createLibsignalStores(repository),
          ...(preKeyAuth ? { preKeyAuth } : {}),
          abortSignal,
        }),
    });
    return {
      messageId: String(result.timestamp),
      timestamp: result.timestamp,
    };
  });
}

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

async function sendSignalTsGroupMessage({
  client,
  repository,
  group,
  traceId,
  runtime,
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
  runtime?: RuntimeEnv;
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
  const result = await sendSignalTsContentWithRetry({
    traceId,
    operation: "group-message",
    runtime,
    abortSignal,
    send: async (timestamp) =>
      await client.sendGroupMessage({
        traceId,
        timestamp,
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
      }),
  });
  return { timestamp: result.timestamp };
}

async function sendSignalTsGroupStickerMessage({
  client,
  repository,
  group,
  traceId,
  runtime,
  sticker,
  abortSignal,
}: {
  client: SignalTsClient;
  repository: FileSignalRepository;
  group: FileSignalGroupState;
  traceId: string;
  runtime?: RuntimeEnv;
  sticker: SignalSticker;
  abortSignal: AbortSignal;
}): Promise<{ timestamp: number }> {
  const members = group.members ?? [];
  if (members.length === 0) {
    throw new Error(`Signal-ts state is missing members for group ${group.id}`);
  }
  const result = await sendSignalTsContentWithRetry({
    traceId,
    operation: "group-sticker",
    runtime,
    abortSignal,
    send: async (timestamp) =>
      await client.sendGroupStickerMessage({
        traceId,
        timestamp,
        members,
        group: {
          masterKey: base64ToBytes(group.masterKey),
          distributionId: group.distributionId,
          ...(group.revision !== undefined ? { revision: group.revision } : {}),
        },
        sticker,
        stores: createLibsignalStores(repository),
        abortSignal,
      }),
  });
  return { timestamp: result.timestamp };
}

async function sendSignalTsGroupReactionMessage({
  client,
  repository,
  group,
  traceId,
  runtime,
  reaction,
  abortSignal,
}: {
  client: SignalTsClient;
  repository: FileSignalRepository;
  group: FileSignalGroupState;
  traceId: string;
  runtime?: RuntimeEnv;
  reaction: SignalReaction;
  abortSignal: AbortSignal;
}): Promise<{ timestamp: number }> {
  const members = group.members ?? [];
  if (members.length === 0) {
    throw new Error(`Signal-ts state is missing members for group ${group.id}`);
  }
  const result = await sendSignalTsContentWithRetry({
    traceId,
    operation: "group-reaction",
    runtime,
    abortSignal,
    send: async (timestamp) =>
      await client.sendGroupReactionMessage({
        traceId,
        timestamp,
        members,
        group: {
          masterKey: base64ToBytes(group.masterKey),
          distributionId: group.distributionId,
          ...(group.revision !== undefined ? { revision: group.revision } : {}),
        },
        reaction,
        stores: createLibsignalStores(repository),
        abortSignal,
      }),
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
    fetch: signalAttachmentFetch,
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
      fetch: signalAttachmentFetch,
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
