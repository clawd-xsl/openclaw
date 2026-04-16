# Custom Port Plan for `custom/20260314` onto `v2026.4.14`

This document tracks port planning for every custom commit on `custom/20260314` against upstream release `v2026.4.14`.

Method:

- Base release: `v2026.4.14`
- Source branch: `custom/20260314`
- Scope: every custom commit after `c30cabcca42d5a41b0e129a7ce9d438ff539e792`
- For each commit, decide:
  - whether it is necessary to port
  - whether it can be ported cleanly onto `v2026.4.14`
  - likely conflict areas
  - a proposed detailed port plan

Legend:

- `Need`: `must`, `should`, `optional`, `no`
- `Can port`: `yes`, `partial`, `no`
- `Conflict risk`: `low`, `medium`, `high`

## 1. `80e504d867` `[port] fix(memory): batch SQLite writes in transaction to prevent event loop blocking`

- Need: `should`
- Can port: `yes`
- Conflict risk: `medium`
- Why/decision:
  The custom commit makes per-file memory indexing writes atomic by wrapping chunk, vector, FTS, and file-record updates in one SQLite transaction. On `v2026.4.14`, the same write path still exists and remains unbatched, although it has been refactored into `extensions/memory-core/src/memory/manager-embedding-ops.ts` and `writeChunks(...)`.
- Likely conflicts on `v2026.4.14`:
  The file moved from `src/memory/manager-embedding-ops.ts` to `extensions/memory-core/src/memory/manager-embedding-ops.ts`, and the affected logic was extracted into `writeChunks(...)`. Current upstream also has helperized vector replacement and degraded-mode warning paths that need to be preserved.
- Proposed port plan:
  Manually port the behavior into `extensions/memory-core/src/memory/manager-embedding-ops.ts` by wrapping the mutating body of `writeChunks(...)` in `BEGIN` / `COMMIT` with guarded `ROLLBACK` on failure. Keep the current helper structure intact, and add a focused failure-path test to verify no partial chunk/vector/FTS/file-record state remains after a mid-write error.

## 2. `df0cc1e544` `[port] fix(memory): enable SQLite WAL mode to reduce write contention`

- Need: `should`
- Can port: `yes`
- Conflict risk: `low`
- Why/decision:
  This is still a real hardening delta on `v2026.4.14`: the source patch adds `PRAGMA journal_mode=WAL`, while the equivalent current open path in `extensions/memory-core/src/memory/manager-db.ts` still appears to set only `busy_timeout`. Upstream has not absorbed this exact change, and the current atomic reindex flow already handles `-wal` and `-shm` sidecar files.
- Likely conflicts on `v2026.4.14`:
  The main drift is file location: the target is now `extensions/memory-core/src/memory/manager-db.ts`, not the old `src/memory/manager-sync-ops.ts`. Test coverage would also need updating because the current recovery/open tests appear to assert `busy_timeout` only.
- Proposed port plan:
  Add `db.exec(\"PRAGMA journal_mode=WAL\");` to `openMemoryDatabaseAtPath()` in `extensions/memory-core/src/memory/manager-db.ts`, keep the existing `busy_timeout` pragma, add a file-backed SQLite test that asserts WAL mode, and run targeted memory-core tests for DB open/recovery plus atomic reindex behavior.

## 3. `36f4d9e398` `[port] fix(memory): add setImmediate yield in stale cleanup loops to prevent event loop blocking`

- Need: `should`
- Can port: `yes`
- Conflict risk: `medium`
- Why/decision:
  The custom change adds `await new Promise((resolve) => setImmediate(resolve));` before each stale-row delete iteration in the memory and session cleanup loops. `v2026.4.14` still has equivalent stale-prune loops in `extensions/memory-core/src/memory/manager-sync-ops.ts` without the yield, so the responsiveness hardening is still missing upstream.
- Likely conflicts on `v2026.4.14`:
  The file moved from `src/memory/manager-sync-ops.ts` to `extensions/memory-core/src/memory/manager-sync-ops.ts`, and the surrounding implementation was refactored around prepared statements and newer sync-plan helpers. A straight cherry-pick will probably not apply cleanly, even though the semantic change is small.
- Proposed port plan:
  Manually add the same `setImmediate` yield immediately before the delete sequence in both stale cleanup loops in `extensions/memory-core/src/memory/manager-sync-ops.ts`, keeping the current prepared-statement flow intact. After porting, run targeted memory sync coverage or a large stale-prune/manual sync to confirm the cleanup no longer monopolizes the event loop.

## 4. `3719905ed7` `[port] fix(hooks): add deleteAfterRun to hook CronJob to prevent session accumulation`

- Need: `should`
- Can port: `partial`
- Conflict risk: `medium`
- Why/decision:
  The underlying lifecycle fix is still valid on `v2026.4.14`: hook-created synthetic cron jobs still need `deleteAfterRun: true`. But on the current base, that one-line flag is not sufficient by itself because cleanup still misses some delivery paths.
- Likely conflicts on `v2026.4.14`:
  `src/gateway/server/hooks.ts` has nearby refactors, so the original hunk will not apply verbatim. More importantly, `src/cron/isolated-agent/delivery-dispatch.ts` still needs the later cleanup broadening so delete-after-run actually fires for all hook delivery modes.
