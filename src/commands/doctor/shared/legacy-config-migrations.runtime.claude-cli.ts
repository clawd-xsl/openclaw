// Legacy Claude CLI config migration for the retired custom streaming backend id.
import {
  defineLegacyConfigMigration,
  getRecord,
  mergeMissing,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

const LEGACY_CLAUDE_CLI_BACKEND_ID = "claude-cli-streaming";
const CLAUDE_CLI_BACKEND_ID = "claude-cli";
const RETIRED_BACKEND_FIELDS = ["executionMode", "invalidateOnSystemPromptChange"] as const;

function hasRetiredBackendField(value: unknown): boolean {
  const backend = getRecord(value);
  return Boolean(backend && RETIRED_BACKEND_FIELDS.some((field) => Object.hasOwn(backend, field)));
}

function hasLegacyClaudeCliBackendConfig(value: unknown): boolean {
  const backends = getRecord(value);
  return Boolean(
    backends &&
    (Object.hasOwn(backends, LEGACY_CLAUDE_CLI_BACKEND_ID) ||
      hasRetiredBackendField(backends[CLAUDE_CLI_BACKEND_ID])),
  );
}

function hasLegacyClaudeCliRuntimeId(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasLegacyClaudeCliRuntimeId);
  }
  const record = getRecord(value);
  if (!record) {
    return false;
  }
  if (getRecord(record.agentRuntime)?.id === LEGACY_CLAUDE_CLI_BACKEND_ID) {
    return true;
  }
  return Object.values(record).some(hasLegacyClaudeCliRuntimeId);
}

function hasLegacyClaudeCliAuthConfig(value: unknown): boolean {
  const auth = getRecord(value);
  const profiles = getRecord(auth?.profiles);
  const order = getRecord(auth?.order);
  const billingBackoff = getRecord(getRecord(auth?.cooldowns)?.billingBackoffHoursByProvider);
  return Boolean(
    (profiles &&
      Object.values(profiles).some(
        (profile) => getRecord(profile)?.provider === LEGACY_CLAUDE_CLI_BACKEND_ID,
      )) ||
    (order && Object.hasOwn(order, LEGACY_CLAUDE_CLI_BACKEND_ID)) ||
    (billingBackoff && Object.hasOwn(billingBackoff, LEGACY_CLAUDE_CLI_BACKEND_ID)),
  );
}

function removeRetiredBackendFields(
  backend: Record<string, unknown>,
  path: string,
  changes: string[],
): void {
  for (const field of RETIRED_BACKEND_FIELDS) {
    if (!Object.hasOwn(backend, field)) {
      continue;
    }
    delete backend[field];
    changes.push(
      `Removed ${path}.${field}; the canonical Claude CLI backend owns live-session behavior.`,
    );
  }
}

function migrateClaudeCliBackends(raw: Record<string, unknown>, changes: string[]): void {
  const backends = getRecord(getRecord(getRecord(raw.agents)?.defaults)?.cliBackends);
  if (!backends) {
    return;
  }

  const canonical = getRecord(backends[CLAUDE_CLI_BACKEND_ID]);
  if (canonical) {
    removeRetiredBackendFields(
      canonical,
      `agents.defaults.cliBackends.${CLAUDE_CLI_BACKEND_ID}`,
      changes,
    );
  }

  if (!Object.hasOwn(backends, LEGACY_CLAUDE_CLI_BACKEND_ID)) {
    return;
  }
  const legacyValue = backends[LEGACY_CLAUDE_CLI_BACKEND_ID];
  const legacy = getRecord(legacyValue);
  if (legacy) {
    removeRetiredBackendFields(
      legacy,
      `agents.defaults.cliBackends.${LEGACY_CLAUDE_CLI_BACKEND_ID}`,
      changes,
    );
  }

  if (!Object.hasOwn(backends, CLAUDE_CLI_BACKEND_ID)) {
    backends[CLAUDE_CLI_BACKEND_ID] = legacyValue;
    changes.push(
      `Moved agents.defaults.cliBackends.${LEGACY_CLAUDE_CLI_BACKEND_ID} to agents.defaults.cliBackends.${CLAUDE_CLI_BACKEND_ID}.`,
    );
  } else if (canonical && legacy) {
    mergeMissing(canonical, legacy);
    changes.push(
      `Merged agents.defaults.cliBackends.${LEGACY_CLAUDE_CLI_BACKEND_ID} into agents.defaults.cliBackends.${CLAUDE_CLI_BACKEND_ID}; kept explicit canonical values.`,
    );
  } else {
    changes.push(
      `Removed agents.defaults.cliBackends.${LEGACY_CLAUDE_CLI_BACKEND_ID}; kept the existing agents.defaults.cliBackends.${CLAUDE_CLI_BACKEND_ID} value.`,
    );
  }
  delete backends[LEGACY_CLAUDE_CLI_BACKEND_ID];
}

function migrateClaudeCliRuntimeIds(value: unknown, path: string, changes: string[]): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      migrateClaudeCliRuntimeIds(entry, `${path}.${index}`, changes);
    }
    return;
  }
  const record = getRecord(value);
  if (!record) {
    return;
  }
  const runtime = getRecord(record.agentRuntime);
  if (runtime?.id === LEGACY_CLAUDE_CLI_BACKEND_ID) {
    runtime.id = CLAUDE_CLI_BACKEND_ID;
    changes.push(`Rewrote ${path}.agentRuntime.id to ${CLAUDE_CLI_BACKEND_ID}.`);
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === "agentRuntime") {
      continue;
    }
    migrateClaudeCliRuntimeIds(child, `${path}.${key}`, changes);
  }
}

