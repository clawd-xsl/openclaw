// Embedded runs whose resolved provider is a CLI runtime backend (claude-cli,
// google-gemini-cli, ...) execute through runCliAgent instead of the embedded
// API loop, mirroring the auto-reply and cron dispatch seams: the CLI harness
// owns the model call (subscription auth, live sessions). Without this,
// embedded callers that select a CLI backend (voice brief/consult, plugin
// runs) silently fell through to the provider's API transport.
//
// runCliAgent is loaded through the cli-runner.runtime.js boundary because
// cli-runner statically imports embedded-runner modules (payloads, context
// engine); a static import here would be a cycle.
import type { RunCliAgentParams } from "../cli-runner/types.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import type { RunEmbeddedAgentParams } from "./run/params.js";

type RunCliAgentFn = (params: RunCliAgentParams) => Promise<EmbeddedAgentRunResult>;

export type EmbeddedCliDispatchArgs = {
  params: RunEmbeddedAgentParams & { sessionFile: string };
  provider: string;
  modelId: string;
  /** Test seam; defaults to the real runtime-loaded runCliAgent. */
  runCliAgent?: RunCliAgentFn;
};

export async function runEmbeddedRunViaCliBackend(
  args: EmbeddedCliDispatchArgs,
): Promise<EmbeddedAgentRunResult> {
  const runCliAgent = args.runCliAgent ?? (await import("../cli-runner.runtime.js")).runCliAgent;
  return await runCliAgent(buildCliRunParamsFromEmbedded(args));
}

/**
 * Maps embedded-run params onto RunCliAgentParams. Fields without a CLI
 * equivalent (embedded streaming/persistence knobs, model fallback override —
 * the CLI harness owns its own delivery and the caller owns fallback) are
 * intentionally dropped.
 */
export function buildCliRunParamsFromEmbedded(args: EmbeddedCliDispatchArgs): RunCliAgentParams {
  const p = args.params;
  return {
    sessionId: p.sessionId,
    sessionFile: p.sessionFile,
    workspaceDir: p.workspaceDir,
    prompt: p.prompt,
    provider: args.provider,
    model: args.modelId,
    timeoutMs: p.timeoutMs,
    runId: p.runId,
    ...pickDefined(p, [
      "sessionKey",
      "agentId",
      "trigger",
      "cwd",
      "config",
      "transcriptPrompt",
      "thinkLevel",
      "fastMode",
      "fastModeStartedAtMs",
      "fastModeAutoOnSeconds",
      "fastModeAutoProgressState",
      "isFinalFallbackAttempt",
      "runTimeoutOverrideMs",
      "lifecycleGeneration",
      "lane",
      "jobId",
      "extraSystemPrompt",
      "sourceReplyDeliveryMode",
      "requireExplicitMessageTarget",
      "silentReplyPromptMode",
      "allowEmptyAssistantReplyAsSilent",
      "streamParams",
      "ownerNumbers",
      "authProfileId",
      "bootstrapPromptWarningSignaturesSeen",
      "bootstrapPromptWarningSignature",
      "bootstrapContextMode",
      "bootstrapContextRunKind",
      "images",
      "imageOrder",
      "skillsSnapshot",
      "messageChannel",
      "messageProvider",
      "currentChannelId",
      "chatId",
      "channelContext",
      "currentThreadTs",
      "currentMessageId",
      "currentInboundAudio",
      "agentAccountId",
      "senderId",
      "senderIsOwner",
      "toolsAllow",
      "disableTools",
      "abortSignal",
      "onExecutionStarted",
      "onExecutionPhase",
      "replyOperation",
      "inputProvenance",
      "currentInboundEventKind",
      "currentInboundContext",
      "userTurnTranscriptRecorder",
      "suppressNextUserMessagePersistence",
      "cleanupBundleMcpOnRunEnd",
      "cleanupCliLiveSessionOnRunEnd",
      "oneShotCliRun",
    ]),
  };
}

function pickDefined<T extends object, K extends keyof T>(source: T, keys: K[]): Pick<T, K> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as Pick<T, K>;
}
