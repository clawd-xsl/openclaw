# Custom Commit Analysis for Porting `custom/20260314` onto `v2026.4.14`

This document tracks every custom commit that exists on `custom/20260314` after the branch point at `c30cabcca42d5a41b0e129a7ce9d438ff539e792`, with the goal of deciding how each change should be treated when bringing the codebase forward onto upstream release `v2026.4.14`.

Method:

- Base release worktree: `v2026.4.14`
- Source custom branch: `custom/20260314`
- Custom commit count reviewed: `43`
- Review order: chronological
- For each commit, record:
  - what the patch changes in code terms
  - why the patch exists
  - whether it is behavior-changing or maintenance-only
  - likely porting notes against `v2026.4.14`

Legend:

- `Port priority`: `high`, `medium`, `low`, `drop`, or `follow-up`
- `Behavior`: `yes`, `no`, or `mixed`

## 1. `80e504d867` `[port] fix(memory): batch SQLite writes in transaction to prevent event loop blocking`

- Files touched: `src/memory/manager-embedding-ops.ts`
- What changed:
  The file indexing write path now wraps the full SQLite update sequence in a single transaction. That includes clearing old indexed data, inserting chunk rows, replacing vector/FTS rows, and upserting the parent file record. Errors now roll the transaction back instead of leaving a partially written index state.
- Why this exists:
  The old implementation performed many synchronous SQLite writes one by one. That increases lock churn, fsync overhead, and the chance of event-loop stalls during large indexing operations.
- Behavior: `mixed`
- Port priority: `medium`
- Porting notes:
  This is both a performance and correctness hardening change: lower write jitter and atomic indexing state. Upstream `v2026.4.14` still appears to use the unbatched embedding write path in the analogous memory-core implementation, so this remains a real custom delta.

## 2. `df0cc1e544` `[port] fix(memory): enable SQLite WAL mode to reduce write contention`

- Files touched: `src/memory/manager-sync-ops.ts`
- What changed:
  In `openDatabaseAtPath()`, the memory SQLite open path now enables `PRAGMA journal_mode=WAL` in addition to `PRAGMA busy_timeout = 5000`.
- Why this exists:
  The custom branch was hardening the memory store against read/write contention and `SQLITE_BUSY` cases. WAL mode improves concurrent read/write behavior and makes the sync-memory path less fragile under load.
- Behavior: `mixed`
- Port priority: `medium`
- Porting notes:
  This is not an API or schema change, but it does change SQLite journaling behavior. Upstream `v2026.4.14` still appears to rely on `busy_timeout` only in the analogous memory DB open path, so this remains a real hardening delta rather than an already-absorbed change.

## 3. `36f4d9e398` `[port] fix(memory): add setImmediate yield in stale cleanup loops to prevent event loop blocking`

- Files touched: `src/memory/manager-sync-ops.ts`
- What changed:
  The stale-row cleanup loops for both `"memory"` and `"sessions"` now yield back to the event loop with `await new Promise((resolve) => setImmediate(resolve))` between delete iterations instead of running as a long uninterrupted sweep.
- Why this exists:
  This is runtime responsiveness hardening. Large stale-cleanup passes could otherwise monopolize the event loop and make memory sync or the surrounding process feel frozen.
- Behavior: `mixed`
- Port priority: `medium`
- Porting notes:
  This does not change external APIs, but it does reduce starvation risk in a hot maintenance path. It is adjacent to the other custom SQLite/memory hardening commits rather than superseded by them.

## 4. `3719905ed7` `[port] fix(hooks): add deleteAfterRun to hook CronJob to prevent session accumulation`

- Files touched: `src/gateway/server/hooks.ts`
- What changed:
  The synthetic one-shot `CronJob` created for hook-dispatched agent turns now sets `deleteAfterRun: true`.
- Why this exists:
  Hook executions were creating isolated cron sessions that could survive after completion. The downstream cleanup path already knew how to delete sessions when `job.deleteAfterRun` was set, so this commit opts hook jobs into that lifecycle.
- Behavior: `mixed`
- Port priority: `medium`
- Porting notes:
  This is a narrow but real lifecycle leak fix. It is also refined later by commit `4c0c47e73a`, which ensures the same cleanup runs across all delivery paths instead of only some of them.

## 5. `db2cb1dc83` `[port] feat(whatsapp): sticker routing + webp passthrough`

- Files touched: `extensions/whatsapp/src/inbound/send-api.ts`, `extensions/whatsapp/src/media.ts`
- What changed:
  Outbound WhatsApp sending now special-cases small `image/webp` payloads with an effectively empty caption and routes them as stickers instead of ordinary images. The media finalization path also treats WebP like GIF passthrough, skipping image optimization/transcoding and preserving the original bytes.
- Why this exists:
  This is a feature-oriented media-path customization for WhatsApp sticker support. It preserves sticker semantics instead of re-encoding sticker WebP content into a normal image flow.