function mergeProfileOrder(canonical: unknown[], legacy: unknown[]): unknown[] {
  const seen = new Set<string>();
  return [...canonical, ...legacy].filter((profileId) => {
    if (typeof profileId !== "string" || !seen.has(profileId)) {
      if (typeof profileId === "string") {
        seen.add(profileId);
      }
      return true;
    }
    return false;
  });
}

function migrateClaudeCliAuthConfig(raw: Record<string, unknown>, changes: string[]): void {
  const auth = getRecord(raw.auth);
  if (!auth) {
    return;
  }

  const profiles = getRecord(auth.profiles);
  let rewrittenProfiles = 0;
  if (profiles) {
    for (const profile of Object.values(profiles)) {
      const entry = getRecord(profile);
      if (entry?.provider === LEGACY_CLAUDE_CLI_BACKEND_ID) {
        entry.provider = CLAUDE_CLI_BACKEND_ID;
        rewrittenProfiles += 1;
      }
    }
  }
  if (rewrittenProfiles > 0) {
    changes.push(
      `Rewrote ${rewrittenProfiles} auth.profiles provider reference(s) from ${LEGACY_CLAUDE_CLI_BACKEND_ID} to ${CLAUDE_CLI_BACKEND_ID}; profile ids were kept unchanged.`,
    );
  }

  const order = getRecord(auth.order);
  if (order && Object.hasOwn(order, LEGACY_CLAUDE_CLI_BACKEND_ID)) {
    const legacyOrder = order[LEGACY_CLAUDE_CLI_BACKEND_ID];
    const canonicalOrder = order[CLAUDE_CLI_BACKEND_ID];
    if (!Object.hasOwn(order, CLAUDE_CLI_BACKEND_ID)) {
      order[CLAUDE_CLI_BACKEND_ID] = Array.isArray(legacyOrder)
        ? mergeProfileOrder([], legacyOrder)
        : legacyOrder;
      changes.push(`Moved auth.order.${LEGACY_CLAUDE_CLI_BACKEND_ID} to auth.order.claude-cli.`);
    } else if (Array.isArray(canonicalOrder) && Array.isArray(legacyOrder)) {
      order[CLAUDE_CLI_BACKEND_ID] = mergeProfileOrder(canonicalOrder, legacyOrder);
      changes.push(
        `Merged auth.order.${LEGACY_CLAUDE_CLI_BACKEND_ID} into auth.order.claude-cli; kept canonical order first and de-duplicated profile ids.`,
      );
    } else {
      changes.push(
        `Removed auth.order.${LEGACY_CLAUDE_CLI_BACKEND_ID}; kept the existing auth.order.claude-cli value.`,
      );
    }
    delete order[LEGACY_CLAUDE_CLI_BACKEND_ID];
  }

  const billingBackoff = getRecord(getRecord(auth.cooldowns)?.billingBackoffHoursByProvider);
  if (billingBackoff && Object.hasOwn(billingBackoff, LEGACY_CLAUDE_CLI_BACKEND_ID)) {
    if (!Object.hasOwn(billingBackoff, CLAUDE_CLI_BACKEND_ID)) {
      billingBackoff[CLAUDE_CLI_BACKEND_ID] = billingBackoff[LEGACY_CLAUDE_CLI_BACKEND_ID];
    }
    delete billingBackoff[LEGACY_CLAUDE_CLI_BACKEND_ID];
    changes.push(
      "Canonicalized auth.cooldowns.billingBackoffHoursByProvider for claude-cli; kept any existing canonical value.",
    );
  }
}

const LEGACY_CLAUDE_CLI_BACKEND_RULE: LegacyConfigRule = {
  path: ["agents", "defaults", "cliBackends"],
  message:
    'agents.defaults.cliBackends.claude-cli-streaming is retired; run "openclaw doctor --fix" to merge it into claude-cli and remove obsolete process fields.',
  match: hasLegacyClaudeCliBackendConfig,
};

const LEGACY_CLAUDE_CLI_RUNTIME_RULES: LegacyConfigRule[] = ["agents", "models"].map((section) => ({
  path: [section],
  message:
    'agentRuntime.id="claude-cli-streaming" is retired; run "openclaw doctor --fix" to use claude-cli.',
  match: hasLegacyClaudeCliRuntimeId,
}));

const LEGACY_CLAUDE_CLI_AUTH_RULE: LegacyConfigRule = {
  path: ["auth"],
  message:
    'auth provider references to "claude-cli-streaming" are retired; run "openclaw doctor --fix" to use claude-cli while preserving profile ids.',
  match: hasLegacyClaudeCliAuthConfig,
};

/** Legacy migration for the custom Claude streaming backend retired by persistent claude-cli. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_CLAUDE_CLI: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "claude-cli-streaming->claude-cli",
    describe: "Move retired Claude CLI streaming config to the canonical backend",
    legacyRules: [
      LEGACY_CLAUDE_CLI_BACKEND_RULE,
      ...LEGACY_CLAUDE_CLI_RUNTIME_RULES,
      LEGACY_CLAUDE_CLI_AUTH_RULE,
    ],
    apply: (raw, changes) => {
      migrateClaudeCliBackends(raw, changes);
      migrateClaudeCliRuntimeIds(raw.agents, "agents", changes);
      migrateClaudeCliRuntimeIds(raw.models, "models", changes);
      migrateClaudeCliAuthConfig(raw, changes);
    },
  }),
];
