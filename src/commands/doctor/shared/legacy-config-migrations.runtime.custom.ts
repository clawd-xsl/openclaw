// Legacy migrations for configuration keys that only existed on the custom/20260415 branch.
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

const ALLOW_ALL_HOST_SEND_FILE_TYPES = "allowAllHostSendFileTypes";

function getToolsFs(owner: Record<string, unknown> | null): Record<string, unknown> | null {
  return getRecord(getRecord(owner?.tools)?.fs);
}

function hasAllowAllHostSendFileTypes(owner: Record<string, unknown> | null): boolean {
  return Object.hasOwn(getToolsFs(owner) ?? {}, ALLOW_ALL_HOST_SEND_FILE_TYPES);
}

function hasLegacyAgentListFsConfig(value: unknown): boolean {
  return (
    Array.isArray(value) && value.some((entry) => hasAllowAllHostSendFileTypes(getRecord(entry)))
  );
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
    path: ["tools", "fs", ALLOW_ALL_HOST_SEND_FILE_TYPES],
    message:
      'tools.fs.allowAllHostSendFileTypes is no longer supported. Run "openclaw doctor --fix" to remove it.',
  },
  {
    path: ["agents", "defaults", "tools", "fs", ALLOW_ALL_HOST_SEND_FILE_TYPES],
    message:
      'agents.defaults.tools.fs.allowAllHostSendFileTypes is no longer supported. Run "openclaw doctor --fix" to remove it.',
  },
  {
    path: ["agents", "list"],
    message:
      'agents.list[].tools.fs.allowAllHostSendFileTypes is no longer supported. Run "openclaw doctor --fix" to remove it.',
    match: hasLegacyAgentListFsConfig,
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

function removeAllowAllHostSendFileTypes(params: {
  changes: string[];
  owner: Record<string, unknown> | null;
  path: string;
}): void {
  const fs = getToolsFs(params.owner);
  if (!fs || !Object.hasOwn(fs, ALLOW_ALL_HOST_SEND_FILE_TYPES)) {
    return;
  }
  delete fs[ALLOW_ALL_HOST_SEND_FILE_TYPES];
  params.changes.push(`Removed unsupported ${params.path}.`);
}

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

      removeAllowAllHostSendFileTypes({
        changes,
        owner: raw,
        path: "tools.fs.allowAllHostSendFileTypes",
      });

      const agents = getRecord(raw.agents);
      const defaults = getRecord(agents?.defaults);
      removeAllowAllHostSendFileTypes({
        changes,
        owner: defaults,
        path: "agents.defaults.tools.fs.allowAllHostSendFileTypes",
      });

      if (Array.isArray(agents?.list)) {
        agents.list.forEach((entry, index) => {
          removeAllowAllHostSendFileTypes({
            changes,
            owner: getRecord(entry),
            path: `agents.list.${index}.tools.fs.allowAllHostSendFileTypes`,
          });
        });
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