- Behavior: `mixed`
- Port priority: `low`
- Porting notes:
  This is a real product customization, not just a bugfix. It does not appear to be absorbed by upstream `v2026.4.14`, but it is also not release-blocking unless this fork explicitly depends on WhatsApp sticker send behavior.

## 6. `8ee38ec1a1` `[port] fix(monitor): process recent append messages instead of skipping all on reconnect`

- Files touched: `extensions/whatsapp/src/inbound/monitor.ts`
- What changed:
  `handleMessagesUpsert()` no longer drops every `append` event on reconnect. It still marks append messages as read, but now only skips an appended message when its timestamp is missing or older than the socket's `connectedAtMs`. Recent append messages continue through inbound enrichment and queueing.
- Why this exists:
  Baileys can deliver live inbound messages as `append` during reconnect windows. The old blanket skip treated all append traffic as backlog, which meant legitimate new messages arriving right after reconnect were silently ignored.
- Behavior: `mixed`
- Port priority: `drop`
- Porting notes:
  This is a real reconnect bugfix, but it appears to be superseded upstream by the later reconnect handling changes around WhatsApp reply preservation, including a grace-window approach instead of the custom `connectedAtMs` cutoff. On `v2026.4.14`, re-check the current upstream monitor logic before reviving this exact patch.

## 7. `51730e8328` `[port] feat(sessions): main session bypasses tree visibility restriction for same-agent sessions`

- Files touched: `src/agents/tools/sessions-access.ts`
- What changed:
  Under `tools.sessions.visibility = tree`, the main requester session is now exempted from the strict spawned-subtree check. Subagents still remain tree-scoped, but the root/main session can access other sessions from the same agent without requiring `visibility = all`.
- Why this exists:
  The custom branch considered the original `tree` rule too restrictive for the main session. This broadens same-agent access while preserving tighter rules for subagents.
- Behavior: `yes`
- Port priority: `medium`
- Porting notes:
  This is a deliberate visibility-policy change, not just a bugfix. Upstream `v2026.4.14` still appears to use the narrower spawned-keys-only tree check, so porting it means intentionally carrying a wider session-access model.

## 8. `d69ec793c3` `[port] feat: inject compaction-recovery.md into summary message after compaction`

- Files touched: `src/agents/pi-embedded-runner/compact.ts`
- What changed:
  After compaction, the runner best-effort reads `COMPACTION.md` and injects its contents, plus recovery framing and the current session ID, into the first `compactionSummary` message before replacing the in-memory message list. The injected recovery text is truncated and failures are logged quietly.
- Why this exists:
  This is the first version of the custom compaction-recovery design. The intent is to make the first post-compaction retry self-recovering by showing explicit recovery instructions alongside the compacted summary.
- Behavior: `yes`
- Port priority: `medium`
- Porting notes:
  This exact implementation is not the mature end state of the feature. It is later refined by `21cbfdbaa3` and then effectively replaced by the persistent recovery-marker approach in `37ad5d0d22`, so if this feature is kept on `v2026.4.14`, port the later form rather than reviving this raw mutation logic unchanged.

## 9. `f6d401cef4` `[port] feat(subagent): reactivate done run-mode subagents on sessions_send`

- Files touched: `src/agents/subagent-registry.ts`, `src/agents/tools/sessions-send-tool.ts`
- What changed:
  The branch adds `reactivateSubagentRun(...)` so a completed run-mode subagent can be revived with a fresh run ID, cleared terminal state, and a restarted wait/announce lifecycle when `sessions_send` targets it. The sweeper also stops deleting child sessions whose cleanup policy is `"keep"`.
- Why this exists:
  Without this, sending to a completed run-mode subagent reused stale lifecycle state and broke the expected revive / wait / sweep behavior.
- Behavior: `mixed`
- Port priority: `follow-up`
- Porting notes:
  This is not the final form of the feature. It is explicitly refined by `61c685de43`, and the timeout semantics are corrected again in `32d5b828e7`, so port the later end state rather than this commit in isolation.

## 10. `61277c678d` `[port] fix: disable block streaming for heartbeat replies`

- Files touched: `src/auto-reply/reply/get-reply-directives.ts`
- What changed:
  Block streaming is now forcibly disabled for heartbeat runs by gating it on `!opts?.isHeartbeat`.
- Why this exists:
  Heartbeat replies should accumulate and normalize before delivery instead of streaming partial blocks. This prevents fragmented or prematurely flushed heartbeat output.
- Behavior: `yes`
- Port priority: `high`
- Porting notes:
  This is a narrow but important behavior guard. It does not appear to be superseded by later custom commits, and it directly protects heartbeat delivery semantics.

## 11. `56e9ffe439` `[port] fix: prevent duplicate message processing during finalize-drain race window`

