// Legacy migrations for configuration keys that only existed on the custom/20260415 branch.
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

const ALLOW_ALL_HOST_SEND_FILE_TYPES = "allowAllHostSendFileTypes";

function getLegacyDefaultFs(raw: Record<string, unknown>): Record<string, unknown> | null {
  const defaults = getRecord(getRecord(raw.agents)?.defaults);
  return getRecord(getRecord(defaults?.tools)?.fs);
}

function hasLegacyDefaultFsPolicy(value: unknown): boolean {
  const defaults = getRecord(value);
  const fs = getRecord(getRecord(defaults?.tools)?.fs);
  return Object.hasOwn(fs ?? {}, ALLOW_ALL_HOST_SEND_FILE_TYPES);
}

function hasLegacyHookMappingDeleteAfterRun(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => Object.hasOwn(getRecord(entry) ?? {}, "deleteAfterRun"))
  );
}

const REMOVED_CUSTOM_CONFIG_RULES: LegacyConfigRule[] = [
  {
    path: ["gateway", "cliMcp"],
    message: 'gateway.cliMcp is no longer supported. Run "openclaw doctor --fix" to remove it.',
  },
  {
    path: ["agents", "defaults"],
    message:
      'agents.defaults.tools.fs.allowAllHostSendFileTypes moved to tools.fs.allowAllHostSendFileTypes. Run "openclaw doctor --fix" to migrate it.',
    match: hasLegacyDefaultFsPolicy,
  },
  {
    path: ["hooks", "mappings"],
    message:
      'hooks.mappings[].deleteAfterRun is no longer supported. Run "openclaw doctor --fix" to remove it.',
    match: hasLegacyHookMappingDeleteAfterRun,
  },
  {
    path: ["agents", "defaults", "untrustedSystemEventsDowngradeSenderIsOwner"],
    message:
      'agents.defaults.untrustedSystemEventsDowngradeSenderIsOwner is no longer supported. Run "openclaw doctor --fix" to remove it.',
  },
];

/** Runtime migrations for config keys retired with custom/20260415. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_CUSTOM: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "custom.20260415.remove-unsupported-config",
    describe: "Remove unsupported custom/20260415 configuration keys",
    legacyRules: REMOVED_CUSTOM_CONFIG_RULES,
    apply: (raw, changes) => {
      const gateway = getRecord(raw.gateway);
      if (gateway && Object.hasOwn(gateway, "cliMcp")) {
        delete gateway.cliMcp;
        changes.push("Removed unsupported gateway.cliMcp.");
      }

      const agents = getRecord(raw.agents);
      const defaults = getRecord(agents?.defaults);
      const legacyDefaultFs = getLegacyDefaultFs(raw);
      if (legacyDefaultFs && Object.hasOwn(legacyDefaultFs, ALLOW_ALL_HOST_SEND_FILE_TYPES)) {
        const legacyValue = legacyDefaultFs[ALLOW_ALL_HOST_SEND_FILE_TYPES];
        const tools = getRecord(raw.tools) ?? {};
        const fs = getRecord(tools.fs) ?? {};
        const alreadyConfigured = Object.hasOwn(fs, ALLOW_ALL_HOST_SEND_FILE_TYPES);
        if (!alreadyConfigured) {
          fs[ALLOW_ALL_HOST_SEND_FILE_TYPES] = legacyValue;
          tools.fs = fs;
          raw.tools = tools;
        }
        delete legacyDefaultFs[ALLOW_ALL_HOST_SEND_FILE_TYPES];
        const defaultTools = getRecord(defaults?.tools);
        if (Object.keys(legacyDefaultFs).length === 0 && defaultTools) {
          delete defaultTools.fs;
        }
        if (defaultTools && Object.keys(defaultTools).length === 0 && defaults) {
          delete defaults.tools;
        }
        changes.push(
          alreadyConfigured
            ? "Removed obsolete agents.defaults.tools.fs.allowAllHostSendFileTypes; tools.fs.allowAllHostSendFileTypes is already configured."
            : "Moved agents.defaults.tools.fs.allowAllHostSendFileTypes to tools.fs.allowAllHostSendFileTypes.",
        );
      }
      const mappings = getRecord(raw.hooks)?.mappings;
      if (Array.isArray(mappings)) {
        mappings.forEach((entry, index) => {
          const mapping = getRecord(entry);
          if (!mapping || !Object.hasOwn(mapping, "deleteAfterRun")) {
            return;
          }
          delete mapping.deleteAfterRun;
          changes.push(`Removed unsupported hooks.mappings.${index}.deleteAfterRun.`);
        });
      }

      if (defaults && Object.hasOwn(defaults, "untrustedSystemEventsDowngradeSenderIsOwner")) {
        delete defaults.untrustedSystemEventsDowngradeSenderIsOwner;
        changes.push(
          "Removed unsupported agents.defaults.untrustedSystemEventsDowngradeSenderIsOwner.",
        );
      }
    },
  }),
];
