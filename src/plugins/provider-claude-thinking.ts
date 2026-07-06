// Leaf module for Claude thinking-profile resolution. Kept dependency-light so
// auto-reply and the plugin-sdk barrel can both import without cycling through
// `plugin-sdk/provider-model-shared`.
import {
  CLAUDE_FABLE_5_THINKING_PROFILE,
  defaultsClaudeAdaptiveThinking,
  resolveClaudeFable5ModelIdentity,
  resolveClaudeModelIdentity,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeXhighEffort,
} from "@openclaw/llm-core";
import type { ProviderThinkingProfile } from "./provider-thinking.types.js";

const BASE_CLAUDE_THINKING_LEVELS = [
  { id: "off" },
  { id: "minimal" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
] as const satisfies ProviderThinkingProfile["levels"];

/** @deprecated Anthropic provider-owned model helper; do not use from third-party plugins. */
export function isClaudeAdaptiveThinkingDefaultModelId(
  /** Claude model id to check against adaptive-thinking default families. */
  modelId: string,
): boolean {
  const ref = { id: modelId };
  return (
    defaultsClaudeAdaptiveThinking(ref) ||
    (supportsClaudeAdaptiveThinking(ref) && !supportsClaudeNativeXhighEffort(ref))
  );
}

/** @deprecated Anthropic provider-owned model helper; do not use from third-party plugins. */
export function resolveClaudeThinkingProfile(
  /** Claude model id used to choose available thinking levels and defaults. */
  modelId: string,
  params?: Record<string, unknown>,
  options?: { includeNativeMax?: boolean },
): ProviderThinkingProfile {
  const ref = { id: modelId, params };
  const canonicalModelId = resolveClaudeModelIdentity(ref);
  if (resolveClaudeFable5ModelIdentity(ref)) {
    return CLAUDE_FABLE_5_THINKING_PROFILE;
  }
  if (isClaudeAdaptiveThinkingDefaultModelId(canonicalModelId)) {
    const nativeXhigh = supportsClaudeNativeXhighEffort(ref);
    return {
      levels: [
        ...BASE_CLAUDE_THINKING_LEVELS,
        ...(nativeXhigh ? [{ id: "xhigh" as const }] : []),
        { id: "adaptive" },
        ...(nativeXhigh || options?.includeNativeMax ? [{ id: "max" as const }] : []),
      ],
      defaultLevel: "adaptive",
    };
  }
  if (supportsClaudeNativeXhighEffort(ref)) {
    return {
      levels: [...BASE_CLAUDE_THINKING_LEVELS, { id: "xhigh" }, { id: "adaptive" }, { id: "max" }],
      defaultLevel: "off",
    };
  }
  return { levels: BASE_CLAUDE_THINKING_LEVELS };
}