- Files touched: `src/agents/pi-embedded-runner/run/attempt.ts`, `src/agents/pi-embedded-runner/runs.ts`, `src/auto-reply/reply/agent-runner-helpers.ts`, `src/auto-reply/reply/agent-runner.ts`
- What changed:
  This introduces the first version of `FINALIZING_SESSIONS` so a session still counts as active during the short teardown window between clearing the embedded run and scheduling follow-up drain. The reply path is updated to thread `sessionId` through follow-up finalization and clear the finalizing flag afterward.
- Why this exists:
  It fixes a race where a new message could arrive after the old run was cleared but before follow-up drain started, causing duplicate or stale processing.
- Behavior: `mixed`
- Port priority: `follow-up`
- Porting notes:
  This is only an intermediate step in a longer interrupt/finalize race series. Later commits `3b652fde95`, `dd7fccf448`, `81577c37a1`, and especially `8ad787ff0f` refine the design, so this commit should not be ported blindly by itself.

## 12. `ca16c6262a` `[port] fix: prevent duplicate runs in interrupt mode when active run exists`

- Files touched: `src/auto-reply/reply/get-reply-run.ts`, `src/auto-reply/reply/queue-policy.ts`
- What changed:
  Interrupt mode is adjusted so an already-active run is treated more like a follow-up/interrupt target instead of a fresh run opportunity. The logic now accounts for an active embedded run even when the queue lane itself is empty.
- Why this exists:
  This closes an interrupt-mode race that could start overlapping runs instead of cleanly interrupting the existing one.
- Behavior: `mixed`
- Port priority: `follow-up`
- Porting notes:
  This is quickly superseded and expanded by `51f6338141`, which adds abort waiting, abort-signal wiring, and stale-delivery suppression. Treat this as an intermediate precursor, not the final patch to port.

## 13. `51f6338141` `[port] fix: proper interrupt mode handling - wait for abort, wire abort signal, skip aborted delivery`

- Files touched: `src/agents/pi-embedded-runner/runs.ts`, `src/agents/pi-embedded-runner/run/attempt.ts`, `src/auto-reply/reply/agent-runner-helpers.ts`, `src/auto-reply/reply/agent-runner.ts`, `src/auto-reply/reply/block-reply-pipeline.ts`, `src/auto-reply/reply/get-reply-run.ts`
- What changed:
  Interrupt mode now aborts the currently active run, waits for it to unwind before starting the replacement run, and threads a run-level abort signal into block-reply delivery so buffered/staged output from the aborted run can be suppressed instead of leaking out after the interrupt.
- Why this exists:
  This is a deeper fix for the interrupt race: without it, a replacement run could start while the old run was still draining, causing stale or duplicate delivery.
- Behavior: `yes`
- Port priority: `follow-up`
- Porting notes:
  This is a major refinement of `ca16c6262a`, but it is still not the end of the interrupt/finalization bug series. Later commits `014172b1f4` and especially `8ad787ff0f` continue correcting the same execution path.

## 14. `b02de939cb` `[port] feat: add conversationTimestamp config to control per-message timestamp injection`

- Files touched: `src/auto-reply/reply/get-reply-run.ts`, `src/auto-reply/reply/inbound-meta.ts`, `src/config/schema.help.ts`, `src/config/schema.labels.ts`, `src/config/types.agent-defaults.ts`, `src/config/zod-schema.agent-defaults.ts`
- What changed:
  This adds a new config switch, `agents.defaults.conversationTimestamp`, and threads it into inbound prompt construction. When disabled, the model-visible per-message timestamp field is omitted from the conversation context block while timestamps remain available in stored session data.
- Why this exists:
  It is a prompt-shaping and operator-control feature: reduce timestamp noise, trim context, or avoid injecting time metadata into the model prompt.
- Behavior: `mixed`
- Port priority: `medium`
- Porting notes:
  This is a clean standalone customization rather than a bugfix chain. Upstream `v2026.4.14` does not appear to have the same config path, so keeping it on the new release would be an intentional product choice.

## 15. `21cbfdbaa3` `[port] refactor: improve compaction recovery boundary marker`

- Files touched: `src/agents/pi-embedded-runner/compact.ts`
- What changed:
  Instead of mutating the first `compactionSummary` message, the compaction path now appends a hidden custom message with `customType: "compaction-recovery"` that explicitly marks the boundary between retained context and the new conversation, then includes the recovery instructions from `COMPACTION.md`.
- Why this exists:
  This is a cleaner and more model-legible version of the earlier compaction-recovery idea. It places recovery guidance at the actual boundary instead of embedding it inside the summary blob.
- Behavior: `yes`
- Port priority: `follow-up`
- Porting notes:
  This improves on `d69ec793c3`, but it is still not the final form. The reusable/persistent implementation lands later in `37ad5d0d22`, which is the better candidate to port if this feature is kept.

## 16. `eaf035e70f` `[port] feat: track previousSessionId across session resets`

- Files touched: `src/auto-reply/reply/session.ts`, `src/auto-reply/templating.ts`, `src/config/sessions/types.ts`
- What changed:
  New session creation/reset now records `previousSessionId` onto the persisted session entry and exposes it through the template context. This establishes explicit lineage from the new session back to the session it was reset from.
