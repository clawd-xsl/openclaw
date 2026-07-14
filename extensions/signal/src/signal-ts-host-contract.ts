/**
 * Structural contract for the host-provided `@openclaw/signal-ts` package.
 *
 * The Signal plugin intentionally does not own where that package is installed
 * or which checkout supplies it. Keep this surface limited to runtime members
 * consumed by the plugin so OpenClaw can type-check without encoding a local
 * filesystem dependency.
 */

export type SignalBytes = Uint8Array<ArrayBuffer>;

export type SignalAccountState = {
  auth: { username: string; password: string };
  device: {
    aci: string;
    e164?: string | null;
    deviceId: number;
    registrationId: number;
  };
  receiveStories?: boolean;
};

export type FileSignalAccountState = {
  account: SignalAccountState;
  pni?: string;
  pniIdentityKeyPrivate?: string;
  profileKey?: string;
  masterKey?: string;
  accountEntropyPool?: string;
  mediaRootBackupKey?: string;
  readReceipts?: boolean;
  deviceName?: string;
  userAgent?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type FileSignalGroupState = {
  id: string;
  masterKey: string;
  distributionId: string;
  revision?: number;
  title?: string;
  members?: string[];
  updatedAt?: number;
};

export type FileSignalRecipientState = {
  aci: string;
  e164?: string | null;
  profileKey?: string;
  accessKey?: string;
  profileUnidentifiedAccessMode?: string;
  name?: string;
  updatedAt?: number;
};

export type FileSignalStickerPackState = {
  id: string;
  key: string;
  installed?: boolean;
  stickers: Record<
    string,
    {
      id: number;
      fileName: string;
      emoji?: string;
      contentType?: string;
      size?: number;
    }
  >;
};

export interface FileSignalRepository {
  getAccount(): Promise<FileSignalAccountState | undefined>;
  getGroup(id: string): Promise<FileSignalGroupState | undefined>;
  getRecipientByAci(aci: string): Promise<FileSignalRecipientState | undefined>;
  getRecipientByE164(e164: string): Promise<FileSignalRecipientState | undefined>;
  setRecipient(recipient: FileSignalRecipientState): Promise<void>;
  getStickerPack(id: string): Promise<FileSignalStickerPackState | undefined>;
  getStickerFilePath(packId: string, fileName: string): string;
}

export interface FileSignalRepositoryConstructor {
  open(filePath: string): Promise<FileSignalRepository>;
}

export type PreKeyAuth = { kind: "unrestricted" } | { kind: "access-key"; accessKey: SignalBytes };

export type SignalServiceIdLike = { getServiceIdString(): string };

export type SignalRecipientTarget =
  | SignalServiceIdLike
  | string
  | { kind: "aci"; aci: string | SignalServiceIdLike }
  | { kind: "e164"; e164: string }
  | { kind: "username"; username: string };

export type ParsedSignalRecipientTarget =
  | { kind: "aci"; aci: string | SignalServiceIdLike }
  | { kind: "e164"; e164: string }
  | { kind: "username"; username: string };

export type SignalAttachmentPointer = {
  cdnId?: number;
  cdnKey?: string;
  clientUuid?: SignalBytes;
  contentType?: string;
  key?: SignalBytes;
  size?: number;
  thumbnail?: SignalBytes;
  digest?: SignalBytes;
  incrementalMac?: SignalBytes;
  chunkSize?: number;
  fileName?: string;
  flags?: number;
  width?: number;
  height?: number;
  caption?: string;
  blurHash?: string;
  uploadTimestamp?: number;
  cdnNumber?: number;
};

export type SignalBodyRange = {
  start?: number;
  length?: number;
  mentionAci?: string;
  mentionAciBinary?: SignalBytes;
  style?: number;
};

export type SignalQuote = {
  id?: number;
  authorAci?: string;
  text?: string;
  attachments?: Array<Record<string, unknown>>;
  bodyRanges?: SignalBodyRange[];
  type?: number;
  authorAciBinary?: SignalBytes;
};

export type SignalReaction = {
  emoji?: string;
  remove?: boolean;
  targetAuthorAci?: string;
  targetAuthorAciBinary?: SignalBytes;
  targetSentTimestamp?: number;
};

export type SignalSticker = {
  packId?: SignalBytes;
  packKey?: SignalBytes;
  stickerId?: number;
  data?: SignalAttachmentPointer;
  emoji?: string;
};

export type SignalDataMessage = {
  body?: string;
  attachments?: SignalAttachmentPointer[];
  bodyRanges?: SignalBodyRange[];
  quote?: SignalQuote;
  reaction?: SignalReaction;
  sticker?: SignalSticker;
};

export type SignalEnvelope = {
  type?: number;
  sourceServiceId?: string;
  sourceDeviceId?: number;
  destinationServiceId?: string;
  clientTimestamp?: number;
  content?: SignalBytes;
  serverGuid?: string;
  serverTimestamp?: number;
  urgent?: boolean;
  sourceServiceIdBinary?: SignalBytes;
  destinationServiceIdBinary?: SignalBytes;
};

type SignalIncomingBase = {
  envelope: SignalEnvelope;
  sender: { serviceId?: string; deviceId?: number };
  timestamp?: number;
  serverTimestamp?: number;
};

type SignalIncomingGroup = {
  id?: string;
  masterKey?: SignalBytes;
  revision?: number;
  groupChange?: SignalBytes;
};

export type SignalIncomingMessage =
  | (SignalIncomingBase & {
      kind: "data";
      message: SignalDataMessage;
      body?: string;
      attachments: SignalAttachmentPointer[];
      bodyRanges: SignalBodyRange[];
      group?: SignalIncomingGroup;
    })
  | (SignalIncomingBase & {
      kind: "reaction";
      reaction: SignalReaction;
      group?: SignalIncomingGroup;
    })
  | (SignalIncomingBase & {
      kind: "edit";
      targetSentTimestamp?: number;
      message?: SignalDataMessage;
      group?: SignalIncomingGroup;
    })
  | (SignalIncomingBase & {
      kind: "receipt";
      receipt: { type?: "delivery" | "read" | "viewed"; timestamps?: number[] };
    })
  | (SignalIncomingBase & {
      kind: "typing";
      typing: { timestamp?: number; action?: "started" | "stopped"; groupId?: SignalBytes };
      group?: SignalIncomingGroup;
    })
  | (SignalIncomingBase & { kind: "sync"; syncMessage: Record<string, unknown> })
  | (SignalIncomingBase & {
      kind: "decryption-error";
      decryptionError: { timestamp: number; deviceId: number; ratchetKey?: SignalBytes };
    })
  | (SignalIncomingBase & { kind: "call"; call: SignalCallMessage })
  | (SignalIncomingBase & { kind: "unknown"; content: Record<string, unknown> });

export type SignalIncomingEnvelope = {
  envelope: SignalBytes;
  timestamp: number;
  ack: () => void;
};

export type SignalRetryReceiptRequest = {
  recipientServiceId: string;
  senderDeviceId: number;
  timestamp: number;
  ciphertextType: number;
  originalContent: SignalBytes;
  groupId?: SignalBytes;
};

export interface SignalTsDecryptionError extends Error {
  readonly retryReceipt: SignalRetryReceiptRequest | undefined;
}

export type SignalTsDecryptionErrorConstructor = new (
  message: string,
  options: { cause: unknown; retryReceipt?: SignalRetryReceiptRequest },
) => SignalTsDecryptionError;

type SignalSendResult = Promise<{ timestamp: number }>;
type SignalGroupSendResult = Promise<{ timestamp: number; recipients: number }>;

export interface SignalTsClient {
  connect(abortSignal?: AbortSignal): Promise<void>;
  disconnect(): Promise<void>;
  on(event: "incoming", handler: (incoming: SignalIncomingEnvelope) => void): () => void;
  on(event: "disconnected", handler: (error: Error | null) => void): () => void;
  on(event: "queueEmpty", handler: () => void): () => void;
  sendMessage(params: Record<string, unknown>): SignalSendResult;
  sendStickerMessage(params: Record<string, unknown>): SignalSendResult;
  sendReactionMessage(params: Record<string, unknown>): SignalSendResult;
  sendReceiptMessage(params: Record<string, unknown>): SignalSendResult;
  sendTypingMessage(params: Record<string, unknown>): SignalSendResult;
  sendRetryReceiptMessage(params: Record<string, unknown>): SignalSendResult;
  sendGroupMessage(params: Record<string, unknown>): SignalGroupSendResult;
  sendGroupStickerMessage(params: Record<string, unknown>): SignalGroupSendResult;
  sendGroupReactionMessage(params: Record<string, unknown>): SignalGroupSendResult;
  uploadAttachment(params: Record<string, unknown>): Promise<{ pointer: SignalAttachmentPointer }>;
}

export type SignalTsClientConstructor = new (options: {
  account: SignalAccountState;
  environment?: "production" | "staging";
  userAgent?: string;
  receiveStories?: boolean;
  logger?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string, error?: unknown) => void;
  };
}) => SignalTsClient;

