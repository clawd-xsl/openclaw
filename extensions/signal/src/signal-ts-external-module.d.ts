declare module "@openclaw/signal-ts" {
  type Contract = typeof import("./signal-ts-host-contract.js");

  export const FileSignalRepository: import("./signal-ts-host-contract.js").FileSignalRepositoryConstructor;
  export type FileSignalRepository = import("./signal-ts-host-contract.js").FileSignalRepository;
  export const SignalTsClient: import("./signal-ts-host-contract.js").SignalTsClientConstructor;
  export type SignalTsClient = import("./signal-ts-host-contract.js").SignalTsClient;
  export const SignalTsDecryptionError: import("./signal-ts-host-contract.js").SignalTsDecryptionErrorConstructor;
  export type SignalTsDecryptionError =
    import("./signal-ts-host-contract.js").SignalTsDecryptionError;

  export type FileSignalAccountState =
    import("./signal-ts-host-contract.js").FileSignalAccountState;
  export type FileSignalGroupState = import("./signal-ts-host-contract.js").FileSignalGroupState;
  export type FileSignalRecipientState =
    import("./signal-ts-host-contract.js").FileSignalRecipientState;
  export type PreKeyAuth = import("./signal-ts-host-contract.js").PreKeyAuth;
  export type SignalAttachmentPointer =
    import("./signal-ts-host-contract.js").SignalAttachmentPointer;
  export type SignalBodyRange = import("./signal-ts-host-contract.js").SignalBodyRange;
  export type SignalEnvelope = import("./signal-ts-host-contract.js").SignalEnvelope;
  export type SignalIncomingMessage = import("./signal-ts-host-contract.js").SignalIncomingMessage;
  export type SignalQuote = import("./signal-ts-host-contract.js").SignalQuote;
  export type SignalReaction = import("./signal-ts-host-contract.js").SignalReaction;
  export type SignalRecipientTarget = import("./signal-ts-host-contract.js").SignalRecipientTarget;
  export type SignalSticker = import("./signal-ts-host-contract.js").SignalSticker;

  export const createSignalCallManager: Contract["createSignalCallManager"];
  export type SignalAccountState = import("./signal-ts-host-contract.js").SignalAccountState;
  export type SignalLibsignalStores = import("./signal-ts-host-contract.js").SignalLibsignalStores;
  export type SignalCallManager = import("./signal-ts-host-contract.js").SignalCallManager;
  export type SignalCallEvent = import("./signal-ts-host-contract.js").SignalCallEvent;
  export type SignalCallAudioBridge = import("./signal-ts-host-contract.js").SignalCallAudioBridge;
  export type SignalCallMessage = import("./signal-ts-host-contract.js").SignalCallMessage;
  export type SignalCallPeer = import("./signal-ts-host-contract.js").SignalCallPeer;
  export type CreateSignalCallManagerParams =
    import("./signal-ts-host-contract.js").CreateSignalCallManagerParams;

  export const base64ToBytes: Contract["base64ToBytes"];
  export const bytesToBase64: Contract["bytesToBase64"];
  export const createLibsignalStores: Contract["createLibsignalStores"];
  export const createSignalLocalAddress: Contract["createSignalLocalAddress"];
  export const decodeSignalEnvelope: Contract["decodeSignalEnvelope"];
  export const decryptIncomingEnvelope: Contract["decryptIncomingEnvelope"];
  export const deriveAccessKeyBase64FromProfileKeyBase64: Contract["deriveAccessKeyBase64FromProfileKeyBase64"];
  export const downloadSignalAttachment: Contract["downloadSignalAttachment"];
  export const hexToBytes: Contract["hexToBytes"];
  export const normalizeDecryptedIncomingMessage: Contract["normalizeDecryptedIncomingMessage"];
  export const parseSignalRecipientTarget: Contract["parseSignalRecipientTarget"];
  export const preKeyAuthFromBase64: Contract["preKeyAuthFromBase64"];
  export const signalAttachmentFetch: Contract["signalAttachmentFetch"];
}