- Why this exists:
  It lays the foundation for continuity-aware prompt construction, hooks, and session-summary features across `/new` or `/reset`.
- Behavior: `mixed`
- Port priority: `follow-up`
- Porting notes:
  This commit is foundational rather than complete on its own. It is consumed shortly afterward by `7b2a2c5229`, and later continuity/session-summary work depends on this metadata being present.

## 17. `88d12d95d8` `[port] fix: guard archiveSessionTranscripts with isNewSession to prevent session reset on every message`

- Files touched: `src/auto-reply/reply/session.ts`
- What changed:
  Transcript archiving is now guarded by `isNewSession` so the archive/reset path only runs during actual session creation/reset, not during ordinary inbound turns.
- Why this exists:
  The preceding continuity work made `previousSessionEntry` available more often, which exposed a bug where `archiveSessionTranscripts()` could run on every message and effectively treat the live session like it was constantly being reset.
- Behavior: `yes`
- Port priority: `high`
- Porting notes:
  This is a concrete lifecycle bugfix and should travel with any port of the `previousSessionId` continuity work. It does not appear to be superseded later in the branch.

## 18. `7b2a2c5229` `[port] feat: inject previousSessionId and session creation time into system prompt`

- Files touched: `src/agents/pi-embedded-runner/run/attempt.ts`, `src/agents/pi-embedded-runner/run/params.ts`, `src/agents/pi-embedded-runner/system-prompt.ts`, `src/agents/system-prompt.ts`, `src/auto-reply/reply/followup-runner.ts`, `src/auto-reply/reply/get-reply-run.ts`, `src/auto-reply/reply/queue/types.ts`, `src/auto-reply/reply/session.ts`, `src/config/sessions/types.ts`
- What changed:
  Session continuity metadata is now threaded end-to-end: new sessions record `createdAt`, reply/follow-up paths carry `previousSessionId` and `sessionCreatedAt`, and the system prompt gains a continuity block that shows the previous session and the current session's start time.
- Why this exists:
  This makes resets and new sessions less abrupt from the model's perspective by explicitly telling it what session preceded the current one and when the current session began.
- Behavior: `mixed`
- Port priority: `follow-up`
- Porting notes:
  This depends on the earlier `previousSessionId` plumbing and is further refined by `03ab0f8683`, which fixes propagation gaps through the embedded runner path.

## 19. `e01bdaf8ae` `[port] feat: session summary system (combined: generate, load, inject, search, CLI)`

- Major files/modules touched: `src/sessions/session-summary.ts`, `src/sessions/session-summary-loader.ts`, `src/sessions/session-summary-schema.ts`, `src/cli/summary-cli.ts`, `src/agents/tools/session-summaries-tool.ts`, `src/agents/system-prompt.ts`, `src/auto-reply/reply/session.ts`, `src/auto-reply/reply/get-reply-run.ts`, related config/schema files, tests, and memory schema wiring
- What changed:
  This is a large feature drop that introduces a session-summary subsystem. Archived JSONL sessions can be summarized with an LLM, persisted into a new `session_summaries` SQLite table, queried/loaded back later, exposed through a CLI, and injected into the system prompt as recent session history. It also adds an agent tool surface for searching summaries.
- Why this exists:
  It gives the fork persistent cross-session memory and session-history recall, rather than relying only on the live transcript window.
- Behavior: `mixed`
- Port priority: `follow-up`
- Porting notes:
  This commit lands the core system but not the complete rollout. The next follow-up `93a6dc5136` finishes tool registration and follow-up-run propagation, so this feature should be evaluated as a two-commit unit at minimum.

## 20. `03ab0f8683` `[port] fix: forward previousSessionId and recentSessionHistory through embedded runner pipeline`

- Files touched: `src/agents/pi-embedded-runner/run.ts`, `src/auto-reply/reply/agent-runner-utils.ts`
- What changed:
  The embedded runner param assembly is fixed so `previousSessionId`, `recentSessionHistory`, and `sessionCreatedAt` are forwarded all the way into `runEmbeddedAttempt(...)` instead of being computed earlier and then dropped before prompt construction.
- Why this exists:
  It closes a plumbing gap in the continuity/session-summary stack. Without this, the embedded runner could not actually see the continuity metadata that upstream reply code had already prepared.
- Behavior: `mixed`
- Port priority: `follow-up`
- Porting notes:
  This is an enabling fix for the continuity/session-summary feature set rather than a standalone feature by itself.

## 21. `ca7305a51d` `[port] fix(signal): prioritize sticker over attachment in inbound parsing + add sticker action`

- Files touched: `extensions/signal/src/monitor/event-handler.ts`, `extensions/signal/src/monitor/event-handler.types.ts`, `extensions/signal/src/send.ts`, `src/channels/plugins/actions/signal.ts`, minor call-site cleanup in `src/auto-reply/reply/agent-runner-utils.ts`
- What changed:
  Signal inbound parsing now prefers sticker metadata over generic attachment handling, and the channel action layer gains a first-class `sticker` action backed by `sendStickerSignal()`.