- Proposed port plan:
  Treat this as a bundled manual port with `4c0c47e73a`. Add `deleteAfterRun: true` to the synthetic hook job in `src/gateway/server/hooks.ts`, then port/adapt the delivery-dispatch cleanup broadening so delete-after-run cleanup executes for all hook paths, including shared-delivery and message-tool cases. Add regression coverage in both hook job creation and isolated-delivery cleanup.

## 5. `db2cb1dc83` `[port] feat(whatsapp): sticker routing + webp passthrough`

- Need: `optional`
- Can port: `partial`
- Conflict risk: `high`
- Why/decision:
  This remains a WhatsApp-specific feature customization rather than a release blocker. The sticker-routing intent still fits the current send path, but the old WebP passthrough half no longer maps cleanly because outbound media loading has been centralized and current `v2026.4.14` behavior already expects common WebP inputs to be recompressed in some paths.
- Likely conflicts on `v2026.4.14`:
  The patch will not apply literally. `extensions/whatsapp/src/media.ts` is now just a re-export, and the real loader logic lives in shared media code. Reintroducing the old WebP passthrough there would change behavior for more than WhatsApp.
- Proposed port plan:
  Do not cherry-pick this commit verbatim. If WhatsApp sticker send support is wanted, re-port only the WhatsApp-specific intent: keep shared media loading unchanged, add a WhatsApp-only sticker candidate path that preserves raw small WebP when caption is effectively empty, then add the `sticker` payload branch in `extensions/whatsapp/src/inbound/send-api.ts`. Add focused tests proving sticker WebP stays raw while normal WebP still follows current upstream recompression behavior.

## 6. `8ee38ec1a1` `[port] fix(monitor): process recent append messages instead of skipping all on reconnect`

- Need: `no`
- Can port: `no`
- Conflict risk: `high`
- Why/decision:
  `v2026.4.14` already contains a stronger upstream replacement in the same WhatsApp monitor path: recent `append` messages are preserved with a grace window and safer timestamp coercion. Porting this older custom patch would be a regression, not an improvement.
- Likely conflicts on `v2026.4.14`:
  Direct overlap in `extensions/whatsapp/src/inbound/monitor.ts` around the `append` handling inside `handleMessagesUpsert()`. The custom logic would fight the current grace-window path and protobuf `Long` handling.
- Proposed port plan:
  Do not port `8ee38ec1a1`. Record it as already absorbed and improved upstream, and leave the current `v2026.4.14` implementation unchanged.

## 7. `51730e8328` `[port] feat(sessions): main session bypasses tree visibility restriction for same-agent sessions`

- Need: `no`
- Can port: `yes`
- Conflict risk: `medium`
- Why/decision:
  `v2026.4.14` still has the narrower `tree` guard, but it also now exposes a clearer `agent` visibility tier for same-agent access. That means the custom behavior is already representable without redefining what `tree` means. Carrying this patch forward would blur a distinction the current upstream model now makes explicit.
- Likely conflicts on `v2026.4.14`:
  This would be a semantic conflict with the newer `self | tree | agent | all` visibility model in `src/agents/tools/sessions-access.ts`. Porting it would partially collapse the distinction between `tree` and `agent` for main sessions and likely require policy/test/doc changes.
- Proposed port plan:
  Do not port `51730e8328`. If broader same-agent access is still desired, make that an explicit product/config choice by using or defaulting to `tools.sessions.visibility=agent`, and add targeted tests around the chosen policy instead of widening `tree` implicitly.

## 8. `d69ec793c3` `[port] feat: inject compaction-recovery.md into summary message after compaction`

- Need: `no`
- Can port: `partial`
- Conflict risk: `high`
- Why/decision:
  `v2026.4.14` still does not have this exact recovery injection, but this commit is only the first and outdated implementation. It mutates the first `compactionSummary` in one compaction path, and the custom branch later replaces it with the better boundary-marker design and then the persistent implementation in `37ad5d0d22`.
- Likely conflicts on `v2026.4.14`:
  `src/agents/pi-embedded-runner/compact.ts` has diverged significantly, and the current compaction stack includes more than the old single direct-compaction path. Porting this raw implementation would miss engine-owned and retry-related flows.
- Proposed port plan:
  Do not port `d69ec793c3` directly. Mark it as superseded and handle compaction-recovery only through the later mature marker-based implementation when evaluating `37ad5d0d22`.

## 9. `f6d401cef4` `[port] feat(subagent): reactivate done run-mode subagents on sessions_send`

- Need: `should`
- Can port: `partial`
- Conflict risk: `high`
- Why/decision:
  The behavior gap still matters on `v2026.4.14`: `sessions_send` does not cleanly revive completed run-mode subagents. But this commit is only the first/intermediate version. Parts of its cleanup handling are already effectively present upstream, and the rest is later refined by `61c685de43` and then corrected again by `32d5b828e7`.
- Likely conflicts on `v2026.4.14`:
  Both `src/agents/subagent-registry.ts` and `src/agents/tools/sessions-send-tool.ts` have diverged substantially. Directly replaying this commit would conflict in both files and still miss fallback registration, double-announce suppression, and timeout correctness.
- Proposed port plan:
  Do not port `f6d401cef4` by itself. When porting this area, target the later end state: combine the revival flow from `61c685de43` with the timeout semantics fix from `32d5b828e7`, adapting both to the current registry/run-manager seam and current `sessions_send` waiting path. Add focused tests for completed-run revival, swept-record fallback, and timeout-preserving handoff behavior.

## 10. `61277c678d` `[port] fix: disable block streaming for heartbeat replies`

