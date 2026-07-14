// Agent tool that places an outbound Signal 1:1 voice call. Resolves the active
// SignalCallManager for the account (registered by the per-account voice runtime)
// and starts an outgoing call, resolving the recipient to an ACI first. Returns a
// closed { status } shape the model can reason about.
import { parseSignalRecipientTarget } from "@openclaw/signal-ts";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { resolveSignalAccount } from "../accounts.js";
import { withSignalTsClient } from "../signal-ts-client.js";
import { getSignalCallManager } from "./call-registry.js";

type SignalVoiceCallToolResult =
  | { status: "ringing"; callId: string; to: string }
  | { status: "busy" }
  | { status: "unavailable"; reason: string }
  | { status: "error"; reason: string };

export const signalVoiceCallTool = defineToolPlugin({
  id: "signal-voice-call",
  name: "Signal Voice Call",
  description: "Place an outbound Signal 1:1 voice call from the agent.",
  tools: (tool) => [
    tool({
      name: "signal_voice_call",
      description: "Start an outbound Signal voice call to a recipient. Returns the call status.",
      parameters: Type.Object(
        {
          to: Type.String({ description: "Recipient ACI, e164, or configured alias." }),
          account: Type.Optional(
            Type.String({ description: "Signal account id (multi-account)." }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (params, _config, context): Promise<SignalVoiceCallToolResult> => {
        const to = normalizeOptionalString(params.to);
        if (!to) {
          return { status: "error", reason: "A recipient (ACI, e164, or alias) is required." };
        }
        const cfg = (context.api.runtime.config?.current?.() ??
          context.api.config) as OpenClawConfig;
        const account = resolveSignalAccount({ cfg, accountId: params.account ?? null });
        const manager = getSignalCallManager(account.accountId);
        if (!manager) {
          // No live manager: voice calling is disabled for this account or the
          // optional @signalapp/ringrtc package is not installed.
          return {
            status: "unavailable",
            reason: "Signal voice calling is not active for this account.",
          };
        }
        if (manager.isBusy()) {
          return { status: "busy" };
        }
        let recipientAci: string | null;
        try {
          recipientAci = await resolveSignalCallRecipientAci(to, account);
        } catch (err) {
          return { status: "error", reason: formatErrorMessage(err) };
        }
        if (!recipientAci) {
          return {
            status: "error",
            reason: `Could not resolve "${to}" to a Signal ACI. Provide a known contact ACI or e164.`,
          };
        }
        try {
          const { callId } = await manager.startOutgoingCall({ recipientAci });
          return { status: "ringing", callId: callId.toString(), to: recipientAci };
        } catch (err) {
          // Keep the closed { status } contract: a native RingRTC failure, or a
          // call that went busy during the awaited ACI lookup, must not throw.
          return manager.isBusy()
            ? { status: "busy" }
            : { status: "error", reason: formatErrorMessage(err) };
        }
      },
    }),
  ],
});

// RingRTC needs the recipient ACI. Resolve aliases first, then map the target to an
// ACI: aci targets pass through, e164 targets look up the stored recipient (reusing
// the monitor's already-connected client), usernames are unsupported for calls.
async function resolveSignalCallRecipientAci(
  to: string,
  account: ReturnType<typeof resolveSignalAccount>,
): Promise<string | null> {
  const aliased = account.config.aliases?.[to] ?? to;
  const parsed = parseSignalRecipientTarget(aliased);
  if (parsed.kind === "aci") {
    return typeof parsed.aci === "string" ? parsed.aci : parsed.aci.getServiceIdString();
  }
  if (parsed.kind !== "e164") {
    return null;
  }
  return await withSignalTsClient({ accountInfo: account }, async ({ repository }) => {
    const recipient = await repository.getRecipientByE164(parsed.e164);
    return recipient?.aci ?? null;
  });
}
