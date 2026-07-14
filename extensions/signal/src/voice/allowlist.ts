// Inbound Signal voice-call allowlist gate. Pure and dependency-light so it is
// unit-testable without the voice runtime. Signal call offers only carry the peer
// ACI (no e164), so allowFrom entries must be ACIs (or "*") to match here.
import type { SignalCallPeer } from "@openclaw/signal-ts";
import type { SignalVoiceCallConfig } from "./config.js";

/** Default deny. "*" opens the line; otherwise the caller ACI must be listed. */
export function isAllowedSignalCaller(
  peer: SignalCallPeer,
  allowFrom: SignalVoiceCallConfig["allowFrom"],
): boolean {
  if (!allowFrom || allowFrom.length === 0) {
    return false;
  }
  const aci = peer.aci.trim().toLowerCase();
  if (!aci) {
    // An empty peer ACI must never match an (also-empty) allowlist entry.
    return false;
  }
  for (const entry of allowFrom) {
    const value = String(entry).trim();
    if (value === "*") {
      return true;
    }
    const stripped = value
      .replace(/^signal:/i, "")
      .replace(/^(uuid|aci):/i, "")
      .trim()
      .toLowerCase();
    if (stripped && stripped === aci) {
      return true;
    }
  }
  return false;
}