- Need: `should`
- Can port: `yes`
- Conflict risk: `low`
- Why/decision:
  `v2026.4.14` still appears to have the pre-fix predicate in `src/auto-reply/reply/get-reply-directives.ts`, and heartbeat runs can still inherit block streaming behavior. The gap remains real and there does not appear to be an equivalent downstream workaround.
- Likely conflicts on `v2026.4.14`:
  Very little. The touched gate in `src/auto-reply/reply/get-reply-directives.ts` is still close to the source version, so this is mostly line drift plus missing regression coverage.
- Proposed port plan:
  Apply the one-line `!opts?.isHeartbeat` guard in `src/auto-reply/reply/get-reply-directives.ts` so heartbeat runs always force `blockStreamingEnabled` off. Add a focused regression test proving heartbeat turns disable block streaming while ordinary turns preserve current behavior.

## 11. `56e9ffe439` `[port] fix: prevent duplicate message processing during finalize-drain race window`

- Need: `no`
- Can port: `no`
- Conflict risk: `medium`
- Why/decision:
  This is an intermediate fix from an older race-condition series. On `v2026.4.14`, the original activity-gap is already handled through the newer reply-run-registry architecture, which keeps the session logically active for the whole reply operation until follow-up finalization finishes.
- Likely conflicts on `v2026.4.14`:
  The current `runs.ts`, `agent-runner.ts`, and embedded attempt flow are structured around reply-run-registry state, not the old `FINALIZING_SESSIONS` shim. Reintroducing that extra layer here would be redundant and could create new stuck-active paths unless the whole later cleanup series came with it.
- Proposed port plan:
  Do not port `56e9ffe439`. Treat it as superseded by current upstream architecture. If interrupt/duplicate-delivery issues remain, review and port only the missing end-state behavior from the later series, with tests written against the current reply-run-registry lifecycle.

## 12. `ca16c6262a` `[port] fix: prevent duplicate runs in interrupt mode when active run exists`

- Need: `no`
- Can port: `no`
- Conflict risk: `high`
- Why/decision:
  This is an older precursor fix. `v2026.4.14` already routes interrupt-mode active-run handling through newer queue helpers that explicitly abort, wait for shutdown, refresh state, and then continue. That covers the bug more completely than this commit does.
- Likely conflicts on `v2026.4.14`:
  Both touched areas have moved: `get-reply-run.ts` is now structured around newer queue-state helpers, and `queue-policy.ts` is semantically coupled to that newer design. Porting the old interrupt-as-followup rule here would actually fight the current architecture.
- Proposed port plan:
  Skip `ca16c6262a`. Do not port either hunk directly. If interrupt-mode issues still remain, evaluate the later end-state fixes from this family against the current queue-helper boundary rather than transplanting this precursor commit.

## 13. `51f6338141` `[port] fix: proper interrupt mode handling - wait for abort, wire abort signal, skip aborted delivery`

- Need: `should`
- Can port: `partial`
- Conflict risk: `high`
- Why/decision:
  `v2026.4.14` has already absorbed most of this commit in newer shapes: wait-for-abort, run-level abort propagation, and silent finalization for user aborts are largely present. The missing value is narrower now: block-reply delivery still lacks a run-level abort hook, and interrupt takeover still appears not to clear stale queued followups in the newer queue cleanup path.
- Likely conflicts on `v2026.4.14`:
  A direct cherry-pick will not apply. The old commit was written against the earlier `runs.ts` / monolithic reply-run structure; current upstream has split this into reply-run-registry, queue helpers, and newer execution plumbing.
- Proposed port plan:
  Do not port `51f6338141` verbatim. Port only the missing end-state semantics into current abstractions: add run-level abort handling to the block-reply pipeline, thread `replyOperation.abortSignal` through the current execution path, clear queued followups during interrupt takeover using current queue cleanup helpers, and add regressions for “interrupt clears stale followups” plus “aborted run cannot leak queued block replies.”

## 14. `b02de939cb` `[port] feat: add conversationTimestamp config to control per-message timestamp injection`

- Need: `optional`
- Can port: `partial`
- Conflict risk: `medium`
- Why/decision:
  `v2026.4.14` already partially subsumes the intent through the newer envelope-format path: `envelopeTimestamp=off` can already suppress the conversation-info timestamp. So the remaining custom delta is not “timestamp control exists vs not,” but rather “do we want a separate conversation-timestamp knob independent from envelope timestamp.”
- Likely conflicts on `v2026.4.14`:
  The touched code has moved to the newer envelope-format plumbing, and config metadata now also flows through generated schema artifacts. Porting the old six-file patch directly would not fit cleanly.
- Proposed port plan:
  Skip this port unless you explicitly want envelope timestamps and conversation-info timestamps to be independently configurable. If you do want that split, port the intent rather than the old patch: add a new `conversationTimestamp` config key, thread it separately from current envelope settings, regenerate config schema artifacts, and add tests proving the two knobs remain independent.

## 15. `21cbfdbaa3` `[port] refactor: improve compaction recovery boundary marker`

- Need: `no`
- Can port: `no`
- Conflict risk: `high`
- Why/decision:
  This is only the improved middle step of the compaction-recovery work, not the final design. It replaces the earliest summary mutation with a hidden `compaction-recovery` message, but the custom branch later lands a more complete persisted implementation in `37ad5d0d22`.
