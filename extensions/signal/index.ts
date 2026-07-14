// Signal plugin entrypoint registers its OpenClaw integration.
import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

// Lazily load the outbound voice-call tool so cold discovery/setup paths do not pull
// the realtime-voice runtime into the lightweight channel bootstrap.
function registerSignalVoiceCallTool(api: OpenClawPluginApi): void {
  const tool = loadBundledEntryExportSync<{ register: (api: OpenClawPluginApi) => void }>(
    import.meta.url,
    {
      specifier: "./voice-tool-api.js",
      exportName: "signalVoiceCallTool",
    },
  );
  tool.register(api);
}

export default defineBundledChannelEntry({
  id: "signal",
  name: "Signal",
  description: "Signal channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "signalPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setSignalRuntime",
  },
  registerFull(api) {
    registerSignalVoiceCallTool(api);
  },
});
