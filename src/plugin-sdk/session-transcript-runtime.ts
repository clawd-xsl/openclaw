// Narrow runtime helper for plugins that need to mirror delivered assistant
// replies into the owning session transcript without importing core internals.

export { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.runtime.js";
export type { SessionTranscriptAppendResult } from "../config/sessions/transcript.js";