- Likely conflicts on `v2026.4.14`:
  The compaction block in `src/agents/pi-embedded-runner/compact.ts` has been reorganized significantly, so this patch does not apply cleanly and would require manual reworking anyway.
- Proposed port plan:
  Skip `21cbfdbaa3` as-is. If compaction recovery markers are still wanted on `v2026.4.14`, port only the later finalized implementation from `37ad5d0d22` instead of reviving this intermediate refactor.

## 16. `eaf035e70f` `[port] feat: track previousSessionId across session resets`

- Need: `optional`
- Can port: `yes`
- Conflict risk: `medium`
- Why/decision:
  `v2026.4.14` has partial overlap, but it still does not persist `previousSessionId` onto `SessionEntry` or expose it through `TemplateContext`. So the exact enabling plumbing from this commit is still missing, even though some internal reset logic already computes a previous session entry.
- Likely conflicts on `v2026.4.14`:
  This is a manual additive port into `src/auto-reply/reply/session.ts`, `src/auto-reply/templating.ts`, and `src/config/sessions/types.ts`. The file has evolved since the original commit, but the missing logic is still localized.
- Proposed port plan:
  If you want the later continuity/session-summary stack, port this as a small prerequisite: add `previousSessionId?: string` to `SessionEntry`, add `PreviousSessionId?: string` to `TemplateContext`, set `previousSessionId = previousSessionEntry?.sessionId` on new-session rollover, and include it in `sessionCtx`. If you do not intend to carry the later continuity features, this can stay unported.

## 17. `88d12d95d8` `[port] fix: guard archiveSessionTranscripts with isNewSession to prevent session reset on every message`

- Need: `no`
- Can port: `no`
- Conflict risk: `low`
- Why/decision:
  On current `v2026.4.14`, the session control flow already makes this guard effectively redundant: `previousSessionEntry` is only populated in true session-rollover cases, and those same branches already force `isNewSession = true` before transcript archiving runs. So porting this exact patch would not change behavior.
- Likely conflicts on `v2026.4.14`:
  Very little merge conflict risk, but the resulting patch would just wrap the archive block in a redundant condition in `src/auto-reply/reply/session.ts`.
- Proposed port plan:
  Skip `88d12d95d8` as a standalone port. If the surrounding continuity chain is ported later and broadens when `previousSessionEntry` can be set, then re-check whether this explicit guard becomes necessary again.

## 18. `7b2a2c5229` `[port] feat: inject previousSessionId and session creation time into system prompt`

- Need: `should`
- Can port: `partial`
- Conflict risk: `medium`
- Why/decision:
  The continuity prompt behavior is still missing on `v2026.4.14`: the system prompt does not render the previous-session/session-start block, and the reply/follow-up/embedded-run plumbing still does not carry these fields end-to-end. Some pieces are already partly absorbed, but not the actual full behavior.
- Likely conflicts on `v2026.4.14`:
  `createdAt` already exists in `src/config/sessions/types.ts`, so part of the old patch is redundant. The bigger issue is architectural drift: current reply execution also depends on `src/auto-reply/reply/agent-runner-utils.ts` and `src/agents/pi-embedded-runner/run.ts`, which this commit did not originally touch.
- Proposed port plan:
  Do not port this as a standalone cherry-pick. Manually port the useful continuity pieces as a bundle: set `createdAt` on new sessions if needed, add the continuity block to `src/agents/system-prompt.ts`, thread `previousSessionId` / `sessionCreatedAt` through current queue and follow-up types plus embedded-run params, and pair it with the later forwarding fix in `03ab0f8683` so the main embedded-run path actually receives the fields.

## 19. `e01bdaf8ae` `[port] feat: session summary system (combined: generate, load, inject, search, CLI)`

- Need: `no`
- Can port: `partial`
- Conflict risk: `high`
- Why/decision:
  `v2026.4.14` still does not have this subsystem, but this exact commit is not a good standalone port target. It was incomplete even on the custom branch without follow-ups, and current upstream has already evolved many of the surrounding seams.
- Likely conflicts on `v2026.4.14`:
  The old patch touches many areas that have since moved or changed shape: system prompt APIs, runner params, tool registration, storage seams, config schema generation, and CLI wiring. Porting it literally would be a large, conflict-heavy transplant.
- Proposed port plan:
  Do not port `e01bdaf8ae` in isolation. If the session-summary feature is still wanted, treat it as a bundled feature reimplementation centered on `e01bdaf8ae + 03ab0f8683 + 93a6dc5136` and optionally `02e33cbf36` for UI, rebuilt on current seams: new summary storage/query modules, current prompt injection APIs, modern tool registration, descriptor-based CLI wiring, generated config metadata, and fresh tests against the current continuity pipeline.

## 20. `03ab0f8683` `[port] fix: forward previousSessionId and recentSessionHistory through embedded runner pipeline`

- Need: `no`
- Can port: `no`
- Conflict risk: `medium`
- Why/decision:
  This is not a standalone feature on `v2026.4.14`; it is an enabling follow-up that only matters if the broader continuity/session-summary fields are first introduced into the current embedded runner and queued run contracts.
- Likely conflicts on `v2026.4.14`:
  `src/agents/pi-embedded-runner/run.ts` has drifted, and the forwarded fields are not even present yet in current `queue/types.ts` or `run/params.ts`. So applying this directly would not compile or have any effect.
