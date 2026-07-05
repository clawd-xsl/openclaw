/** Keyed session-store lookup used by the reply dispatch hot path. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { FinalizedMsgContext } from "../templating.js";
import { readSessionEntry, resolveStorePath } from "./dispatch-from-config.runtime.js";

export type DispatchSessionStoreLookup = {
  sessionKey?: string;
  storePath?: string;
  entry?: SessionEntry;
};

export function resolveDispatchSessionStoreLookup(
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): DispatchSessionStoreLookup {
  const targetSessionKey = resolveCommandTurnTargetSessionKey(ctx);
  const sessionKey = normalizeOptionalString(targetSessionKey ?? ctx.SessionKey);
  if (!sessionKey) {
    return {};
  }
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg, fallbackAgentId: ctx.AgentId });
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  try {
    return {
      sessionKey,
      storePath,
      entry: readSessionEntry(storePath, sessionKey, { exact: true }) as SessionEntry | undefined,
    };
  } catch {
    return {
      sessionKey,
      storePath,
    };
  }
}
