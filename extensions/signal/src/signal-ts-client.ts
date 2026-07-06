import os from "node:os";
import path from "node:path";
import {
  FileSignalRepository,
  SignalTsClient,
  deriveAccessKeyBase64FromProfileKeyBase64,
  parseSignalRecipientTarget,
  preKeyAuthFromBase64,
  type FileSignalAccountState,
  type FileSignalGroupState,
  type FileSignalRecipientState,
  type PreKeyAuth,
  type SignalQuote,
  type SignalReaction,
  type SignalRecipientTarget,
} from "@openclaw/signal-ts";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSignalBackend, type ResolvedSignalAccount } from "./accounts.js";

const transportLog = createSubsystemLogger("signal/transport");
const DEFAULT_TIMEOUT_MS = 30_000;
let signalTsRuntimeTraceSequence = 0;

export type SignalTsClientContext = {
  client: SignalTsClient;
  repository: FileSignalRepository;
  account: FileSignalAccountState;
};

const activeSignalTsClients = new Map<string, SignalTsClientContext>();

export function isSignalTsBackend(accountInfo: ResolvedSignalAccount): boolean {
  return resolveSignalBackend(accountInfo) === "signal-ts";
}

export function resolveSignalTsStatePath(accountInfo: ResolvedSignalAccount): string {
  const configured = normalizeOptionalString(accountInfo.config.signalTsStatePath);
  const raw =
    configured ??
    normalizeOptionalString(process.env["OPENCLAW_SIGNAL_TS_STATE"]) ??
    path.join(os.homedir(), ".openclaw", "signal-ts", `${accountInfo.accountId}.json`);
  return raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
}