- Proposed port plan:
  Skip `03ab0f8683` unless you are porting the broader continuity/session-summary stack. If that stack is brought over, apply this only after adding `previousSessionId`, `recentSessionHistory`, and `sessionCreatedAt` to the current queue/run contracts, then reintroduce the forwarding in `agent-runner-utils.ts` and `run.ts` with a regression test proving those fields reach prompt construction.

## 21. `ca7305a51d` `[port] fix(signal): prioritize sticker over attachment in inbound parsing + add sticker action`

- Need: `should`
- Can port: `partial`
- Conflict risk: `medium`
- Why/decision:
  The underlying Signal gap still exists on `v2026.4.14`: sticker-only inbound messages are effectively dropped, and the current Signal message-action adapter still does not implement `sticker` even though the generic action framework supports it. So the Signal-specific behavior is still valuable.
- Likely conflicts on `v2026.4.14`:
  The Signal action seam changed from the old channel action file to `extensions/signal/src/message-actions.ts`, and `extensions/signal/src/send.ts` plus monitor parsing have both drifted. The old patch therefore needs a manual transplant into the new Signal-specific files.
- Proposed port plan:
  Port only the Signal-specific behavior into current files: add `sticker` to `SignalDataMessage`, make inbound parsing prefer sticker placeholder handling over generic attachment placeholder, add `sendStickerSignal()` in `extensions/signal/src/send.ts`, and extend `extensions/signal/src/message-actions.ts` to advertise/handle `sticker`. Skip the already-upstream cleanup hunk and add focused tests for sticker-only inbound parsing plus the `sticker` action.

## 22. `02e33cbf36` `[port] feat: add Session Summaries tab to web control UI`

- Need: `should`
- Can port: `partial`
- Conflict risk: `high`
- Why/decision:
  This is only meaningful if the underlying session-summary subsystem is in scope. On current `v2026.4.14`, there is no summary loader/query backend and no `sessions.summaries` protocol surface, so the UI tab cannot stand on its own.
- Likely conflicts on `v2026.4.14`:
  Gateway session methods, protocol schema exports, UI app state, navigation, lazy-loaded rendering, and locale coverage have all moved forward. A literal port would collide with many newer surfaces.
- Proposed port plan:
  Do not port this commit by itself. If the summary feature family is chosen, reimplement this UI/RPC layer on top of current gateway session protocols and the current lazy-loaded control UI, then add the needed i18n coverage and end-to-end verification. Otherwise, drop it.

## 23. `cc07d52923` `[port] add REBASE-LOG.md`

- Need: `no`
- Can port: `yes`
- Conflict risk: `low`
- Why/decision:
  This is pure historical bookkeeping about the older `custom/20260226 -> custom/20260314` rebase. It has no runtime effect and would be stale/misleading if imported into the current `v2026.4.14` bring-up as-is.
- Likely conflicts on `v2026.4.14`:
  No code conflict, but the content itself is anchored to the old rebase context and therefore wrong for the current port effort.
- Proposed port plan:
  Skip this commit. If you want a rebase/port audit trail in the new worktree, write a fresh `REBASE-LOG.md` or equivalent note specifically for the `v2026.4.14` port effort.

## 24. `93a6dc5136` `[fix] session summary injection + tool registration`

- Need: `should`
- Can port: `partial`
- Conflict risk: `high`
- Why/decision:
  This is the completion patch for the custom session-summary feature, and it only makes sense together with the earlier summary-system work. On `v2026.4.14`, the specific tool registration, summary config, prompt injection, and UI tab wiring from this commit are all still missing, but so are the underlying summary modules it depends on.
- Likely conflicts on `v2026.4.14`:
  Tool registration, reply-run plumbing, config schema layout, and UI navigation/rendering have all evolved. Several files this commit assumed simply do not exist yet on the current base.
- Proposed port plan:
  Treat `93a6dc5136` as part of the session-summary bundle, not as an isolated cherry-pick. If the summary feature is kept, first port/rebuild the underlying summary subsystem, then manually adapt this follow-up to current seams: register the summaries tool, add the summary config keys/tests, thread `recentSessionHistory` through the current follow-up/system-prompt path, and add the summaries tab/i18n/tests in the current UI. Otherwise, drop it.

## 25. `014172b1f4` `fix: preserve followup queue on abort in collect mode`

- Need: `no`
- Can port: `partial`
- Conflict risk: `medium`
- Why/decision:
  The exact buggy path this commit fixed is already gone on `v2026.4.14`: the current abort path no longer clears the followup queue in the same way, and user-abort now flows through the newer reply-operation architecture before `finalizeWithFollowup(...)` still schedules drain.
- Likely conflicts on `v2026.4.14`:
  `agent-runner.ts` and related helpers have been refactored, and the old finalizing-flag cleanup logic is gone. The remaining policy question is broader now: explicit abort helpers elsewhere still clear queues, so the collect-backlog semantics need to be checked on the current tree rather than inferred from the old patch.
- Proposed port plan:
  Do not cherry-pick `014172b1f4`. Treat the original bugfix path as already absorbed. If you want confidence here, add a current-tree regression proving that a collect-mode user-aborted run still schedules follow-up drain, and separately decide whether explicit `/abort` should keep or clear queued collect backlog.

## 26. `3b652fde95` `fix: prevent FINALIZING_SESSIONS leak on session reset`

- Need: `no`
- Can port: `no`
- Conflict risk: `high`
- Why/decision:
  The primary fix in this commit depends on a `FINALIZING_SESSIONS` mechanism that does not exist on `v2026.4.14`. Its bundled heartbeat-lock hunk is already present independently upstream, and its bundled compaction hunk is only an intermediate recovery-marker step that should not be ported here.
