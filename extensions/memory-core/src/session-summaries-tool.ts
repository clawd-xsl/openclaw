// Memory Core plugin module exposes visibility-safe session-summary recall.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asToolParamsRecord,
  jsonResult,
  readPositiveIntegerParam,
  readStringParam,
  resolveSessionAgentId,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
} from "openclaw/plugin-sdk/session-visibility";
import type { TSchema } from "typebox";
import type { SessionSummariesConfig } from "./session-summaries-config.js";
import {
  encodeSessionSummaryCursor,
  paginateSessionSummaryRecords,
  SESSION_SUMMARY_QUERY_MAX_CHARS,
  SESSION_SUMMARY_TOOL_HARD_LIMIT,
  validateSessionSummaryCursor,
  type SessionSummaryListResult,
  type SessionSummaryPublicRecord,
  type SessionSummaryRecord,
  type SessionSummaryRepository,
} from "./session-summaries-store.js";
import {
  estimateSessionSummaryTokens,
  truncateSessionSummaryText,
} from "./session-summaries-transcript.js";

export const SESSION_SUMMARY_TOOL_RESPONSE_MAX_TOKENS = 12_000;

type SessionSummaryToolRecord = SessionSummaryPublicRecord & {
  metadataTruncated?: boolean;
  summaryTruncated?: boolean;
};

type SessionSummaryToolResponse = {
  summaries: SessionSummaryToolRecord[];
  nextCursor?: string;
};

const SessionSummariesToolSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      maxLength: SESSION_SUMMARY_QUERY_MAX_CHARS,
      description: "Optional literal keyword or phrase to find in summaries and session metadata.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: SESSION_SUMMARY_TOOL_HARD_LIMIT,
    },
    cursor: {
      type: "string",
      maxLength: 2_048,
      description: "Opaque cursor returned by a previous session_summaries call.",
    },
  },
  additionalProperties: false,
} as const satisfies TSchema;

export type SessionSummariesToolOptions = {
  agentId?: string;
  getConfig: () => OpenClawConfig;
  getSummaryConfig: () => SessionSummariesConfig;
  requesterSessionKey?: string;
  repository: SessionSummaryRepository;
  sandboxed?: boolean;
};

function normalizeAgentId(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase() || undefined;
}

function estimateToolResponseTokens(response: SessionSummaryToolResponse): number {
  return estimateSessionSummaryTokens(JSON.stringify(response, null, 2));
}

function boundMetadataString(value: string | null, maxTokens: number): string | null {
  if (value === null) {
    return null;
  }
  return truncateSessionSummaryText(value, maxTokens);
}

function boundToolMetadata(item: SessionSummaryPublicRecord): SessionSummaryPublicRecord & {
  metadataTruncated?: boolean;
} {
  const bounded = {
    ...item,
    agentId: boundMetadataString(item.agentId, 32) ?? "",
    sessionId: boundMetadataString(item.sessionId, 64) ?? "",
    sessionKey: boundMetadataString(item.sessionKey, 128) ?? "",
    nextSessionId: boundMetadataString(item.nextSessionId, 64),
    model: boundMetadataString(item.model, 64),
    lastError: boundMetadataString(item.lastError, 128),
    transcriptFingerprint: boundMetadataString(item.transcriptFingerprint, 64),
  };
  const metadataTruncated =
    bounded.agentId !== item.agentId ||
    bounded.sessionId !== item.sessionId ||
    bounded.sessionKey !== item.sessionKey ||
    bounded.nextSessionId !== item.nextSessionId ||
    bounded.model !== item.model ||
    bounded.lastError !== item.lastError ||
    bounded.transcriptFingerprint !== item.transcriptFingerprint;
  return metadataTruncated ? { ...bounded, metadataTruncated: true } : bounded;
}