export type SignalLibsignalStores = Record<string, unknown>;
export type SignalLocalAddress = object;
export type SignalFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

// --- Calling (1:1 voice) -------------------------------------------------
// callIds are random 64-bit values and stay bigint end to end; never narrow them.

export type SignalCallMessage = {
  offer?: { callId: bigint; type: "audio" | "video"; opaque: SignalBytes };
  answer?: { callId: bigint; opaque: SignalBytes };
  iceUpdate?: Array<{ callId: bigint; opaque: SignalBytes }>;
  busy?: { callId: bigint };
  hangup?: {
    callId: bigint;
    type: "normal" | "accepted" | "declined" | "busy" | "need-permission";
    deviceId: number;
  };
  opaque?: { data: SignalBytes; urgency?: "droppable" | "handle-immediately" };
  destinationDeviceId?: number;
};

export type SignalCallPeer = { aci: string; deviceId: number };

export type SignalCallAudioBridge = {
  readonly format: {
    readonly sampleRateHz: 48000;
    readonly channels: 2;
    readonly encoding: "s16le";
  };
  readonly mic: NodeJS.WritableStream;
  readonly ear: NodeJS.ReadableStream;
  close(): Promise<void>;
};

export type SignalCallEvent =
  | { type: "incoming"; callId: bigint; peer: SignalCallPeer; isVideoCall: boolean }
  | { type: "outgoing"; callId: bigint; peer: SignalCallPeer }
  | {
      type: "state";
      callId: bigint;
      direction: "incoming" | "outgoing";
      peer: SignalCallPeer;
      state: "idle" | "ringing" | "connecting" | "connected" | "ended";
    }
  | { type: "connected"; callId: bigint; peer: SignalCallPeer; audio: SignalCallAudioBridge }
  | { type: "ended"; callId: bigint; peer: SignalCallPeer; reason: string }
  | { type: "busy"; peer: SignalCallPeer }
  | { type: "error"; callId?: bigint; error: Error };

