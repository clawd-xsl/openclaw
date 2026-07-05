import {
  FileSignalRepository,
  base64ToBytes,
  bytesToBase64,
  decodeSignalEnvelope,
  type SignalAttachmentPointer,
  type SignalEnvelope as SignalTsEnvelope,
  type SignalIncomingMessage,
} from "@openclaw/signal-ts";
import type {
  SignalAttachment,
  SignalDataMessage,
  SignalEnvelope,
} from "./monitor/event-handler.types.js";

const SIGNAL_TS_ENVELOPE_TYPE_LABELS: Record<number, string> = {
  0: "UNKNOWN",
  1: "DOUBLE_RATCHET",
  3: "PREKEY_MESSAGE",
  5: "SERVER_DELIVERY_RECEIPT",
  6: "UNIDENTIFIED_SENDER",
  8: "PLAINTEXT_CONTENT",
};

export function describeSignalTsIncomingMessage(message: SignalIncomingMessage): string {
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
          textChars: message.message.quote.text?.length ?? 0,
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
    fileNameChars: pointer.fileName?.length ?? 0,
    captionChars: pointer.caption?.length ?? 0,
    width: pointer.width ?? null,
    height: pointer.height ?? null,
    flags: pointer.flags ?? null,
    hasKey: Boolean(pointer.key),
    hasDigest: Boolean(pointer.digest),
    hasIncrementalMac: Boolean(pointer.incrementalMac),
  };
}

export function describeSignalTsIncomingEnvelope(envelope: Uint8Array, timestamp: number): string {
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

export async function toSignalCliEnvelope(
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

export function deserializeSignalTsAttachmentPointer(
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
