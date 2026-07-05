/**
 * Lazy transport facade used by the Signal channel integration.
 *
 * Keep protocol state/client ownership, outbound encryption, and inbound
 * decrypt/normalization in separate modules so callers load one stable seam.
 */
export {
  isSignalTsBackend,
  probeSignalTsAccount,
  resolveSignalTsStatePath,
} from "./signal-ts-client.js";
export {
  fetchSignalTsAttachment,
  monitorSignalTsProvider,
  type SignalTsFetchAttachmentParams,
  type SignalTsMonitorParams,
} from "./signal-ts-inbound.js";
export {
  sendMessageSignalTs,
  sendReactionSignalTs,
  sendReadReceiptSignalTs,
  sendStickerSignalTs,
  sendTypingSignalTs,
  type SignalTsAttachmentInput,
  type SignalTsReactionParams,
  type SignalTsRpcLikeParams,
  type SignalTsSendParams,
  type SignalTsStickerParams,
} from "./signal-ts-outbound.js";
