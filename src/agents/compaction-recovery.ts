export const COMPACTION_RECOVERY_CUSTOM_TYPE = "compaction-recovery";
export const MAX_COMPACTION_RECOVERY_CHARS = 8_000;

export function buildCompactionRecoveryBoundaryContent(params: {
  sessionId?: string;
  recoveryContent: string;
}): string {
  return (
    `Your conversation has just been compacted. Current session ID: ${params.sessionId ?? "unknown"}\n\n` +
    `Above this message you will see:\n` +
    `1. Compaction summary - a compressed summary of the prior conversation\n` +
    `2. Retained messages - the most recent messages preserved during compaction\n\n` +
    `Below this message is the new conversation.\n\n` +
    `Read the following compaction recovery instructions carefully to restore your state:\n\n` +
    `---\n\n` +
    params.recoveryContent.slice(0, MAX_COMPACTION_RECOVERY_CHARS)
  );
}

export function createCompactionRecoveryMessage(params: {
  sessionId?: string;
  recoveryContent: string;
  timestamp?: number;
}) {
  return {
    role: "custom" as const,
    customType: COMPACTION_RECOVERY_CUSTOM_TYPE,
    content: buildCompactionRecoveryBoundaryContent(params),
    display: false as const,
    details: undefined,
    timestamp: params.timestamp ?? Date.now(),
  };
}
