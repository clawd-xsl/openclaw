import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { querySummaries } from "../../sessions/session-summary-loader.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import type { AnyAgentTool } from "./common.js";

const SessionSummariesSchema = Type.Object({
  from: Type.Optional(
    Type.String({
      description:
        'Start time. ISO date ("2026-03-01") or relative format ("7d", "30d"). Default "7d".',
    }),
  ),
  to: Type.Optional(
    Type.String({
      description: 'End time. ISO date or "now". Default "now".',
    }),
  ),
  sessionKey: Type.Optional(
    Type.String({
      description:
        'Session key filter. Supports SQL LIKE patterns (e.g. "%main%"). Default: %main% (matches any session key containing "main"). Use "*" for all sessions.',
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Max results. Default 20.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Keyword search on summary text. Space-separated keywords use AND logic (all must match). Case-insensitive.",
    }),
  ),
});

function parseTimeParam(value: string | undefined, defaultValue: string): number {
  const input = (value ?? defaultValue).trim();
  if (input === "now") {
    return Date.now();
  }
  // Relative: "7d", "30d"
  const relMatch = input.match(/^(\d+)d$/);
  if (relMatch) {
    return Date.now() - parseInt(relMatch[1], 10) * 24 * 60 * 60 * 1000;
  }
  // ISO date
  const ts = new Date(input).getTime();
  if (!Number.isNaN(ts)) {
    return ts;
  }
  // Fallback
  return Date.now() - 7 * 24 * 60 * 60 * 1000;
}

export function createSessionSummariesTool(opts?: {
  agentSessionKey?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  const agentId = resolveSessionAgentId({
    sessionKey: opts?.agentSessionKey,
    config: opts?.config,
  });
  // Resolve the main session key for the agent
  const _mainSessionKey = opts?.agentSessionKey
    ? opts.agentSessionKey.replace(/:subagent:.*$/, "")
    : undefined;

  return {
    label: "Session Summaries",
    name: "session_summaries",
    description:
      "Query past session summaries by time range. Returns structured summaries of past sessions " +
      "including topics, decisions, action items, and mood. Use to recall what happened in " +
      "previous sessions. Default: last 7 days of the main session." +
      " Each result includes session metadata (session_id, session_key, message_count, " +
      "start/end timestamps) alongside the summary text. " +
      "sessionKey defaults to matching any session containing 'main' (LIKE %main%). " +
      "Use sessionKey='*' for all sessions across all keys. " +
      "Use query for keyword search on summary text (space-separated, AND logic, case-insensitive).",
    parameters: SessionSummariesSchema,
    execute: async (
      _toolCallId: string,
      args: { from?: string; to?: string; sessionKey?: string; limit?: number; query?: string },
    ) => {
      const from = parseTimeParam(args.from, "7d");
      const to = parseTimeParam(args.to, "now");
      const sessionKey = args.sessionKey === "*" ? undefined : (args.sessionKey ?? "%main%");
      const limit = args.limit ?? 20;

      const results = querySummaries({
        agentId,
        sessionKey,
        from,
        to,
        limit,
        query: args.query,
      });

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No session summaries found for the specified time range.",
            },
          ],
        };
      }

      // Format results with parsed summary JSON
      const formatted = results.map((r) => {
        let summary: unknown;
        try {
          summary = JSON.parse(r.summary);
        } catch {
          summary = r.summary;
        }
        return {
          sessionId: r.session_id,
          sessionKey: r.session_key,
          createdAt: r.created_at,
          endedAt: r.ended_at,
          messageCount: r.message_count,
          model: r.model,
          summaryModel: r.summary_model,
          summary,
        };
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(formatted, null, 2) }],
      };
    },
  } as AnyAgentTool;
}
