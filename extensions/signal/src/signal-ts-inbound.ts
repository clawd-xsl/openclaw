import {
  FileSignalRepository,
  SignalTsClient,
  SignalTsDecryptionError,
  createLibsignalStores,
  createSignalLocalAddress,
  decodeSignalEnvelope,
  decryptIncomingEnvelope,
  downloadSignalAttachment,
  normalizeDecryptedIncomingMessage,
  signalAttachmentFetch,
} from "@openclaw/signal-ts";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import {
  computeBackoff,
  sleepWithAbort,
  type BackoffPolicy,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import type { ResolvedSignalAccount } from "./accounts.js";
import type {
  SignalAttachment,
  SignalDataMessage,
  SignalEnvelope,
  SignalReceivePayload,
} from "./monitor/event-handler.types.js";
import {
  createSignalTsClientContext,
  createSignalTsRuntimeTraceId,
  describeSignalTsDisconnectError,
  isFatalSignalTsDisconnect,
  logSignalTsError,
  logSignalTsInfo,
  registerSignalTsActiveClient,
  unregisterSignalTsActiveClient,
} from "./signal-ts-client.js";
import {
  describeSignalTsIncomingEnvelope,
  describeSignalTsIncomingMessage,
  deserializeSignalTsAttachmentPointer,
  toSignalCliEnvelope,
} from "./signal-ts-envelope.js";
import { sendMessageSignalTs } from "./signal-ts-outbound.js";
import { startSignalVoiceRuntime, type SignalVoiceRuntime } from "./voice/call-runtime.js";

export type SignalTsMonitorParams = {
  accountInfo: ResolvedSignalAccount;
  // Only consulted to bring up the opt-in voice runtime (agent routing + realtime
  // consult). Text monitoring does not need it, so it stays optional for callers
  // (probe/tests) that never enable voice.
  cfg?: OpenClawConfig;
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

export async function fetchSignalTsAttachment(
  params: SignalTsFetchAttachmentParams,
): Promise<{ path: string; contentType?: string } | null> {
  const traceId = createSignalTsRuntimeTraceId("openclaw-signal-fetch-attachment");
  const pointer = deserializeSignalTsAttachmentPointer(params.attachment.signalTsPointer);
  if (!pointer) {
    logSignalTsInfo(
      params.runtime,
      `signal-ts ${traceId} attachment-fetch skipped: missing signal-ts pointer id=${params.attachment.id ?? "unknown"}`,
    );
    return null;
  }
  logSignalTsInfo(
    params.runtime,
    `signal-ts ${traceId} attachment-fetch start id=${params.attachment.id ?? "unknown"} cdnKey=${pointer.cdnKey ?? "none"} cdnNumber=${pointer.cdnNumber ?? "none"} contentType=${pointer.contentType ?? params.attachment.contentType ?? "none"} size=${pointer.size ?? params.attachment.size ?? "none"} fileNameChars=${pointer.fileName?.length ?? params.attachment.filename?.length ?? 0} captionChars=${pointer.caption?.length ?? 0}`,
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
    fetch: signalAttachmentFetch,
    abortSignal: params.abortSignal,
  });
  logSignalTsInfo(
    params.runtime,
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
    params.runtime,
    `signal-ts ${traceId} attachment-fetch saved path=${saved.path} contentType=${saved.contentType ?? "none"} bytes=${data.byteLength}`,
  );
  return { path: saved.path, contentType: saved.contentType };
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
      throw result.fatalError instanceof Error
        ? result.fatalError
        : new Error(message, { cause: result.fatalError });
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
  const context = await createSignalTsClientContext(params.accountInfo, params.runtime);
  const { account, client, repository } = context;
  const stores = createLibsignalStores(repository);
  const localAddress = createSignalLocalAddress(account.account);
  // Bring up the per-account voice controller only when opted in. It shares the
  // monitor's client + stores so signaling and inbound call messages flow over the
  // same authenticated connection; text features run regardless of its state.
  const voiceConfig = params.accountInfo.config.voiceCall;
  const voice: SignalVoiceRuntime | undefined =
    voiceConfig?.enabled && params.cfg
      ? startSignalVoiceRuntime({
          cfg: params.cfg,
          account: params.accountInfo,
          accountState: account,
          voiceConfig,
          client,
          stores,
          runtime: params.runtime,
        })
      : undefined;
  let latestDiagnosticEnvelope: SignalEnvelope | undefined;
  const inFlightIncoming = new Set<Promise<void>>();
  const offIncoming = client.on("incoming", (incoming) => {
    const task = (async () => {
      try {
        logSignalTsInfo(
          params.runtime,
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
        logSignalTsInfo(
          params.runtime,
          `signal-ts inbound decrypt done normalized=${messages.length}`,
        );
        for (const message of messages) {
          logSignalTsInfo(
            params.runtime,
            `signal-ts inbound normalized ${describeSignalTsIncomingMessage(message)}`,
          );
          if (message.kind === "call") {
            // Call signaling never becomes a signal-cli envelope; feed it straight
            // to the manager (which owns RingRTC + ring/answer) and skip dispatch.
            const aci = message.sender.serviceId;
            const deviceId = message.sender.deviceId;
            if (voice?.isReady() && aci && deviceId !== undefined) {
              const receivedAtDate = message.serverTimestamp ?? message.timestamp ?? Date.now();
              // A reconnect redelivers queued envelopes; RingRTC uses the offer age
              // to drop stale offers, so it must reflect real elapsed time — a fixed
              // 0 would ring (and possibly auto-accept) an abandoned call.
              const ageSec = Math.max(0, Math.round((Date.now() - receivedAtDate) / 1000));
              await voice.manager.handleIncomingCallMessage({
                call: message.call,
                sender: { aci, deviceId },
                ageSec,
                receivedAtCounter: incoming.timestamp,
                receivedAtDate,
              });
            } else {
              logSignalTsInfo(
                params.runtime,
                `signal-ts inbound call skipped voice=${Boolean(voice)} aci=${aci ?? "none"} device=${deviceId ?? "none"}`,
              );
            }
            continue;
          }
          const envelope = await toSignalCliEnvelope(message, repository);
          if (!envelope) {
            logSignalTsInfo(
              params.runtime,
              `signal-ts inbound skipped signal-cli envelope kind=${message.kind}`,
            );
            continue;
          }
          latestDiagnosticEnvelope = envelope;
          const payload: SignalReceivePayload = { envelope };
          logSignalTsInfo(
            params.runtime,
            `signal-ts inbound dispatch start kind=${message.kind} source=${envelope.sourceUuid ?? envelope.sourceNumber ?? "unknown"} timestamp=${envelope.timestamp ?? "none"}`,
          );
          await params.onEvent({ event: "receive", data: JSON.stringify(payload) });
          logSignalTsInfo(
            params.runtime,
            `signal-ts inbound dispatch done kind=${message.kind} source=${envelope.sourceUuid ?? envelope.sourceNumber ?? "unknown"} timestamp=${envelope.timestamp ?? "none"}`,
          );
        }
      } catch (err) {
        if (isIgnorableSignalTsIncomingError(err, incoming.envelope)) {
          logSignalTsInfo(
            params.runtime,
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
    })().finally(() => inFlightIncoming.delete(task));
    inFlightIncoming.add(task);
  });
  const disconnected = waitForSignalTsDisconnect(client, params.abortSignal);
  try {
    await client.connect(params.abortSignal);
    registerSignalTsActiveClient(params.accountInfo, context);
    await Promise.race([waitForAbort(params.abortSignal), disconnected]);
    return { diagnosticEnvelope: latestDiagnosticEnvelope };
  } catch (err) {
    unregisterSignalTsActiveClient(params.accountInfo, context);
    if (params.abortSignal?.aborted) {
      return { diagnosticEnvelope: latestDiagnosticEnvelope };
    }
    if (isFatalSignalTsDisconnect(err)) {
      return { fatalError: err, diagnosticEnvelope: latestDiagnosticEnvelope };
    }
    return { error: err, diagnosticEnvelope: latestDiagnosticEnvelope };
  } finally {
    unregisterSignalTsActiveClient(params.accountInfo, context);
    offIncoming();
    await Promise.allSettled(inFlightIncoming);
    if (voice) {
      await voice.stop().catch((err) => {
        logSignalTsError(params.runtime, `signal-ts voice teardown failed: ${String(err)}`);
      });
    }
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
      runtime,
      `signal-ts: sent retry receipt for ${err.retryReceipt.recipientServiceId}.${err.retryReceipt.senderDeviceId} timestamp=${err.retryReceipt.timestamp}`,
    );
  } catch (retryErr) {
    logSignalTsError(
      runtime,
      `signal-ts retry receipt failed: ${describeSignalTsDisconnectError(retryErr)}`,
    );
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
    let offDisconnected: () => void = () => {};

    const cleanup = () => {
      offDisconnected();
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
    };

    const onAbort = () => {
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
