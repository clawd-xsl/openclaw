import { normalizeProviderId } from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  CLAUDE_CLI_HISTORY_PROVIDERS,
  readClaudeCliSessionMessages,
  resolveClaudeCliBindingSessionId,
  resolveClaudeCliSessionFilePath,
} from "./cli-session-history.claude.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";

export {
  mergeImportedChatHistoryMessages,
  readClaudeCliSessionMessages,
  resolveClaudeCliSessionFilePath,
};

export function augmentChatHistoryWithCliSessionImports(params: {
  entry: SessionEntry | undefined;
  provider?: string;
  localMessages: unknown[];
  homeDir?: string;
}): unknown[] {
  const cliSessionId = resolveClaudeCliBindingSessionId(params.entry, params.provider);
  if (!cliSessionId) {
    return params.localMessages;
  }

  const normalizedProvider = normalizeProviderId(params.provider ?? "");
  if (
    normalizedProvider &&
    !CLAUDE_CLI_HISTORY_PROVIDERS.includes(
      normalizedProvider as (typeof CLAUDE_CLI_HISTORY_PROVIDERS)[number],
    ) &&
    params.localMessages.length > 0
  ) {
    return params.localMessages;
  }

  const importedMessages = readClaudeCliSessionMessages({
    cliSessionId,
    homeDir: params.homeDir,
  });
  return mergeImportedChatHistoryMessages({
    localMessages: params.localMessages,
    importedMessages,
  });
}