export function createSignalTsRuntimeTraceId(prefix: string): string {
  signalTsRuntimeTraceSequence = (signalTsRuntimeTraceSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now().toString(36)}-${signalTsRuntimeTraceSequence.toString(36)}`;
}

export function logSignalTsInfo(runtime: RuntimeEnv | undefined, message: string): void {
  transportLog.info(message);
  runtime?.log?.(`signal-ts: ${message}`);
}

export function logSignalTsWarn(runtime: RuntimeEnv | undefined, message: string): void {
  transportLog.warn(message);
  runtime?.log?.(`signal-ts warning: ${message}`);
}

export function logSignalTsError(runtime: RuntimeEnv | undefined, message: string): void {
  transportLog.error(message);
  runtime?.error?.(`signal-ts: ${message}`);
}

function createSignalTsLogger(runtime: RuntimeEnv | undefined) {
  return {
    debug: (message: string) => {
      transportLog.debug(message);
      runtime?.log?.(`signal-ts: ${message}`);
    },
    info: (message: string) => logSignalTsInfo(runtime, message),
    warn: (message: string) => logSignalTsWarn(runtime, message),
    error: (message: string, err?: unknown) => {
      const fullMessage = `${message}${err === undefined ? "" : `: ${describeSignalTsDisconnectError(err)}`}`;
      logSignalTsError(runtime, fullMessage);
    },
  };
}

export async function createSignalTsClientContext(
  accountInfo: ResolvedSignalAccount,
  runtime?: RuntimeEnv,
): Promise<SignalTsClientContext> {
  const repository = await FileSignalRepository.open(resolveSignalTsStatePath(accountInfo));
  const account = await repository.getAccount();
  if (!account) {
    throw new Error("Signal-ts state is missing account data");
  }
  const client = new SignalTsClient({
    account: account.account,
    environment: "production",
    userAgent: account.userAgent ?? "OpenClaw signal-ts",
    logger: createSignalTsLogger(runtime),
  });
  return { client, repository, account };
}

export async function probeSignalTsAccount(params: {
  accountInfo: ResolvedSignalAccount;
  timeoutMs: number;
}): Promise<{
  ok: boolean;
  status: null;
  error: string | null;
  elapsedMs: number;
  version: "signal-ts";
}> {
  const startedAt = Date.now();
  if (activeSignalTsClients.has(resolveSignalTsStatePath(params.accountInfo))) {
    return {
      ok: true,
      status: null,
      error: null,
      elapsedMs: Date.now() - startedAt,
      version: "signal-ts",
    };
  }
  let context: SignalTsClientContext | undefined;
  try {
    context = await createSignalTsClientContext(params.accountInfo);
    await context.client.connect(AbortSignal.timeout(Math.max(1, params.timeoutMs)));
    return {
      ok: true,
      status: null,
      error: null,
      elapsedMs: Date.now() - startedAt,
      version: "signal-ts",
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: describeSignalTsDisconnectError(err),
      elapsedMs: Date.now() - startedAt,
      version: "signal-ts",
    };
  } finally {
    await context?.client.disconnect().catch(() => {});
  }
}

export function registerSignalTsActiveClient(
  accountInfo: ResolvedSignalAccount,
  context: SignalTsClientContext,
): void {
  activeSignalTsClients.set(resolveSignalTsStatePath(accountInfo), context);
}

export function unregisterSignalTsActiveClient(
  accountInfo: ResolvedSignalAccount,
  context: SignalTsClientContext,
): void {
  const key = resolveSignalTsStatePath(accountInfo);
  if (activeSignalTsClients.get(key) === context) {
    activeSignalTsClients.delete(key);
  }
}

export async function withSignalTsClient<T>(
  params: {
    accountInfo: ResolvedSignalAccount;
    runtime?: RuntimeEnv;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  },
  run: (context: SignalTsClientContext & { abortSignal: AbortSignal }) => Promise<T>,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const abortSignal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, timeoutSignal])
    : timeoutSignal;
  const activeClient = activeSignalTsClients.get(resolveSignalTsStatePath(params.accountInfo));
  if (activeClient) {
    return await run({ ...activeClient, abortSignal });
  }

  const context = await createSignalTsClientContext(params.accountInfo, params.runtime);
  try {
    await context.client.connect(abortSignal);
    return await run({ ...context, abortSignal });
  } finally {
    await context.client.disconnect();
  }
}

export async function resolveSignalTsTarget(
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

export async function resolveSignalTsGroup(
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

export function parseSignalTsGroupTarget(raw: string): string | undefined {
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

export async function resolveSignalTsPreKeyAuth(
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

export async function resolveSignalTsQuote(params: {
  to: string;
  replyToId?: string;
  quoteAuthor?: string;
  repository: FileSignalRepository;
}): Promise<SignalQuote | undefined> {
  const id = parseSignalTimestamp(params.replyToId);
  if (id === undefined || parseSignalTsGroupTarget(params.to)) {
    return undefined;
  }
  const authorAci =
    (await resolveSignalTsAuthorAci(params.quoteAuthor, params.repository)) ??
    (await resolveSignalTsAuthorAci(params.to, params.repository));
  if (!authorAci) {
    throw new Error("Signal-ts quote reply requires a known author ACI for the target message");
  }
  return { id, authorAci };
}

export async function resolveSignalTsReaction(params: {
  recipient: string;
  targetTimestamp: number;
  emoji: string;
  remove?: boolean;
  targetAuthor?: string;
  targetAuthorUuid?: string;
  repository: FileSignalRepository;
}): Promise<SignalReaction> {
  const authorAci =
    (await resolveSignalTsAuthorAci(params.targetAuthorUuid, params.repository)) ??
    (await resolveSignalTsAuthorAci(params.targetAuthor, params.repository)) ??
    (await resolveSignalTsAuthorAci(params.recipient, params.repository));
  if (!authorAci) {
    throw new Error("Signal-ts reaction requires a known target author ACI");
  }
  return {
    emoji: params.emoji,
    targetAuthorAci: authorAci,
    targetSentTimestamp: params.targetTimestamp,
    ...(params.remove ? { remove: true } : {}),
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
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
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

export function isRetryableSignalTsSendError(err: unknown): boolean {
  if (isFatalSignalTsDisconnect(err)) {
    return false;
  }
  const text = describeSignalTsDisconnectError(err).toLowerCase();
  if (text.includes("aborterror") || text.includes("aborted")) {
    return false;
  }
  return (
    text.includes("all connect attempts failed") ||
    text.includes("unauthenticatedchatconnection_connect") ||
    text.includes("connect etimedout") ||
    text.includes("econnreset") ||
    text.includes("econnrefused") ||
    text.includes("eai_again") ||
    text.includes("socket hang up")
  );
}

export function isFatalSignalTsDisconnect(err: unknown): boolean {
  const text = describeSignalTsDisconnectError(err).toLowerCase();
  return text.includes("connectedelsewhere") || text.includes("connected elsewhere");
}

export function describeSignalTsDisconnectError(err: unknown): string {
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
    try {
      return JSON.stringify(err) ?? Object.prototype.toString.call(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
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
