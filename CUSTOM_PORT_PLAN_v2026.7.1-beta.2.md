# Custom port plan for `v2026.7.1-beta.2`

This plan turns the decisions in
`CUSTOM_COMMIT_ANALYSIS_v2026.7.1-beta.2.md` into independently reviewable
changes on `custom/20260705`.

## Migration invariants

- The branch starts at the peeled `v2026.7.1-beta.2` release commit
  `a580a7fe3fbd1b3329c978d58ca2f70e8ca37aee`.
- Do not rebase or cherry-pick `origin/custom/20260415`; migrate behavior onto
  target abstractions.
- Core stays provider- and plugin-agnostic. Anthropic policy belongs in
  `extensions/anthropic`; memory products belong in `extensions/memory-core`.
- Plugins import only `openclaw/plugin-sdk/*` and local barrels. New core seams
  must be additive, documented, and covered by the Plugin SDK API drift gate.
- Session and transcript identity is `(agentId, sessionId, sessionKey)`, never a
  raw JSONL path. Transitional `sessionFile` fields may be consumed only at the
  lifecycle boundary.
- Plugin-owned durable state uses the shared plugin-state database. Do not add
  tables to the memory index database and do not revive the reverted session
  metadata SQLite implementation.
- Do not edit restricted CODEOWNERS paths for this migration.
- Do not modify baselines, snapshots, inventories, or expected-failure files to
  hide a failing check. Run the official generator when a real public surface
  changes.
- Each commit must compile and pass the narrow tests for its own behavior.

## Phase 0: audit and reproducible baseline

Commit:

- `Docs: record v2026.7.1-beta.2 custom migration plan`

Contents:

- Record all 95 source-only commits and their semantic disposition.
- Record the target/base/source SHAs and the security exclusions.
- Keep the branch otherwise identical to the official release.

Acceptance:

- `git diff v2026.7.1-beta.2...HEAD` contains only the two decision documents.
- The source branch remains untouched.

## Phase 1: durable completed-session summaries

### Commit 1: `Memory: add durable session summary records`

Scope:

- Add a memory-core-owned keyed store namespace for summary records.
- Record at least agent/session identity, lifecycle status, successor identity,
  ended time, transcript fingerprint, prompt/summary version, attempt count,
  model, generated time, summary, and bounded failure diagnostics.
- Use atomic register-if-absent and update transitions so duplicate lifecycle
  events are idempotent and restart recovery is possible.
- Extract canonical user/assistant content through
  `session-transcript-runtime`; filter delivery mirrors and non-conversation
  metadata, bound tool-result excerpts, redact likely secrets, and frame the
  transcript as untrusted data.
- Use token-estimated chunks followed by a final synthesis. Never concatenate
  partial summaries as the final result.

Tests:

- state transition, duplicate enqueue, retry, fingerprint/version invalidation;
- transcript filtering, redaction, bounded chunks, and final synthesis;
- empty/short transcripts and completion failures.

### Commit 2: `Memory: generate summaries from session lifecycle`

Scope:

- Subscribe to typed `session_end` events.
- Durably enqueue before returning from the hook; model work runs outside the
  interactive reply lifecycle.
- Recover pending and retryable failed records on startup or the next lifecycle
  event with bounded concurrency/backoff.
- Do not block a user reset/reply on an external summary completion.

Tests:

- `session_end -> pending -> complete`;
- duplicate event, process-restart recovery, failure/retry, and direct successor
  linkage;
- shutdown/restart/deleted policy and disabled configuration.

### Commit 3: `Memory: add scoped session summary recall`

Scope:

- Register `session_summaries` as a memory-core tool.
- Enforce the public session visibility policy and same-agent ownership.
- Search literal normalized terms; `%` and `_` have no wildcard meaning.
- Add hard result/text limits and stable newest-first cursors.
- Register `memory.summaries.list` as a plugin RPC with the same pagination and
  scoping rules.
- Add `openclaw memory summaries list` through the existing plugin CLI seam if
  it can remain lazy and plugin-local.