export interface SignalCallManager {
  on(listener: (event: SignalCallEvent) => void): () => void;
  readonly activeCallId: bigint | null;
  isBusy(): boolean;
  ensureReady(): Promise<void>;
  handleIncomingCallMessage(params: {
    call: SignalCallMessage;
    sender: SignalCallPeer;
    ageSec: number;
    receivedAtCounter: number;
    receivedAtDate: number;
  }): Promise<void>;
  accept(callId: bigint): Promise<void>;
  decline(callId: bigint): Promise<void>;
  hangup(callId?: bigint): Promise<void>;
  startOutgoingCall(params: { recipientAci: string }): Promise<{ callId: bigint }>;
  close(): Promise<void>;
}

export type CreateSignalCallManagerParams = {
  client: SignalTsClient;
  account: SignalAccountState;
  stores: SignalLibsignalStores;
  // Per-recipient prekey auth (access key) for call signaling sends; without it
  // the prekey fetch before the first signaling send is RequestUnauthorized.
  resolvePreKeyAuth?: (recipientAci: string) => Promise<PreKeyAuth | undefined>;
  config?: {
    hideIp?: boolean;
    dataMode?: "low" | "normal";
    outgoingRingTimeoutMs?: number;
    maxCallDurationMs?: number;
    pulse?: { pactlPath?: string; pacatPath?: string };
  };
  logger?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string, error?: unknown) => void;
  };
};

export declare function createSignalCallManager(
  params: CreateSignalCallManagerParams,
): SignalCallManager;
export declare function base64ToBytes(value: string): SignalBytes;
export declare function bytesToBase64(bytes: Uint8Array): string;
export declare function hexToBytes(value: string): SignalBytes;
export declare function deriveAccessKeyBase64FromProfileKeyBase64(profileKeyBase64: string): string;
export declare function parseSignalRecipientTarget(
  target: SignalRecipientTarget,
): ParsedSignalRecipientTarget;
export declare function preKeyAuthFromBase64(accessKeyBase64?: string | null): PreKeyAuth;
export declare function createLibsignalStores(
  repository: FileSignalRepository,
): SignalLibsignalStores;
export declare function createSignalLocalAddress(account: SignalAccountState): SignalLocalAddress;
export declare function decodeSignalEnvelope(bytes: Uint8Array): SignalEnvelope;
export declare function decryptIncomingEnvelope(params: Record<string, unknown>): Promise<unknown>;
export declare function normalizeDecryptedIncomingMessage(
  message: unknown,
): SignalIncomingMessage[];
export declare function downloadSignalAttachment(params: {
  pointer: SignalAttachmentPointer;
  fetch?: SignalFetch;
  abortSignal?: AbortSignal;
}): Promise<SignalBytes>;
export declare const signalAttachmentFetch: SignalFetch;