- Why this exists:
  It fixes sticker messages being treated as generic attachments and adds actual outbound sticker support for Signal.
- Behavior: `mixed`
- Port priority: `follow-up`
- Porting notes:
  This is a real channel customization, but not the only Signal-specific delta in the branch. It sits alongside the later quote-reply work and should be evaluated as part of the broader Signal customization set.

## 22. `02e33cbf36` `[port] feat: add Session Summaries tab to web control UI`

- Major files/modules touched: gateway protocol/schema for sessions RPCs, `src/gateway/server-methods/sessions.ts`, `ui/src/ui/controllers/summaries.ts`, `ui/src/ui/views/summaries.ts`, UI app/navigation wiring, and translation files
- What changed:
  This adds a new `sessions.summaries` RPC plus a "Session Summaries" tab in the web control UI. Operators can filter by time range, query, and session key, then browse stored summary cards with pagination.
- Why this exists:
  It surfaces the session-summary subsystem in the control UI instead of limiting it to prompt injection and CLI usage.
- Behavior: `yes`
- Port priority: `high`
- Porting notes:
  This depends on the earlier session-summary storage/query system and is later lightly refined by `93a6dc5136`. If the summary feature is kept, this UI surface is part of the intended product experience.

## 23. `cc07d52923` `[port] add REBASE-LOG.md`

- Files touched: `REBASE-LOG.md`
- What changed:
  This expands the rebase log into a fuller bookkeeping document for the earlier port/rebase effort, including carried commits, dropped items, and notes about the rewrite.
- Why this exists:
  Pure repository bookkeeping.
- Behavior: `no`
- Port priority: `drop`
- Porting notes:
  No runtime effect. Do not carry this into the new `v2026.4.14` bring-up unless you explicitly want historical notes inside the worktree.

## 24. `93a6dc5136` `[fix] session summary injection + tool registration`

- Files touched: `src/agents/openclaw-tools.ts`, `src/auto-reply/reply/get-reply-run.ts`, config/schema files, and web UI routing/i18n/tests for summaries
- What changed:
  This completes the initial summary rollout by wiring `recentSessionHistory` into the reply path, registering the `session_summaries` tool in the built-in toolset, adding summary config knobs such as `summaryDays` and `summaryMaxChars`, and finishing the control-UI summaries tab plumbing.
- Why this exists:
  The previous large summary commit landed the subsystem, but left parts of the runtime and UI integration incomplete. This commit makes the feature actually usable end-to-end.
- Behavior: `mixed`
- Port priority: `follow-up`
- Porting notes:
  This should be treated as the completion commit for `e01bdaf8ae`, not as a separate optional extra. The summary feature is not really whole without it.

## 25. `014172b1f4` `fix: preserve followup queue on abort in collect mode`

- Files touched: `src/auto-reply/reply/agent-runner.ts`
- What changed:
  In collect mode, aborting an in-flight run no longer clears the queued follow-up backlog. The code still finalizes through `finalizeWithFollowup(...)`, and finalizing cleanup is tightened so the backlog can continue draining instead of being dropped on abort.
- Why this exists:
  This fixes a real interrupt bug: abort should stop the active run, but it should not destroy queued messages that still need to be processed.
- Behavior: `yes`
- Port priority: `follow-up`
- Porting notes:
  This belongs to the same interrupt/finalization race series as `51f6338141` and `8ad787ff0f`. Treat it as part of that chain rather than as a standalone one-line fix.

## 26. `3b652fde95` `fix: prevent FINALIZING_SESSIONS leak on session reset`

- Files touched: `src/agents/pi-embedded-runner/run/attempt.ts`, `src/agents/pi-embedded-runner/runs.ts`, `src/agents/pi-embedded-subscribe.handlers.compaction.ts`, `src/auto-reply/reply/agent-runner-helpers.ts`, `src/auto-reply/reply/agent-runner.ts`, `src/infra/heartbeat-runner.ts`
- What changed:
  This reworks the `FINALIZING_SESSIONS` machinery so a session stays logically active during teardown, adds explicit `markSessionFinalizing` / `clearSessionFinalizing`, and ensures cleanup handles session ID mutation across resets by clearing both the original and updated IDs. The same commit also bundles a heartbeat transcript write-lock fix and a compaction-summary injection change.
- Why this exists:
  The primary bug is a finalizing-state leak after resets/teardown, which caused later messages to be misclassified as if a run were still active. The heartbeat hunk addresses a truncation race; the compaction hunk is effectively a bundled feature follow-up.
- Behavior: `mixed`
- Port priority: `follow-up`
- Porting notes:
  This is still not the final form of the interrupt/finalize fix chain. `8ad787ff0f` further tightens the race window, and `37ad5d0d22` replaces the bundled compaction piece with a cleaner persistent marker approach.