- Optionally inject only the completed direct predecessor into
  `before_prompt_build`, under an explicit fixed token budget. Do not inject an
  unbounded recent-history dump.

Tests:

- `self`, `tree`, `agent`, and cross-agent visibility;
- literal search, cursor stability, hard limits, and oversized summaries;
- direct predecessor injection, no unrelated-session injection, and disabled
  auto-injection.

### Commit 4: `Control UI: add session summary history`

Scope:

- Add a current-architecture navigation tab and paginated controller state.
- Render status, model, time, message count, lineage, summary, retryable error,
  loading, empty, and unavailable-plugin states.
- Use existing components/tokens and responsive layout; do not copy old inline
  CSS or fetch 1,000 records for client-side slicing.
- Edit the English locale source and run the current locale generator. Do not
  hand-edit generated translations or `docs/zh-CN/**`.

Tests:

- controller pagination/error recovery;
- rendering for complete/pending/failed/empty records;
- navigation and narrow viewport behavior.

## Phase 2: durable memory at session boundaries

### Commit 5: `Memory: flush completed sessions on rollover`

Scope:

- Subscribe in memory-core to completed-session lifecycle events whose reasons
  are explicitly configured for capture.
- Use the canonical bounded transcript and the existing `MemoryFlushPlan` for
  model, prompts, and write target.
- Run an isolated maintenance turn that may append only to the canonical daily
  memory file.
- Persist a receipt keyed by agent, session, transcript fingerprint, and plan
  version. Advance the receipt only after success; retry failures safely.
- Do not hard-code the `main` agent/session and do not feed the entire raw
  transcript in one prompt.

Tests:

- reason/agent/session filtering, bounded transcript, configured model;
- exactly-once successful receipt, failed retry, changed transcript/plan;
- no user-visible delivery and no mutation of the ended transcript.

### Commit 6: `Memory: flush CLI sessions before native compaction`

Scope:

- Add the narrowest generic hook/capability before the CLI compaction decision.
- Use fresh normalized usage and current session metadata as the primary signal.
- Run memory capture in a separate maintenance execution. Never write the
  maintenance prompt into or restart the user-owned Claude live session.
- Native provider history may only be consulted inside its provider adapter as
  a fallback; core must not scan `~/.claude`.
- Persist successful flush position/fingerprint. Any repeat interval is a
  configuration value with hysteresis, not a hard-coded 20,000-token loop.

Tests:

- below/above threshold, success position, failed retry, repeated growth;
- no recursive compaction and no user CLI binding/history contamination;
- 200K and 1M context accounting.

## Phase 3: Claude CLI delivery and isolation

### Commit 7: `Reply: stream CLI deltas through block delivery`

Scope:

- Consume normalized CLI assistant deltas and feed the existing block-reply
  pipeline while generation is active.
- Flush at text/tool/commentary/text boundaries without retaining cumulative
  snapshots.
- Reuse `didStream()`/`hasSentPayload` to suppress final replay exactly once.
- Preserve non-streaming mode, media, abort, queued follow-ups, and tool summary
  behavior.

Tests:

- text-only, text/tool/text, commentary, final dedupe, abort, media, and
  non-streaming control cases.

### Commit 8: `Gateway: expose coding tools to isolated CLI backends`

Scope:

- Add a generic CLI MCP tool-surface capability/allowlist. It must not mention
  Anthropic or hard-code a future-fragile native-tool denylist.
- Permit an isolated backend to request OpenClaw read/write/edit/apply-patch/
  exec/process tools that the default Claude-native profile currently omits.
- Keep current default behavior unchanged for other CLI backends.

Tests:

- default tool set unchanged;
- isolated capability receives only declared coding tools;
- unknown tools fail closed and policy/approval filtering still applies.

### Commit 9: `Anthropic: isolate Claude CLI behind OpenClaw tools`

Scope:

- Configure isolation only in the Anthropic plugin: disable native coding tools,
  hooks/settings/project instructions as selected by product policy, and choose
  explicit system-prompt append/replace behavior.
- Request the generic OpenClaw coding-tool surface from the preceding commit.
- Include all policy inputs in the live-session fingerprint so changing config
  cannot reuse a process with stale security context.

Tests:

- Claude native coding tools are unavailable;
- OpenClaw MCP coding tools remain available and approval-gated;
- policy/model/auth/prompt/MCP/cwd/skills changes rotate the live session;
- consecutive turns and restart reseed retain conversation continuity.

### Optional commit 10: `CLI: forward fast mode to backend execution hooks`

Only land this if the deployed fork uses `/fast`. Add an additive SDK field,
forward it to the Anthropic plugin, map the CLI setting, and include it in the
live fingerprint. Generate and verify the Plugin SDK API baseline.

Do not add a Fable CLI alias unless a live `claude --model fable` probe proves
the alias is accepted by the installed CLI. The API catalog already contains
Fable 5.

## Phase 4: configuration migration and documentation

### Commit 11: `Config: migrate custom Claude and summary settings`

Scope:

- Add an idempotent doctor migration from the old summary settings into the new
  memory-core summary config.
- Rewrite model/auth-order/CLI-backend references from
  `claude-cli-streaming` to target `claude-cli`.
- Clear obsolete live-session binding state and let bounded reseed recover it;
  do not rename a provider-owner key blindly.
- Remove obsolete compaction-overlay, prompt-invalidation, hook/fs bypass, and
  unauthenticated-bind settings with explicit doctor diagnostics.
- Do not keep runtime compatibility shims after migration.

Tests:

- old config to new config, already-migrated no-op, mixed config precedence,
  invalid values, and repeated doctor runs;
- old backend/session binding is cleared without losing OpenClaw session data.

### Commit 12: `Docs: document custom Claude and memory behavior`

Scope:

- Document the resulting summary lifecycle, retention/search/visibility,
  privacy/model controls, and recovery behavior.
- Document that `claude-cli` now supplies the persistent streaming process and
  how the custom isolation/block-delivery policy differs from upstream defaults.
- Document the one-time doctor migration and rollback/disable controls.

Run `pnpm docs:list` before editing and use root-relative Mintlify links in
`docs/**`.

## Phase 5: Signal follow-up, currently blocked

No placeholder integration commit should land. Work resumes only after the
`signal-ts` source is available as a legal exact runtime dependency that passes
Node 22 and deployment-platform installation tests.

Future commit order:

1. `Signal: add reproducible signal-ts runtime dependency`
2. `Signal: add signal-ts transport adapter`
3. `Signal: implement signal-ts inbound transport`
4. `Signal: implement signal-ts outbound transport`
5. `Signal: support signal-ts media and threaded replies`

The dependency commit must update the root lockfile and the externalized Signal
plugin shrinkwrap through official package-manager commands. Those files are
CODEOWNERS-restricted, so this phase also needs the appropriate owner review.

## Optional evidence-gated follow-ups

- `Media: propagate PDF tool cancellation` only if a current caller-abort
  regression reproduces against the ClawPDF path.
- `Signal: support on-connection receive mode` only if deployed signal-cli
  configuration still uses that value.
- Central timing diagnostics only if post-migration performance evidence needs
  it, and without touching restricted auth-profile code.

## Verification gates

For each commit:

- run the smallest colocated tests that prove its behavior;
- run `pnpm check` before committing;
- run the relevant drift check whenever config or Plugin SDK contracts change.

Before the final branch handoff:

1. `pnpm format`
2. `pnpm check`
3. `pnpm config:docs:check`
4. `pnpm plugin-sdk:api:check` when the SDK changed
5. `pnpm build`, with no `[INEFFECTIVE_DYNAMIC_IMPORT]` warnings
6. `pnpm test`

If a full-suite failure also exists on the exact target tag, record the target
control run and the scoped green tests. Do not broaden the migration into an
unrelated fix without approval.
