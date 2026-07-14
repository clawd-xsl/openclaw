/** Provider ids for automated turns that must not mutate user-session routing or freshness. */
const SYSTEM_EVENT_PROVIDERS = new Set(["heartbeat", "cron-event", "exec-event", "system-event"]);

export function isSystemEventProvider(provider?: string): boolean {
  return provider !== undefined && SYSTEM_EVENT_PROVIDERS.has(provider);
}
