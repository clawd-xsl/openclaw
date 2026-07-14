// Resolved Signal voice-call config consumed by the voice runtime. Derived from
// the plugin's SignalAccountConfig so it tracks the core schema without importing
// core src.
import type { SignalAccountConfig } from "../account-types.js";

export type SignalVoiceCallConfig = NonNullable<SignalAccountConfig["voiceCall"]>;
