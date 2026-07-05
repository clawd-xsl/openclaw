// Signal helper module supports config ui hints behavior.
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const signalChannelConfigUiHints = {
  "": {
    label: "Signal",
    help: "Signal channel provider configuration including account identity and DM policy behavior. Keep account mapping explicit so routing remains stable across multi-device setups.",
  },
  dmPolicy: {
    label: "Signal DM Policy",
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.signal.allowFrom=["*"].',
  },
  configWrites: {
    label: "Signal Config Writes",
    help: "Allow Signal to write config in response to channel events/commands (default: true).",
  },
  account: {
    label: "Signal Account",
    help: "Signal account identifier (phone/number handle) used to bind this channel config to a specific Signal identity. Keep this aligned with your linked device/session state.",
  },
  backend: {
    label: "Signal Transport",
    help: "Use the embedded signal-ts client or the legacy signal-cli daemon. signal-ts is selected automatically when a state path is configured.",
  },
  signalTsStatePath: {
    label: "Signal State Path",
    help: "Path to durable linked-device state for the embedded signal-ts client.",
  },
  configPath: {
    label: "Signal CLI Config Path",
    help: "Optional directory passed to signal-cli via --config when the service needs a non-default signal-cli data path.",
  },
  replyToMode: {
    label: "Signal Reply Mode",
    help: 'Controls native quoted replies: "off" (default), "first", "all", or "batched".',
  },
} satisfies Record<string, ChannelConfigUiHint>;