- Likely conflicts on `v2026.4.14`:
  None of the original hunks map cleanly: the embedded-run registry, reply lifecycle, and compaction handling have all moved on. This is an intermediate step from the old race-fix chain, not a current-tree patch target.
- Proposed port plan:
  Skip `3b652fde95` as a unit. If interrupt/finalize leak issues still exist, evaluate only the later/final missing behaviors against the current reply-run and embedded-run registry architecture. Do not port the bundled compaction piece here.

## 27. `e099e19d8a` `fix: clear finalizing flag in followup runner to prevent stuck isActive`

- Need: `no`
- Can port: `no`
- Conflict risk: `high`
- Why/decision:
  This fix belongs to the old `FINALIZING_SESSIONS` design. `v2026.4.14` no longer uses that subsystem at all; active-state cleanup now goes through reply-run-registry plus the modern reply operation lifecycle.
- Likely conflicts on `v2026.4.14`:
  The old cleanup helper is gone, and `followup-runner.ts` has been refactored around `createReplyOperation()` and newer lifecycle plumbing. The old hunk no longer maps.
- Proposed port plan:
  Drop `e099e19d8a`. Do not port this or the related old finalizing-flag cleanup commits as-is. If modern stuck-active issues exist, review the current reply-run lifecycle directly instead of reviving `FINALIZING_SESSIONS`.

## 28. `4c0c47e73a` `fix: ensure deleteAfterRun cleanup runs for all delivery paths`

- Need: `should`
- Can port: `yes`
- Conflict risk: `medium`
- Why/decision:
  `v2026.4.14` still has the pre-fix cleanup gap in `src/cron/isolated-agent/delivery-dispatch.ts`: `deleteAfterRun` cleanup is reachable only from some delivery paths, and shared callers that already sent via the messaging tool can still skip cleanup entirely.
- Likely conflicts on `v2026.4.14`:
  The file has drifted a bit and already uses the current outer-scope cleanup helper plus lazy runtime loading, so this should be adapted manually rather than cherry-picked textually.
- Proposed port plan:
  Manually make cleanup idempotent with a `sessionCleaned` flag and add the final fallthrough cleanup call in `src/cron/isolated-agent/delivery-dispatch.ts` so `deleteAfterRun` runs even when shared-caller/message-tool paths bypass the main delivery block. Add a regression proving shared-caller `deleteAfterRun` cleanup fires exactly once.

## 29. `dd7fccf448` `fix: clear finalizing flag in all runEmbeddedPiAgent call sites`

- Need: `no`
- Can port: `no`
- Conflict risk: `high`
- Why/decision:
  This commit only matters in the older `FINALIZING_SESSIONS` design. `v2026.4.14` has already replaced that cleanup model with reply-operation lifecycle handling plus the current embedded-run active handle cleanup.
- Likely conflicts on `v2026.4.14`:
  The target files have been refactored significantly, and the old finalizing API does not even exist anymore. The exact patch is therefore superseded, not missing.
- Proposed port plan:
  Do not port `dd7fccf448`. If you want extra safety, add or review regression coverage around stuck-active cleanup on normal runs, heartbeat runs, and memory-flush paths under the current reply-operation model.

## 30. `81577c37a1` `fix: clear FINALIZING_SESSIONS in agentCommandInternal finally block`

- Need: `no`
- Can port: `no`
- Conflict risk: `high`
- Why/decision:
  This fix is tied to the old `FINALIZING_SESSIONS` design, which no longer exists on `v2026.4.14`. The exact cleanup API it relies on is gone, and the gateway agent command path has moved into the newer agent-command implementation.
- Likely conflicts on `v2026.4.14`:
  Both structurally and semantically incompatible: the old target file is now just a shim, and the cleanup symbol no longer exists.
- Proposed port plan:
  Skip `81577c37a1`. If a modern “stuck active” symptom remains, investigate the current run-lifecycle path instead of reintroducing the old finalizing-flag cleanup.

## 31. `8ad787ff0f` `fix: eliminate repeat delivery bug on user interrupt`

- Need: `should`
- Can port: `partial`
- Conflict risk: `medium`
- Why/decision:
  This is still the mature end of the interrupt/repeat-delivery fix chain. On `v2026.4.14`, two useful gaps remain: aborted runs can still flush buffered block output before discard, and follow-up drain can still keep a stale cached dispatcher callback. The old finalizing-state cleanup part of the commit, however, no longer applies.
- Likely conflicts on `v2026.4.14`:
  The embedded-run/finalizing-state portion is obsolete and must be dropped. The abort-before-flush change and callback-refresh change both need to be translated into current reply-operation and queue-drain control flow rather than cherry-picked literally.
- Proposed port plan:
  Port only the still-relevant pieces. In `src/auto-reply/reply/agent-runner.ts`, check `runResult.meta.aborted` before any pipeline flush and prevent aborted runs from emitting buffered block output. In `src/auto-reply/reply/queue/drain.ts`, always refresh the cached callback with the newest `runFollowup` before drain-start logic. Add regressions for “aborted run never flushes buffered output” and “interrupt followup drain switches to newest dispatcher callback.”

## 32. `ec2159a3ce` `feat(signal): add quote reply support (Phase 1 MVP)`

