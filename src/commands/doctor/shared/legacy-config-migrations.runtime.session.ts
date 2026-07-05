// Legacy session runtime config migrations for retired summary, maintenance, and fork sizing keys.
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

const LEGACY_SESSION_SUMMARY_MODEL = "anthropic/claude-sonnet-4-6";
const LEGACY_SESSION_SUMMARY_DAYS = 7;
const MAX_SESSION_SUMMARY_LOOKBACK_DAYS = 3_650;
const LEGACY_CLAUDE_CLI_STREAMING_PREFIX = "claude-cli-streaming/";
const CLAUDE_CLI_PREFIX = "claude-cli/";

function hasLegacySessionSummaryConfig(value: unknown): boolean {
  const session = getRecord(value);
  return Boolean(
    session &&
    ["summaryModel", "summaryDays", "summaryMaxChars"].some((key) => Object.hasOwn(session, key)),
  );
}

function getOrCreateRecord(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  if (parent[key] === undefined) {
    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
  }
  return getRecord(parent[key]);
}

function resolveLegacySummaryModel(value: unknown): string {
  const model =
    typeof value === "string" && value.trim() ? value.trim() : LEGACY_SESSION_SUMMARY_MODEL;
  return model.startsWith(LEGACY_CLAUDE_CLI_STREAMING_PREFIX)
    ? `${CLAUDE_CLI_PREFIX}${model.slice(LEGACY_CLAUDE_CLI_STREAMING_PREFIX.length)}`
    : model;
}

function resolveLegacySummaryDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return LEGACY_SESSION_SUMMARY_DAYS;
  }
  return Math.min(Math.trunc(value), MAX_SESSION_SUMMARY_LOOKBACK_DAYS);
}

function resolveSessionSummariesTarget(
  raw: Record<string, unknown>,
): { memoryCore: Record<string, unknown>; summaries: Record<string, unknown> } | null {
  const plugins = getOrCreateRecord(raw, "plugins");
  const entries = plugins ? getOrCreateRecord(plugins, "entries") : null;
  const memoryCore = entries ? getOrCreateRecord(entries, "memory-core") : null;
  const config = memoryCore ? getOrCreateRecord(memoryCore, "config") : null;
  const summaries = config ? getOrCreateRecord(config, "summaries") : null;
  return memoryCore && summaries ? { memoryCore, summaries } : null;
}

const LEGACY_SESSION_SUMMARIES_RULE: LegacyConfigRule = {
  path: ["agents", "session"],
  message:
    'agents.session summary settings moved to plugins.entries.memory-core.config.summaries; run "openclaw doctor --fix" to migrate them.',
  match: hasLegacySessionSummaryConfig,
};

function hasLegacyRotateBytes(value: unknown): boolean {
  const maintenance = getRecord(value);
  return Boolean(maintenance && Object.hasOwn(maintenance, "rotateBytes"));
}

function hasLegacyParentForkMaxTokens(value: unknown): boolean {
  const session = getRecord(value);
  return Boolean(session && Object.hasOwn(session, "parentForkMaxTokens"));
}

const LEGACY_SESSION_MAINTENANCE_ROTATE_BYTES_RULE: LegacyConfigRule = {
  path: ["session", "maintenance"],
  message:
    'session.maintenance.rotateBytes is deprecated and ignored; run "openclaw doctor --fix" to remove it.',
  match: hasLegacyRotateBytes,
};

const LEGACY_SESSION_PARENT_FORK_MAX_TOKENS_RULE: LegacyConfigRule = {
  path: ["session"],
  message:
    'session.parentForkMaxTokens was removed; parent fork sizing is automatic. Run "openclaw doctor --fix" to remove it.',
  match: hasLegacyParentForkMaxTokens,
};

