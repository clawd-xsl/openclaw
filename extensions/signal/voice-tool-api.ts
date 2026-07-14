// Narrow top-level artifact exposing the Signal outbound voice-call tool plugin so
// the channel entry can register it lazily without importing the runtime on cold
// discovery/setup paths.
export { signalVoiceCallTool } from "./src/voice/call-tool.js";
