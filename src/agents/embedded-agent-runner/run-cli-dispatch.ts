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
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { getSessionEntry } from "../../config/sessions/store.js";
import type { CliSessionBinding } from "../../config/sessions/types.js";
import type { RunCliAgentParams } from "../cli-runner/types.js";
import { setCliSessionBinding } from "../cli-session.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import type { RunEmbeddedAgentParams } from "./run/params.js";

type RunCliAgentFn = (params: RunCliAgentParams) => Promise<EmbeddedAgentRunResult>;

// Injectable session-binding store access. Defaults to the real session store;
// tests inject fakes so they never module-mock the shared core session modules.
export type CliDispatchBindingStore = {
  read(
    storePath: string,
    sessionKey: string,
    agentId: string | undefined,
    provider: string,
  ): CliSessionBinding | undefined;
  write(
    storePath: string,
    sessionKey: string,
    agentId: string | undefined,
    provider: string,
    binding: CliSessionBinding,
  ): Promise<void>;
};

const defaultBindingStore: CliDispatchBindingStore = {
  read: (storePath, sessionKey, agentId, provider) =>
    getCliSessionBinding(
      getSessionEntry({ storePath, sessionKey, ...(agentId ? { agentId } : {}) }),
      provider,
    ),
  write: async (storePath, sessionKey, agentId, provider, binding) => {
    await updateSessionEntry(
      { storePath, sessionKey, ...(agentId ? { agentId } : {}) },
      (entry) => {
        const next = { ...entry };
        setCliSessionBinding(next, provider, binding);
        return {
          cliSessionBindings: next.cliSessionBindings,
          cliSessionIds: next.cliSessionIds,
          claudeCliSessionId: next.claudeCliSessionId,
        };
      },
    );
  },
};

export type EmbeddedCliDispatchArgs = {
  params: RunEmbeddedAgentParams & { sessionFile: string };
  provider: string;
  modelId: string;
  /** Test seam; defaults to the real runtime-loaded runCliAgent. */
  runCliAgent?: RunCliAgentFn;
  /** Test seam; defaults to the real session-binding store access. */
  bindingStore?: CliDispatchBindingStore;
};

function resolveDispatchStorePath(args: EmbeddedCliDispatchArgs): string {
  return (
    args.params.sessionTarget?.storePath ??
    resolveStorePath(args.params.config?.session?.store, {
      ...(args.params.agentId ? { agentId: args.params.agentId } : {}),
    })
  );
}

export async function runEmbeddedRunViaCliBackend(
  args: EmbeddedCliDispatchArgs,
): Promise<EmbeddedAgentRunResult> {
  const runCliAgent = args.runCliAgent ?? (await import("../cli-runner.runtime.js")).runCliAgent;
  const bindingStore = args.bindingStore ?? defaultBindingStore;
  // Round-trip the CLI session binding so consecutive CLI runs on this session
  // (e.g. a pre-call voice consult warm-up and the real consult) resume the same
  // live process instead of every run cold-starting. Without this the embedded
  // -> CLI dispatch drops the binding and every run is a cold miss.
  const sessionKey = args.params.sessionKey?.trim();
  const agentId = args.params.agentId;
  const storePath = sessionKey ? resolveDispatchStorePath(args) : undefined;
  const priorBinding =
    sessionKey && storePath
      ? bindingStore.read(storePath, sessionKey, agentId, args.provider)
      : undefined;

  const result = await runCliAgent(buildCliRunParamsFromEmbedded(args, priorBinding));

  const nextBinding = result.meta?.agentMeta?.cliSessionBinding;
  if (sessionKey && storePath && nextBinding) {
    await bindingStore
      .write(storePath, sessionKey, agentId, args.provider, nextBinding)
      .catch(() => {
        // Best-effort: a failed binding write only costs the next run a cold start.
      });
  }
  return result;
}

/**
 * Maps embedded-run params onto RunCliAgentParams. Fields without a CLI
 * equivalent (embedded streaming/persistence knobs, model fallback override —
 * the CLI harness owns its own delivery and the caller owns fallback) are
 * intentionally dropped.
 */
export function buildCliRunParamsFromEmbedded(
  args: EmbeddedCliDispatchArgs,
  priorBinding?: CliSessionBinding,
): RunCliAgentParams {
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
    // Resume the live session the previous run (or the warm-up) left behind.
    ...(priorBinding ? { cliSessionBinding: priorBinding } : {}),
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