export function boundSessionSummaryToolResponse(
  page: SessionSummaryListResult,
): SessionSummaryToolResponse {
  const originalItems = page.items;
  let items = originalItems.map(boundToolMetadata);
  const buildCursor = () => {
    if (items.length === originalItems.length) {
      return page.nextCursor;
    }
    const last = originalItems[items.length - 1];
    return last ? encodeSessionSummaryCursor(last) : page.nextCursor;
  };
  const buildBaseResponse = (): SessionSummaryToolResponse => ({
    summaries: items.map((item) =>
      Object.assign({}, item, { summary: "", summaryTruncated: true }),
    ),
    ...(buildCursor() ? { nextCursor: buildCursor() } : {}),
  });
  while (
    items.length > 1 &&
    estimateToolResponseTokens(buildBaseResponse()) >= SESSION_SUMMARY_TOOL_RESPONSE_MAX_TOKENS
  ) {
    items = items.slice(0, -1);
  }

  const originalSummaries = originalItems.slice(0, items.length).map((item) => item.summary ?? "");
  const budgets = originalSummaries.map(() => 0);
  const buildResponse = (): SessionSummaryToolResponse => ({
    summaries: items.map((item, index) => {
      const original = originalSummaries[index] ?? "";
      const summary = truncateSessionSummaryText(original, budgets[index] ?? 0);
      return summary !== original
        ? Object.assign({}, item, { summary, summaryTruncated: true })
        : Object.assign({}, item, { summary });
    }),
    ...(buildCursor() ? { nextCursor: buildCursor() } : {}),
  });
  let response = buildResponse();
  const baseTokens = estimateToolResponseTokens(response);
  if (baseTokens >= SESSION_SUMMARY_TOOL_RESPONSE_MAX_TOKENS || page.items.length === 0) {
    return response;
  }

  let remaining = SESSION_SUMMARY_TOOL_RESPONSE_MAX_TOKENS - baseTokens;
  for (let index = 0; index < budgets.length; index += 1) {
    const itemCount = budgets.length - index;
    const originalTokens = estimateSessionSummaryTokens(originalSummaries[index] ?? "");
    const allocated = Math.min(originalTokens, Math.max(0, Math.floor(remaining / itemCount)));
    budgets[index] = allocated;
    remaining -= allocated;
  }
  response = buildResponse();

  while (estimateToolResponseTokens(response) > SESSION_SUMMARY_TOOL_RESPONSE_MAX_TOKENS) {
    const overflow =
      estimateToolResponseTokens(response) - SESSION_SUMMARY_TOOL_RESPONSE_MAX_TOKENS;
    let largestIndex = -1;
    for (let index = 0; index < budgets.length; index += 1) {
      if (largestIndex < 0 || (budgets[index] ?? 0) > (budgets[largestIndex] ?? 0)) {
        largestIndex = index;
      }
    }
    if (largestIndex < 0 || (budgets[largestIndex] ?? 0) === 0) {
      break;
    }
    budgets[largestIndex] = Math.max(0, (budgets[largestIndex] ?? 0) - overflow - 8);
    response = buildResponse();
  }
  return response;
}

async function filterVisibleRecords(params: {
  agentId: string;
  cfg: OpenClawConfig;
  records: readonly SessionSummaryRecord[];
  requesterSessionKey: string;
  sandboxed: boolean;
}): Promise<SessionSummaryRecord[]> {
  const visibility = resolveEffectiveSessionToolsVisibility({
    cfg: params.cfg,
    sandboxed: params.sandboxed,
  });
  const guard = await createSessionVisibilityGuard({
    action: "history",
    requesterSessionKey: params.requesterSessionKey,
    visibility,
    a2aPolicy: createAgentToAgentPolicy(params.cfg),
  });
  const normalizedAgentId = normalizeAgentId(params.agentId);
  return params.records.filter(
    (record) =>
      normalizeAgentId(record.agentId) === normalizedAgentId &&
      Boolean(record.summary?.trim()) &&
      guard.check(record.sessionKey).allowed,
  );
}

export function createSessionSummariesTool(options: SessionSummariesToolOptions): AnyAgentTool {
  return {
    label: "Session Summaries",
    name: "session_summaries",
    description:
      "Recall bounded summaries of earlier visible sessions for the current agent. Keyword matching is literal, and results obey session-history visibility rules.",
    parameters: SessionSummariesToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const summaryConfig = options.getSummaryConfig();
      const cfg = options.getConfig();
      const requesterSessionKey = options.requesterSessionKey?.trim();
      if (!requesterSessionKey) {
        return jsonResult({
          unavailable: true,
          error: "session summary recall requires a requester session",
        });
      }
      const agentId =
        normalizeAgentId(options.agentId) ??
        normalizeAgentId(
          resolveSessionAgentId({
            sessionKey: requesterSessionKey,
            config: cfg,
          }),
        );
      if (!agentId) {
        return jsonResult({
          unavailable: true,
          error: "session summary recall could not resolve the current agent",
        });
      }

      const params = asToolParamsRecord(rawParams);
      const query = readStringParam(params, "query");
      const cursor = readStringParam(params, "cursor");
      const limit = readPositiveIntegerParam(params, "limit");
      if (cursor) {
        validateSessionSummaryCursor({ agentId, cursor });
      }
      const records = await options.repository.queryRecords({
        agentId,
        lookbackDays: summaryConfig.lookbackDays,
        ...(query ? { query } : {}),
        statuses: ["complete"],
      });
      const visible = await filterVisibleRecords({
        agentId,
        cfg,
        records,
        requesterSessionKey,
        sandboxed: options.sandboxed === true,
      });
      const page = paginateSessionSummaryRecords({
        agentId,
        records: visible,
        hardLimit: SESSION_SUMMARY_TOOL_HARD_LIMIT,
        ...(cursor ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return jsonResult(boundSessionSummaryToolResponse(page));
    },
  };
}

export async function canInjectSessionSummary(params: {
  cfg: OpenClawConfig;
  currentSessionKey: string;
  predecessorSessionKey: string;
}): Promise<boolean> {
  const currentSessionKey = params.currentSessionKey.trim();
  const predecessorSessionKey = params.predecessorSessionKey.trim();
  // Prompt-build hooks do not expose the sandbox flag. Fail closed instead of
  // assuming a broader unsandboxed tree/agent visibility for another key.
  if (!currentSessionKey || currentSessionKey !== predecessorSessionKey) {
    return false;
  }
  const visibility = resolveEffectiveSessionToolsVisibility({ cfg: params.cfg, sandboxed: false });
  const guard = await createSessionVisibilityGuard({
    action: "history",
    requesterSessionKey: currentSessionKey,
    visibility,
    a2aPolicy: createAgentToAgentPolicy(params.cfg),
  });
  return guard.check(predecessorSessionKey).allowed;
}