- Need: `no`
- Can port: `partial`
- Conflict risk: `high`
- Why/decision:
  This is only the MVP half of the Signal quote-reply work, and it is not a good standalone port target. On `v2026.4.14`, some config/send ideas still map conceptually, but the old core wiring files are gone and the later follow-up already fixes the RPC details and end-to-end behavior.
- Likely conflicts on `v2026.4.14`:
  The old `dock.ts` / outbound Signal files no longer exist, and the extension architecture has moved. The old quote-field mapping is also likely stale relative to the later corrected Signal RPC behavior.
- Proposed port plan:
  Skip `ec2159a3ce` as-is. If Signal quote replies are wanted, port the feature together with the later corrections from `61c685de43`: add `replyToMode` config, wire Signal-specific reply-thread behavior through the current extension channel/outbound path, and update `send.ts` with the corrected RPC fields and tests.

## 33. `61c685de43` `fix(subagent): improve session revival via sessions_send`

- Need: `should`
- Can port: `partial`
- Conflict risk: `high`
- Why/decision:
  `v2026.4.14` already absorbed part of the keep-cleanup behavior through a different refactor, but the main revival behavior is still missing: no reactivation path, no fallback registration, no timeout `accepted: true` acknowledgment, and no double-announce suppression in the current `sessions_send` flow.
- Likely conflicts on `v2026.4.14`:
  `sessions-send-tool.ts` and the subagent registry are both refactored onto newer seams, and this commit is also bundled with unrelated Signal quote-threading fixes. So it cannot be carried as one cherry-pick.
- Proposed port plan:
  Manually port only the subagent revival pieces onto current `sessions-send-tool` plus registry/run-manager seams, and bundle that work with `32d5b828e7` so timeout semantics are correct. Treat the bundled Signal half as a separate optional port on top of the earlier Signal customization stack.

## 34. `32d5b828e7` `Agents: preserve subagent timeout semantics`

- Need: `must`
- Can port: `yes`
- Conflict risk: `medium`
- Why/decision:
  The core bug still exists on `v2026.4.14`: the runner internally knows about timeout, but the public metadata and downstream consumers still largely infer timeout from generic abort state. The waiter-side misclassification also still exists, now through the newer run-manager seam.
- Likely conflicts on `v2026.4.14`:
  Part of the old wait logic moved out of `subagent-registry.ts` into `src/agents/subagent-registry-run-manager.ts`, so this needs a semantic port rather than a raw cherry-pick. Existing tests also currently codify the buggy timeout mapping.
- Proposed port plan:
  Manually port the semantic end state: add `timedOut?: boolean` to the public runner metadata, propagate it from `run.ts` through lifecycle events in `src/commands/agent.ts`, switch gateway timeout derivation to `data.timedOut` instead of `data.aborted`, update subagent lifecycle consumers to use the new field, and adapt the waiter-side timeout guard into `src/agents/subagent-registry-run-manager.ts` so non-terminal `agent.wait` timeouts do not falsely end the child run. Update the gateway and subagent lifecycle tests accordingly.

## 35. `9a9b42e3d3` `Tests: format waitForAgentJob lifecycle case`

- Need: `no`
- Can port: `no`
- Conflict risk: `low`
- Why/decision:
  This is an empty commit with no patch and no touched files. It is pure bookkeeping/cherry-pick residue.
- Likely conflicts on `v2026.4.14`:
  None.
- Proposed port plan:
  Drop it. No action needed.

## 36. `37ad5d0d22` `Agents: persist auto-compaction recovery marker`

- Need: `should`
- Can port: `partial`
- Conflict risk: `high`
- Why/decision:
  This is the mature form of the custom compaction-recovery feature, and `v2026.4.14` still lacks that persisted recovery-marker behavior during auto-compaction/retry. So if that UX is still wanted, this is the commit to evaluate.
- Likely conflicts on `v2026.4.14`:
  The current subscription setup, compaction handler, and direct compaction path have all evolved. The old plumbing for `sessionManager` / `workspaceDir` and the old test shape do not map directly.
- Proposed port plan:
  Reimplement this manually on current seams: add a shared `compaction-recovery` helper, thread `sessionManager` and `workspaceDir` through the current subscription params path, extend the current compaction subscriber handler to append a hidden recovery marker and strip trailing retry error noise while preserving existing reconciliation logic, and fold the regression into the current compaction handler test file.

## 37. `f7cb28cb7d` `UI: remember gateway tokens by URL`

- Need: `no`
- Can port: `partial`
- Conflict risk: `medium`
- Why/decision:
  The exact commit conflicts with an explicit current `v2026.4.14` policy: Control UI gateway auth is intentionally session-only / in-memory, and tests plus docs assert that persisted tokens are not saved long-term. So the localStorage persistence part should not be ported.
- Likely conflicts on `v2026.4.14`:
  Porting the exact patch would require flipping current storage policy in `ui/src/ui/storage.ts`, breaking the tests that assert token scrubbing, and updating docs that explicitly promise session-scoped token handling.
- Proposed port plan:
  Do not port this commit verbatim. If the UX still matters, port only the narrow intent: keep session-only storage, but add a helper that restores the current session token for a known gateway URL within the same session when switching URLs in login/overview/app flows, without reintroducing long-lived localStorage persistence.

## 38. `aef969d034` `Tools: honor aborts in PDF analysis`

- Need: `should`
- Can port: `yes`
- Conflict risk: `medium`
- Why/decision:
  The current `v2026.4.14` tree still appears to drop PDF-tool aborts: signal/timeout is not threaded end-to-end through PDF tool entry, remote fetch, native PDF providers, and extraction. So the underlying reliability bug is still present.