## 27. `e099e19d8a` `fix: clear finalizing flag in followup runner to prevent stuck isActive`

- Files touched: `src/auto-reply/reply/followup-runner.ts`
- What changed:
  The follow-up runner now explicitly clears the session's finalizing flag in its `finally` block after completion bookkeeping.
- Why this exists:
  `createFollowupRunner()` bypassed the normal cleanup path, so `FINALIZING_SESSIONS` could remain stuck and make later messages look like a run was still active forever.
- Behavior: `yes`
- Port priority: `high`
- Porting notes:
  This is part of the broader finalizing-state cleanup series and is later generalized by `dd7fccf448`, but it is a real bugfix in its own right.

## 28. `4c0c47e73a` `fix: ensure deleteAfterRun cleanup runs for all delivery paths`

- Files touched: `src/cron/isolated-agent/delivery-dispatch.ts`
- What changed:
  Session cleanup for `deleteAfterRun` isolated cron jobs is moved out to the outer dispatch scope and made idempotent, so cleanup runs regardless of which delivery path was taken, including cases where the agent already sent via the messaging tool.
- Why this exists:
  Hook/cron sessions that were supposed to self-delete could be orphaned because the old cleanup lived only inside one delivery path.
- Behavior: `mixed`
- Port priority: `medium`
- Porting notes:
  This is the follow-through needed to make the earlier hook `deleteAfterRun` flag actually reliable across all delivery modes.

## 29. `dd7fccf448` `fix: clear finalizing flag in all runEmbeddedPiAgent call sites`

- Files touched: `src/auto-reply/reply/agent-runner-execution.ts`, `src/auto-reply/reply/agent-runner-memory.ts`
- What changed:
  Finalizing-flag cleanup is extended beyond the follow-up runner to the main execution and memory-flush call sites around `runEmbeddedPiAgent()`.
- Why this exists:
  Fixing only the follow-up runner was not enough. Normal runs and heartbeat/memory-related paths could still leave `isEmbeddedPiRunActive()` stuck true and block later deliveries.
- Behavior: `yes`
- Port priority: `high`
- Porting notes:
  This is the broader cleanup follow-up to `e099e19d8a`. If the `FINALIZING_SESSIONS` design is kept, this change is part of making it actually safe.

## 30. `81577c37a1` `fix: clear FINALIZING_SESSIONS in agentCommandInternal finally block`

- Files touched: `src/commands/agent.ts`
- What changed:
  `agentCommandInternal` now clears the session's finalizing flag in its `finally` block, specifically covering the gateway `agent` command path after embedded runs finish.
- Why this exists:
  Subagent announce runs could otherwise leave `FINALIZING_SESSIONS` stuck forever on the gateway `agent` path, blackholing later work into queued/inactive states.
- Behavior: `yes`
- Port priority: `drop`
- Porting notes:
  This is a real bugfix on the custom branch's `FINALIZING_SESSIONS` design, but the explorer found that upstream `v2026.4.14` no longer uses that same mechanism in the same form. So this exact patch is likely obsolete on the new base.

## 31. `8ad787ff0f` `fix: eliminate repeat delivery bug on user interrupt`

- Files touched: `src/agents/pi-embedded-runner/run/attempt.ts`, `src/auto-reply/reply/agent-runner-helpers.ts`, `src/auto-reply/reply/agent-runner.ts`, `src/auto-reply/reply/queue/drain.ts`
- What changed:
  The interrupt path is tightened in three ways: aborted runs now discard buffered partial output before any flush, finalizing cleanup happens immediately after clearing the active run instead of later in follow-up finalization, and follow-up drain always refreshes its cached dispatcher callback so queued work cannot route through stale closures.
- Why this exists:
  It fixes the repeat-delivery / stale-delivery class of interrupt bugs where old output could still leak after an abort, or later follow-ups could run through dead dispatcher state.
- Behavior: `yes`
- Port priority: `high`
- Porting notes:
  This looks like the mature end state of the earlier interrupt/finalization bug series. If this family of custom fixes is kept on top of `v2026.4.14`, this is one of the commits to prioritize.

## 32. `ec2159a3ce` `feat(signal): add quote reply support (Phase 1 MVP)`

- Files touched: `extensions/signal/src/send.ts`, `src/channels/dock.ts`, `src/channels/plugins/outbound/signal.ts`, `src/config/types.signal.ts`, `src/config/zod-schema.providers-core.ts`, plus one config test
- What changed:
  Signal is plugged into the generic reply-threading system. The channel gains `replyToMode`, outbound Signal messages carry `replyToId`, and `sendMessageSignal` translates that into quoted-reply metadata for Signal RPC requests.
- Why this exists:
  This is a feature port to make Signal support quoted replies using the same `replyToMode` model other channels already use.
- Behavior: `mixed`
- Port priority: `follow-up`
- Porting notes:
  The explorer found that the later `61c685de43` refines this feature with corrected RPC field names and more complete end-to-end threading behavior. So this MVP should not be ported alone unless its follow-up is kept too.

