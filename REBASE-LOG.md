# Rebase Log: custom/20260226 → custom/20260314

**Started:** 2026-03-14
**Completed:** 2026-03-14
**Base:** custom/20260314 (upstream/main as of 2026-03-14)
**Source:** custom/20260226 (26 custom commits)
**Result:** 22 ported commits (1 dropped, 4 combined into 1)

## Summary

All 26 custom commits evaluated and ported. One dropped (upstream equivalent). Five session-summary commits combined into one large commit.

## Dropped

- dd02f76956 fix(whatsapp): pass mediaLocalRoots in sendMedia — upstream refactored deliver-reply.ts to properly handle mediaLocalRoots

## Combined

- ec23b24426 + 0ee6b7fce4 + 5fb3d25e42 + 664815b35f → single "[port] feat: session summary system" commit
- 2683b03b73 ported separately as web UI commit

## All 22 Ported Commits (newest first)

1. [port] feat: add Session Summaries tab to web control UI
2. [port] fix(signal): prioritize sticker over attachment in inbound parsing + add sticker action
3. [port] fix: forward previousSessionId and recentSessionHistory through embedded runner pipeline
4. [port] feat: session summary system (combined: generate, load, inject, search, CLI)
5. [port] feat: inject previousSessionId and session creation time into system prompt
6. [port] fix: guard archiveSessionTranscripts with isNewSession
7. [port] feat: track previousSessionId across session resets
8. [port] refactor: improve compaction recovery boundary marker
9. [port] feat: add conversationTimestamp config
10. [port] fix: proper interrupt mode handling - wait for abort, wire abort signal
11. [port] fix: prevent duplicate runs in interrupt mode
12. [port] fix: prevent duplicate message processing during finalize-drain race
13. [port] fix: disable block streaming for heartbeat replies
14. [port] feat(subagent): reactivate done run-mode subagents on sessions_send
15. [port] feat: inject compaction-recovery.md into summary message after compaction
16. [port] feat(sessions): main session bypasses tree visibility restriction
17. [port] fix(monitor): process recent append messages instead of skipping all on reconnect
18. [port] feat(whatsapp): sticker routing + webp passthrough
19. [port] fix(hooks): add deleteAfterRun to hook CronJob
20. [port] fix(memory): add setImmediate yield in stale cleanup loops
21. [port] fix(memory): enable SQLite WAL mode
22. [port] fix(memory): batch SQLite writes in transaction

## Build Status

pnpm build succeeds. Pre-existing TS errors (chrome-mcp, codex-oauth) are unrelated.

## Key Rewrites

- WhatsApp files moved: src/web/ → extensions/whatsapp/src/
- Signal files moved: src/signal/ → extensions/signal/src/
- Subagent registry: embeddedRunState pattern instead of direct Map
- Protocol schema: SchemaType<> pattern + ProtocolSchemas registration
