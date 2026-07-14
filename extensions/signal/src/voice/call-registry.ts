// Process-local registry of active per-account Signal voice runtimes. Mirrors the
// registerSignalTsActiveClient pattern in signal-ts-client.ts: a plain module Map
// keyed by accountId so the outbound-call tool can find the live SignalCallManager
// without re-resolving config or reconnecting a client. v1 is single-call, but the
// registry is keyed per account to stay multi-account safe.
import type { SignalCallManager } from "@openclaw/signal-ts";
import type { SignalVoiceRuntime } from "./call-runtime.js";

const activeSignalVoiceRuntimes = new Map<string, SignalVoiceRuntime>();

export function registerSignalCallManager(accountId: string, runtime: SignalVoiceRuntime): void {
  activeSignalVoiceRuntimes.set(accountId, runtime);
}

export function unregisterSignalCallManager(accountId: string, runtime: SignalVoiceRuntime): void {
  // Only clear the slot when it still points at this runtime so a reconnect that
  // already registered a newer runtime is not torn down by a late teardown.
  if (activeSignalVoiceRuntimes.get(accountId) === runtime) {
    activeSignalVoiceRuntimes.delete(accountId);
  }
}

export function getSignalCallManager(accountId: string): SignalCallManager | undefined {
  return activeSignalVoiceRuntimes.get(accountId)?.manager;
}