## 33. `61c685de43` `fix(subagent): improve session revival via sessions_send`

- Files touched: `src/agents/tools/sessions-send-tool.ts`, `src/agents/subagent-registry.ts`, plus a bundled set of Signal quote-reply follow-ups in `extensions/signal/src/*` and related tests
- What changed:
  On the subagent side, `sessions_send` now treats wait timeouts as accepted async handoff, tries harder to reactivate completed runs, falls back to fresh registry records when reactivation cannot find prior state, avoids double announce flows, and preserves `cleanup: "keep"` runs by leaving `archiveAtMs` unset. The same commit also bundles Signal quote-reply correctness fixes for inbound quoted text preservation and outbound quoting on the first chunk only.
- Why this exists:
  Reviving a finished subagent session could otherwise lose lifecycle tracking or double-announce, and keep-cleanup runs were still being swept. The Signal hunks fix correctness gaps in the earlier quote-reply implementation.
- Behavior: `mixed`
- Port priority: `follow-up`
- Porting notes:
  This depends on earlier custom-only subagent revival work and the earlier Signal quote-reply feature. It is a refinement commit, not a good standalone cherry-pick unless those prerequisite customizations are kept.

## 34. `32d5b828e7` `Agents: preserve subagent timeout semantics`

- Files touched: `src/agents/pi-embedded-runner/run.ts`, `src/agents/pi-embedded-runner/types.ts`, `src/agents/subagent-registry.ts`, `src/commands/agent.ts`, `src/gateway/server-methods/agent-job.ts`, plus tests
- What changed:
  The runner metadata gains an explicit `timedOut` signal, and the agent/subagent lifecycle consumers are updated to use it instead of inferring timeout from generic abort state. Waiter-side timeout responses without terminal metadata no longer get mistaken for actual child-run termination.
- Why this exists:
  It fixes incorrect timeout semantics for subagents: non-timeout aborts were being mislabeled as timeouts, and `agent.wait` expiry on the caller side could prematurely mark a child run as ended.
- Behavior: `yes`
- Port priority: `high`
- Porting notes:
  This appears to be a durable correctness fix rather than an intermediate step. It is especially relevant if the custom branch relies on revived subagents and `agent.wait`-driven orchestration.

## 35. `9a9b42e3d3` `Tests: format waitForAgentJob lifecycle case`

- Files touched: none
- What changed:
  This is effectively an empty commit. Its tree matches the parent tree, and there is no code or test delta to port.
- Why this exists:
  Most likely bookkeeping or cherry-pick residue after the real lifecycle test edits had already been absorbed by the parent commit.
- Behavior: `no`
- Port priority: `drop`
- Porting notes:
  No runtime or test behavior changes to carry forward.

## 36. `37ad5d0d22` `Agents: persist auto-compaction recovery marker`

- Major files/modules touched: new `src/agents/compaction-recovery.ts`, `src/agents/pi-embedded-runner/compact.ts`, `src/agents/pi-embedded-runner/run/attempt.ts`, `src/agents/pi-embedded-subscribe.handlers.compaction.ts`, related types, and compaction tests
- What changed:
  The branch extracts compaction-recovery message creation into a shared helper and, more importantly, persists the hidden `compaction-recovery` boundary marker during auto-compaction/retry flows instead of only mutating in-memory direct-compaction messages. It also strips transient trailing error messages so the recovery marker lands directly after the retained context.
- Why this exists:
  Earlier compaction-recovery work did not reliably persist recovery guidance through auto-compaction retry paths. This makes the recovery marker survive transcript reloads and retry cycles.
- Behavior: `yes`
- Port priority: `follow-up`
- Porting notes:
  This is the mature form of the compaction-recovery feature on the custom branch, but it will need adaptation against `v2026.4.14` because the upstream compaction subscriber path has already diverged.

## 37. `f7cb28cb7d` `UI: remember gateway tokens by URL`

- Files touched: `ui/src/ui/storage.ts`, `ui/src/ui/app.ts`, `ui/src/ui/views/login-gate.ts`, `ui/src/ui/views/overview.ts`, related UI tests, and docs
- What changed:
  Control UI auth tokens move from tab/session-scoped storage to URL-keyed `localStorage`, with best-effort migration from the older storage location. When the gateway URL changes, the UI now reloads the remembered token for that URL instead of always clearing auth state.
- Why this exists:
  It is a convenience/UX improvement for switching between gateways, refreshing, and reopening tabs without re-pasting tokens every time.
- Behavior: `yes`
- Port priority: `low`
- Porting notes:
  This is a real product delta, but it is not a correctness blocker. It also has an explicit UX/security tradeoff because tokens persist longer than before.

## 38. `aef969d034` `Tools: honor aborts in PDF analysis`