- Likely conflicts on `v2026.4.14`:
  The patch does not cherry-pick cleanly because several touched files moved or were reorganized. The helper added in the source branch also overlaps with current timeout/abort utilities, so it should be adapted instead of copied blindly.
- Proposed port plan:
  Manually re-port this fix by threading `signal` through the current `pdf-tool`, `pdf-extract`, native PDF providers, `web-media`, and `fetch` paths, while preserving explicit remote-fetch and model-analysis timeouts. Reuse or extend current timeout/abort helpers where possible, then port/adapt the regression coverage for abort-aware PDF analysis and fetch cancellation.

## 39. `eee6493af5` `fix: preserve session identity in chat.send for idle sessions`

- Need: `should`
- Can port: `yes`
- Conflict risk: `low`
- Why/decision:
  `v2026.4.14` still lacks the pre-dispatch `updatedAt` refresh in `chat.send`, so idle Web UI sessions can still look stale and rotate to a new `sessionId`. This remains a real, unsuperseded continuity fix.
- Likely conflicts on `v2026.4.14`:
  Very little. The seam is still local in `src/gateway/server-methods/chat.ts`, and the current code already has the needed session entry/store path information.
- Proposed port plan:
  Manually port the fix into `src/gateway/server-methods/chat.ts` by importing `updateSessionStoreEntry`, then best-effort touching `updatedAt` when `storePath` and `entry.sessionId` exist immediately before `dispatchInboundMessage(...)`. Keep the non-fatal try/catch behavior, and add a focused idle `chat.send` continuity test proving the session ID stays stable.

## 40. `14bee19d4b` `fix: retry debounce flush on failure to prevent message loss`

- Need: `should`
- Can port: `partial`
- Conflict risk: `high`
- Why/decision:
  `v2026.4.14` still appears vulnerable to the same message-loss mode: the current debounce implementation can drop a buffered batch if flush fails transiently. So the reliability intent still matters.
- Likely conflicts on `v2026.4.14`:
  The file has moved far beyond the old simple buffer/retry design and now uses keyed execution chains, reserved slots, and tracked-key accounting. The old patch cannot be applied literally, and the old dedicated test file no longer matches current coverage layout.
- Proposed port plan:
  Reimplement the reliability fix on top of the current keyed-chain debounce architecture instead of cherry-picking. Keep items alive until flush succeeds or retries are exhausted, add explicit flush-in-progress state plus backoff retry, preserve ordering, and ensure items appended during retry are retained. Add focused regressions in the current inbound debounce test surface for retry-after-failure, append-during-retry, final `onError`, and `flushKey()` failure handling.

## 41. `9acf99d5c0` `fix: reduce auth profile cooldown curve (5s→15s→45s→135s→3min cap)`

- Need: `no`
- Can port: `partial`
- Conflict risk: `medium`
- Why/decision:
  `v2026.4.14` already replaced the old generic cooldown model with a broader newer solution, including stepped generic cooldowns and provider/model-specific logic. Porting this exact retune would override current upstream behavior rather than restoring a missing fix.
- Likely conflicts on `v2026.4.14`:
  `src/agents/auth-profiles/usage.ts` now includes broader cooldown machinery, and current tests explicitly assert the newer generic curve plus provider-specific behavior.
- Proposed port plan:
  Do not cherry-pick `9acf99d5c0`. If the original multi-profile cooldown-loop problem still reproduces on `v2026.4.14`, do a fresh targeted retune of the current generic cooldown path without disturbing the existing Codex/WHAM-specific logic, then update tests accordingly.

## 42. `716855f9eb` `feat: decouple hook delivery from heartbeat runner`

- Need: `should`
- Can port: `yes`
- Conflict risk: `low`
- Why/decision:
  `v2026.4.14` still routes hook wakeups through `requestHeartbeatNow()`, so hook/system-event delivery is still coupled to heartbeat semantics. The architectural cleanup from this commit remains missing and valuable.
- Likely conflicts on `v2026.4.14`:
  Very manageable. `src/gateway/server/hooks.ts` has newer hook-handler details, but the actual wake-path swap is small. The new helper file does not exist yet, but its dependencies still do.
- Proposed port plan:
  Add `src/infra/hook-agent-turn.ts` with the coalesced main-lane hook agent-turn helper, then switch the hook wake sites in `src/gateway/server/hooks.ts` from `requestHeartbeatNow(...)` to `requestHookAgentTurn(...)` while preserving current hook-handler behavior. Add focused tests proving hook events are processed through a normal agent turn instead of heartbeat framing.

## 43. `19c9428592` `feat(openai): backport GPT-5 overlay`

- Need: `no`
- Can port: `no`
- Conflict risk: `high`
- Why/decision:
  `v2026.4.14` already contains this functionality in a newer built-in form: the bundled `extensions/openai` plugin, GPT-5 overlay logic, hook-context fields, default-enable behavior, and docs are all already present. So this backport is fully subsumed.
- Likely conflicts on `v2026.4.14`:
  The target files already exist with richer current behavior and different seams. Re-porting this commit would only collide with the already-present upstream implementation.
- Proposed port plan:
  Skip `19c9428592`. If you want any branch-specific overlay wording, review it as a selective content diff against the current `extensions/openai/prompt-overlay.ts` only, while keeping the existing plugin registration and plumbing untouched.
