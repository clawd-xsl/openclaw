import type { ImageContent } from "@mariozechner/pi-ai";
import type { ReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { CliCompactionOverlay, CliSessionBinding } from "../../config/sessions.js";
import type { SessionSystemPromptReport } from "../../config/sessions/types.js";
import type { CliBackendConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { ResolvedCliBackend } from "../cli-backends.js";
import type { CliStreamingDelta } from "../cli-output.js";
import type { CliSessionInvalidationReason } from "../cli-session.js";
import type { SkillSnapshot } from "../skills.js";
import type { CliBundleMcpSpec } from "./bundle-mcp.js";
import type { ClaudeCliSkillsPluginSpec } from "./claude-skills-plugin.js";

export type RunCliAgentParams = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  prompt: string;
  provider: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  fastMode?: boolean;
  reasoningLevel?: ReasoningLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  streamParams?: import("../command/types.js").AgentStreamParams;
  ownerNumbers?: string[];
  cliSessionId?: string;
  cliSessionBinding?: CliSessionBinding;
  cliCompactionOverlay?: CliCompactionOverlay;
  authProfileId?: string;
  bootstrapPromptWarningSignaturesSeen?: string[];
  bootstrapPromptWarningSignature?: string;
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  skillsSnapshot?: SkillSnapshot;
  messageProvider?: string;
  agentAccountId?: string;
  senderIsOwner?: boolean;
  previousSessionId?: string;
  recentSessionHistory?: string;
  sessionCreatedAt?: number;
  abortSignal?: AbortSignal;
  replyOperation?: ReplyOperation;
  continuityBreakMode?: "internal-retry" | "throw";
  onAssistantDelta?: (delta: CliStreamingDelta) => void | Promise<void>;
};

export type CliPreparedBackend = {
  backend: CliBackendConfig;
  cleanup?: () => Promise<void>;
  mcpConfigHash?: string;
  env?: Record<string, string>;
  bundleMcpSpec?: CliBundleMcpSpec;
  claudeSkillsPluginSpec?: ClaudeCliSkillsPluginSpec;
};

export type CliReusableSession = {
  sessionId?: string;
  invalidatedReason?: CliSessionInvalidationReason;
};

export type PreparedCliRunContext = {
  params: RunCliAgentParams;
  started: number;
  workspaceDir: string;
  backendResolved: ResolvedCliBackend;
  preparedBackend: CliPreparedBackend;
  reusableCliSession: CliReusableSession;
  modelId: string;
  normalizedModel: string;
  systemPrompt: string;
  systemPromptReport: SessionSystemPromptReport;
  bootstrapPromptWarningLines: string[];
  heartbeatPrompt?: string;
  authEpoch?: string;
  extraSystemPromptHash?: string;
};