- Major files/modules touched: `src/agents/tools/pdf-tool.ts`, `src/agents/tools/pdf-native-providers.ts`, `src/media/fetch.ts`, `src/media/pdf-extract.ts`, `extensions/whatsapp/src/media.ts`, new `src/utils/abort-timeout.ts`, plus tests
- What changed:
  PDF analysis now propagates `AbortSignal` and explicit timeouts end-to-end through remote download, extraction, native PDF API calls, and fallback model completion. The change also adds shared abort/timeout helpers and extends remote media fetching so long downloads can be canceled cleanly.
- Why this exists:
  Before this, PDF analysis could ignore caller aborts and keep running after cancellation, especially during remote fetch or provider-side analysis. This patch makes the tool stop when the run stops.
- Behavior: `yes`
- Port priority: `medium`
- Porting notes:
  This looks like a self-contained reliability fix rather than an intermediate branch-only experiment. It is worth evaluating directly against `v2026.4.14` if PDF analysis matters in this fork.

## 39. `eee6493af5` `fix: preserve session identity in chat.send for idle sessions`

- Files touched: `src/gateway/server-methods/chat.ts`
- What changed:
  Before `chat.send` dispatches an inbound message, it now best-effort refreshes the target session entry's `updatedAt` when that session already exists.
- Why this exists:
  Idle-session freshness checks were causing Web UI `chat.send` to rotate to a new `sessionId` after inactivity, breaking conversation continuity. The gateway `agent` path already refreshed session-store activity; `chat.send` did not.
- Behavior: `yes`
- Port priority: `high`
- Porting notes:
  This is a focused continuity bugfix for the control UI path and does not appear to be superseded later in the branch.

## 40. `14bee19d4b` `fix: retry debounce flush on failure to prevent message loss`

- Files touched: `src/auto-reply/inbound-debounce.ts`, `src/auto-reply/__tests__/inbound-debounce.test.ts`
- What changed:
  The inbound debouncer now keeps its batch alive while flushing, retries transient `onFlush` failures up to three times with `1s/2s/4s` backoff, and only removes successfully flushed items so messages appended during a retry window are preserved.
- Why this exists:
  The old implementation could effectively drop inbound messages if a debounce flush failed transiently.
- Behavior: `yes`
- Port priority: `medium`
- Porting notes:
  This is a real reliability fix, but the explorer found later debounce work elsewhere on the branch that continues reshaping the same area. So treat this as an intermediate implementation unless those later debounce commits are also accounted for.

## 41. `9acf99d5c0` `fix: reduce auth profile cooldown curve (5s→15s→45s→135s→3min cap)`

- Files touched: `src/agents/auth-profiles/usage.ts` and auth-profile cooldown tests
- What changed:
  The transient failure cooldown curve is shortened substantially, moving from the older long exponential backoff to `5s -> 15s -> 45s -> 135s -> 180s cap`.
- Why this exists:
  Long overlapping cooldown windows across profiles could make the gateway effectively unresponsive when several auth profiles failed around the same time.
- Behavior: `yes`
- Port priority: `drop`
- Porting notes:
  The explorer found that upstream `v2026.4.14` already has a newer, broader cooldown solution in the same area, so this exact retuning patch should not be carried forward verbatim.

## 42. `716855f9eb` `feat: decouple hook delivery from heartbeat runner`

- Files touched: `src/gateway/server/hooks.ts`, new `src/infra/hook-agent-turn.ts`
- What changed:
  Hook-triggered wakeups no longer go through the heartbeat runner. Instead, hooks request a dedicated main-lane agent turn with a synthetic `hook-event` context, so pending hook/system events are processed as a normal agent turn rather than a heartbeat-framed run.
- Why this exists:
  This separates hook delivery semantics from heartbeat semantics and avoids the duplication/odd framing issues that came from piggybacking hook announcements on heartbeat machinery.
- Behavior: `yes`
- Port priority: `high`
- Porting notes:
  This appears to be a durable architectural cleanup rather than a temporary workaround. If hook behavior matters in this fork, this is one of the higher-value custom deltas to preserve.

## 43. `19c9428592` `feat(openai): backport GPT-5 overlay`

- Major files/modules touched: `extensions/openai/*`, `src/agents/pi-embedded-runner/run.ts`, `src/agents/pi-embedded-runner/run/attempt.ts`, `src/plugins/types.ts`, `src/plugins/config-state.ts`, and related docs
- What changed:
  This adds a bundled OpenAI plugin that hooks `before_prompt_build` and appends a GPT-5-specific system overlay for `openai/*` and `openai-codex/*` models. It also threads `modelProviderId` and `modelId` through the Pi runner hook context so the overlay can scope itself to OpenAI-family models.
- Why this exists:
  It is a product customization that steers GPT-5 family models toward the branch's preferred response contract and execution style without affecting non-OpenAI providers.
- Behavior: `yes`
- Port priority: `drop`
- Porting notes:
  The explorer found this is already effectively subsumed by upstream `v2026.4.14`, which already contains the broader `extensions/openai` provider plugin and the relevant model hook plumbing. So this custom backport itself should not be re-ported on top of 4.14.