/** Legacy config migration specs for session runtime config compatibility. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "agents.session.summary*->plugins.entries.memory-core.config.summaries",
    describe: "Move legacy session summary settings to the memory-core plugin",
    legacyRules: [LEGACY_SESSION_SUMMARIES_RULE],
    apply: (raw, changes) => {
      const agents = getRecord(raw.agents);
      const session = getRecord(agents?.session);
      if (!agents || !session || !hasLegacySessionSummaryConfig(session)) {
        return;
      }
      const target = resolveSessionSummariesTarget(raw);
      if (!target) {
        return;
      }
      const { memoryCore, summaries } = target;

      if (!Object.hasOwn(summaries, "enabled")) {
        summaries.enabled = true;
      }
      if (!Object.hasOwn(summaries, "autoInject")) {
        summaries.autoInject = true;
      }
      if (!Object.hasOwn(summaries, "model")) {
        summaries.model = resolveLegacySummaryModel(session.summaryModel);
      }
      if (!Object.hasOwn(summaries, "lookbackDays")) {
        summaries.lookbackDays = resolveLegacySummaryDays(session.summaryDays);
      }

      const pluginDisabled = memoryCore.enabled === false;
      const summariesDisabled = summaries.enabled !== true;
      let keptAgentOverrideDisabled = false;
      let keptModelOverrideDisabled = false;
      if (!pluginDisabled && !summariesDisabled) {
        const llm = getOrCreateRecord(memoryCore, "llm");
        if (llm) {
          if (!Object.hasOwn(llm, "allowAgentIdOverride")) {
            llm.allowAgentIdOverride = true;
          } else if (llm.allowAgentIdOverride === false) {
            keptAgentOverrideDisabled = true;
          }
          if (typeof summaries.model === "string" && summaries.model.trim()) {
            if (!Object.hasOwn(llm, "allowModelOverride")) {
              llm.allowModelOverride = true;
            } else if (llm.allowModelOverride === false) {
              keptModelOverrideDisabled = true;
            }
          }
        }
      }

      const removedMaxChars = Object.hasOwn(session, "summaryMaxChars");
      delete session.summaryModel;
      delete session.summaryDays;
      delete session.summaryMaxChars;
      if (Object.keys(session).length === 0) {
        delete agents.session;
      }
      changes.push(
        "Moved agents.session summary settings to plugins.entries.memory-core.config.summaries; preserved explicit target values and legacy defaults.",
      );
      if (removedMaxChars) {
        changes.push(
          "Removed agents.session.summaryMaxChars; memory-core maxPromptTokens has different semantics, so no token limit was inferred.",
        );
      }
      if (keptAgentOverrideDisabled) {
        changes.push(
          "Kept plugins.entries.memory-core.llm.allowAgentIdOverride=false; migrated summaries cannot generate until this policy is enabled.",
        );
      }
      if (keptModelOverrideDisabled) {
        changes.push(
          "Kept plugins.entries.memory-core.llm.allowModelOverride=false; migrated summaries.model cannot be used until this policy is enabled.",
        );
      }
      if (pluginDisabled) {
        changes.push(
          "Kept plugins.entries.memory-core.enabled=false; migrated summaries remain inactive and no LLM override permissions were added.",
        );
      } else if (summariesDisabled) {
        changes.push(
          "Kept plugins.entries.memory-core.config.summaries.enabled=false; no LLM override permissions were added.",
        );
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "session.maintenance.rotateBytes",
    describe: "Remove deprecated session.maintenance.rotateBytes",
    legacyRules: [LEGACY_SESSION_MAINTENANCE_ROTATE_BYTES_RULE],
    apply: (raw, changes) => {
      const maintenance = getRecord(getRecord(raw.session)?.maintenance);
      if (!maintenance || !Object.hasOwn(maintenance, "rotateBytes")) {
        return;
      }
      delete maintenance.rotateBytes;
      changes.push("Removed deprecated session.maintenance.rotateBytes.");
    },
  }),
  defineLegacyConfigMigration({
    id: "session.parentForkMaxTokens",
    describe: "Remove legacy session.parentForkMaxTokens",
    legacyRules: [LEGACY_SESSION_PARENT_FORK_MAX_TOKENS_RULE],
    apply: (raw, changes) => {
      const session = getRecord(raw.session);
      if (!session || !Object.hasOwn(session, "parentForkMaxTokens")) {
        return;
      }
      delete session.parentForkMaxTokens;
      changes.push("Removed session.parentForkMaxTokens; parent fork sizing is automatic.");
    },
  }),
];
