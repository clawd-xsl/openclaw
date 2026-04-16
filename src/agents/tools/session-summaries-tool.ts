import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildAgentMainSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { querySummaries } from "../../sessions/session-summary-loader.js";
import { resolveSessionSummarySettings } from "../../sessions/session-summary.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import {
  type AnyAgentTool,
  ToolAuthorizationError,
  ToolInputError,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./common.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";

const SessionSummariesSchema = Type.Object({
  from: Type.Optional(
    Type.String({
      description: "Start time. Use an ISO date like 2026-03-01 or a relative day window like 7d.",
    }),
  ),
  to: Type.Optional(
    Type.String({
      description: 'End time. Use an ISO date or "now".',
    }),
  ),
  sessionKey: Type.Optional(
    Type.String({
      description:
        'Optional session key filter for the current agent. Use "*" for all sessions or SQL LIKE wildcards such as "%main%".',
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 100,
      description: "Maximum number of summaries to return. Default 20.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Optional case-insensitive keyword search across summary text. Space-separated keywords use AND matching.",
    }),
  ),
});

function parseTimeParam(value: string | undefined, defaultValue: string): number {
  const input = (value ?? defaultValue).trim();
  if (!input) {
    throw new ToolInputError("time value required");
  }
  if (input === "now") {
    return Date.now();
  }
  const relativeMatch = input.match(/^(\d+)d$/i);
  if (relativeMatch) {
    const days = Number.parseInt(relativeMatch[1], 10);
    if (!Number.isFinite(days) || days <= 0) {
      throw new ToolInputError(`invalid relative day window: ${input}`);
    }
    return Date.now() - days * 24 * 60 * 60 * 1000;
  }
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) {
    throw new ToolInputError(`invalid time value: ${input}`);
  }
  return timestamp;
}

function usesSqlLikePattern(value: string): boolean {
  return value.includes("%") || value.includes("_");
}

export function createSessionSummariesTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Session Summaries",
    name: "session_summaries",
    displaySummary: "Query past session summaries.",
    description:
      "Query generated summaries from past sessions for the current agent. " +
      "Filter by time range, session key, or summary keywords to recall earlier work.",
    parameters: SessionSummariesSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const {
        cfg,
        mainKey,
        alias,
        requesterInternalKey,
        effectiveRequesterKey,
        restrictToSpawned,
      } = resolveSessionToolContext({
        agentSessionKey: opts?.agentSessionKey,
        sandboxed: opts?.sandboxed,
        config: opts?.config,
      });
      const visibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });
      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "history",
        requesterSessionKey: effectiveRequesterKey,
        visibility,
        a2aPolicy,
      });
      const { sessionAgentId } = resolveSessionAgentIds({
        sessionKey: opts?.agentSessionKey,
        config: cfg,
      });
      const settings = resolveSessionSummarySettings(cfg);

      const from = parseTimeParam(readStringParam(params, "from"), `${settings.summaryDays}d`);
      const to = parseTimeParam(readStringParam(params, "to"), "now");
      if (to < from) {
        throw new ToolInputError("to must be greater than or equal to from");
      }

      const limit = Math.min(
        100,
        Math.max(1, readNumberParam(params, "limit", { integer: true }) ?? 20),
      );
      const requestedSessionKey = readStringParam(params, "sessionKey");
      const query = readStringParam(params, "query");

      let sessionKeyFilter: string | undefined;
      let resolvedSessionLabel: string | undefined;

      if (requestedSessionKey === "*") {
        if (restrictToSpawned || visibility === "self" || visibility === "tree") {
          throw new ToolAuthorizationError(
            "Wildcard session summary queries require agent-wide session visibility.",
          );
        }
      } else if (requestedSessionKey && usesSqlLikePattern(requestedSessionKey)) {
        if (restrictToSpawned || (visibility !== "agent" && visibility !== "all")) {
          throw new ToolAuthorizationError(
            "Pattern session summary queries require agent-wide session visibility.",
          );
        }
        sessionKeyFilter = requestedSessionKey;
        resolvedSessionLabel = requestedSessionKey;
      } else {
        const defaultSessionKey =
          restrictToSpawned || visibility === "self" || visibility === "tree"
            ? (requesterInternalKey ??
              buildAgentMainSessionKey({ agentId: sessionAgentId, mainKey }))
            : buildAgentMainSessionKey({ agentId: sessionAgentId, mainKey });
        const sessionInput = requestedSessionKey ?? defaultSessionKey;
        const resolvedSession = await resolveSessionReference({
          sessionKey: sessionInput,
          alias,
          mainKey,
          requesterInternalKey,
          restrictToSpawned,
        });
        if (!resolvedSession.ok) {
          if (resolvedSession.status === "forbidden") {
            throw new ToolAuthorizationError(resolvedSession.error);
          }
          throw new ToolInputError(resolvedSession.error);
        }

        const visibleSession = await resolveVisibleSessionReference({
          resolvedSession,
          requesterSessionKey: effectiveRequesterKey,
          restrictToSpawned,
          visibilitySessionKey: sessionInput,
        });
        if (!visibleSession.ok) {
          throw new ToolAuthorizationError(visibleSession.error);
        }

        const access = visibilityGuard.check(visibleSession.key);
        if (!access.allowed) {
          throw new ToolAuthorizationError(access.error);
        }

        if (resolveAgentIdFromSessionKey(visibleSession.key) !== sessionAgentId) {
          throw new ToolAuthorizationError(
            "Session summaries only support sessions for the current agent.",
          );
        }

        sessionKeyFilter = visibleSession.key;
        resolvedSessionLabel = visibleSession.displayKey;
      }

      const summaries = querySummaries({
        agentId: sessionAgentId,
        sessionKey: sessionKeyFilter,
        from,
        to,
        limit,
        query,
        config: cfg,
      });

      return jsonResult({
        count: summaries.length,
        filters: {
          from,
          to,
          fromIso: new Date(from).toISOString(),
          toIso: new Date(to).toISOString(),
          sessionKey: resolvedSessionLabel ?? (requestedSessionKey === "*" ? "*" : "main"),
          query,
          limit,
        },
        summaries: summaries.map((summary) => ({
          sessionId: summary.session_id,
          previousSessionId: summary.previous_session_id,
          sessionKey: summary.session_key,
          agentId: summary.agent_id,
          createdAt: summary.created_at,
          endedAt: summary.ended_at,
          messageCount: summary.message_count,
          model: summary.model,
          summaryModel: summary.summary_model,
          generatedAt: summary.generated_at,
          summary: summary.summary,
        })),
      });
    },
  };
}
