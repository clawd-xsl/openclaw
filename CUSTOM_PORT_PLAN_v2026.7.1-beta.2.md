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

## Implemented commit ledger

The implementation follows the dependency order above. Hashes are grouped by
reviewable behavior rather than by the chronology of the old branch:

| Area                                               | Commits on `custom/20260705`                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Audit baseline                                     | `f96fdd95aa`                                                                       |
| Generic coding surface and Anthropic isolation     | `fc5b8d5fc1`, `7c5504cce5`, `3b80939b61`, `cb33c75017`                             |
| CLI streaming and bounded transcript contract      | `b07bcaabae`, `1c819e6024`, `9117d4b37e`, `660630a217`                             |
| Retired Claude provider and session state          | `b00de71aa4`, `1942f32d23`                                                         |
| Summary product, UI, migration, and boundaries     | `afdd58eade`, `3b713fcce1`, `8f2d2d067e`, `ae5d89ab9e`, `dedbbedf5b`, `dee063f31c` |
| Summary tool policy and safe continuity injection  | `2dcbf4ade6`, `8e668c60a4`, `a9194042ab`                                           |
| CLI pressure memory and queue-time fast mode       | `a38c54d954`, `c596546b2c`, `00374ed4b5`, `a728b5be59`, `481f3205d3`, `2d7f2d59ff` |
| Retired custom configuration and generated schema  | `31abc29687`, `931b191e42`, `974030fc71`                                           |
| Completed-session Markdown projection              | `fcfdd96258`, `b4dd9b3536`, `d9bf14acce`                                           |
| Signal reply and sticker continuity                | `c86830fd87`                                                                       |
| Doctor capacity contract and legacy summary import | `a91b3331c1`, `9b9f23a6a3`                                                         |
| Migration docs and mechanical gate cleanup         | `71d97e388d`, `8225c24011`, `6cdb51409e`, `ef9678f149`, `f08c52d711`               |

No commit from `origin/custom/20260415` was replayed. The source ref remains at
`0f4877e7cf`; these commits rebuild only the retained behavior on target-owned
abstractions.

## Final product decisions

- Keep Claude Code as the persistent streaming backend, but implement it through
  the target's canonical `claude-cli` runtime and the Anthropic plugin. The old
  `claude-cli-streaming` provider id, direct core provider branches, and stale
  session bindings are migrated away rather than preserved as aliases.
- Keep custom summaries as a memory-core product with durable plugin state,
  recovery, bounded transcript processing, Control UI history, operator RPC,
  and a visibility-checked read-only agent tool. `session_summaries` is present
  in the normal coding/messaging and session tool groups; the minimal profile
  remains unchanged.
- Inject a completed direct-predecessor summary when available. A bounded,
  sanitized predecessor tail is allowed only while that summary is pending or
  processing. A failed summary never falls back to raw predecessor text.
- Keep completed-session durable-memory projection, including the restart-safe
  outbox and exactly-once file markers. Do not revive the old memory database or
  session metadata SQLite designs.
- Keep repeated CLI pressure flushes because a runtime that owns native
  compaction does not advance OpenClaw's compaction counter. Memory-core uses a
  fixed 20,000-token stride and a 2 MiB transcript stride after the existing
  absolute transcript-size pressure threshold activates. The existing
  `forceFlushTranscriptBytes: 0` setting disables the byte path. Optional plan
  hints form an additive Plugin SDK seam; plugins that omit them retain legacy
  once-per-compaction gating.
- Treat a pressure-flush receipt as native-thread-local state. Normal rollover,
  configured cron rollover, and checkpoint restore clear it; provider-owned
  implicit reuse preserves it; internal role-order recovery keeps the native
  binding but clears the receipt and failure budget.
- Keep Signal quoted replies and sticker delivery on the supported signal-cli
  adapters. Continue to reject the unreproducible direct `signal-ts` transport.
- Drop old one-off prompt invalidation, compaction overlay, hook bypass,
  unauthenticated bind, and retired provider shims after their state/config
  migrations have run.

## Protected ratchets awaiting approval

The remaining failing checks are intentional ratchets, not runtime defects.
Repository policy requires explicit approval before changing them:

- config documentation baseline for the clarified existing transcript-pressure
  help text;
- Plugin SDK API baseline for the additive plan/receipt types;
- Plugin SDK public export and callable-export budgets;
- bundled typed-hook registration allowlist and hook-name guards for the two
  memory-core lifecycle modules.

The restricted sandbox/tool-policy reference also has one stale tool list, but
it remains untouched pending its security CODEOWNER.

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
- Register `memory.summaries.list` as an `operator.read` plugin RPC that shares
  bounded filtering and pagination with the tool. The RPC is an operator
  surface and does not impersonate the tool's requester-session visibility.
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

### Commits 5a and 5b: completed-session memory projection

Scope:

- Subscribe in memory-core to the fixed `new`, `reset`, `idle`, and `daily`
  lifecycle reasons. Deliberately restrict this default-on product behavior to
  the dynamically configured default agent's main/global session, avoiding
  surprise model calls and durable writes from channel-isolated or worker
  sessions.
- Use the canonical bounded transcript and the existing `MemoryFlushPlan` for
  model, prompts, timezone-derived write target, and global kill switch.
- Run an isolated read-only maintenance turn that returns a closed JSON union;
  the host, not the model, appends only to the canonical daily memory file.
- Persist a CAS outbox operation keyed by agent and session. Store the frozen
  plan, transcript fingerprint, generated candidate, integrity hashes, lease,
  and retry state before projection. Reconcile operation/hash markers after a
  crash so the same operation is not appended twice.
- Never feed the entire raw transcript in one prompt, resume the ended session,
  or allow user-visible delivery.

Tests:

- reason/default-agent/main-session filtering, bounded transcript, frozen plan;
- candidate-before-projection, lease fencing, failed retry, restart reconcile,
  marker conflict and partial-write fail-closed behavior;
- private 0700/0600 maintenance artifacts, 10-minute run cap, no delivery, and
  no mutation of the ended transcript.

### Commit 6: `Memory: flush CLI sessions before native compaction`

Scope:

- Add the narrowest generic hook/capability before the CLI compaction decision.
- Use fresh normalized usage and current session metadata as the primary signal.
- Run memory capture in a separate maintenance execution. Never write the
  maintenance prompt into or restart the user-owned Claude live session.
- Native provider history may only be consulted inside its provider adapter as
  a fallback; core must not scan `~/.claude`.
- Persist a native-thread fingerprint plus frozen prompt-token and OpenClaw
  transcript-byte baselines. Re-arm without immediately flushing when native
  compaction, transcript rotation, or runtime identity moves backward/changes.
- Expose optional repeat hints through the memory plan contract. The bundled
  memory-core policy deliberately retains the deployed fork's 20,000-token
  cadence and adds a 2 MiB byte fallback without creating new user config keys.
- Freeze the receipt at the pre-maintenance snapshot, bound retries, and wait
  for a newly eligible pressure cycle after exhaustion.

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

### Commit 10: `CLI: forward fast mode to backend execution hooks`

The deployed fork uses `/fast`. Add an additive SDK field, resolve `auto` at
the invocation boundary, forward the effective boolean to the Anthropic
plugin, map it into the isolated Claude settings overlay, and include the final
argv in the live fingerprint. Generate and verify the Plugin SDK API baseline.

Do not add a Fable CLI alias unless a live `claude --model fable` probe proves
the alias is accepted by the installed CLI. The API catalog already contains
Fable 5.

## Phase 4: configuration migration and documentation

### Commits 11a through 11d: custom config and state migration

Scope:

- Add an idempotent doctor migration from the old summary settings into the new
  memory-core summary config.
- Rewrite model/auth-order/CLI-backend references from
  `claude-cli-streaming` to target `claude-cli`.
- Clear obsolete live-session binding state and let bounded reseed recover it;
  do not rename a provider-owner key blindly.
- Remove obsolete compaction-overlay, prompt-invalidation, hook/fs bypass, and
  unauthenticated-bind settings with explicit doctor diagnostics.
- Import legacy SQLite `session_summaries` into memory-core plugin state before
  a legacy memory sidecar can be archived. Sanitize and bound the old text,
  preserve only unambiguous reversed lineage, and never overwrite a current
  record.
- Remove retired per-session custom compaction fields. Preserve the supported
  loopback `gateway.auth.mode: "none"`; the dropped behavior is only the old
  exposed-bind bypass.
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

## Phase 5: Signal adapter continuity and blocked direct transport

The reproducible official signal-cli native/container adapters now retain the
product-level quoted-reply and installed-sticker behavior:

- account-scoped `replyToMode` and original-sender group quote metadata;
- one quote on the first actual text/media send of each logical payload;
- bounded inbound sticker context and an outbound `sticker` message action;
- native JSON-RPC and container REST parameter translation.

Direct `signal-ts` transport remains blocked. No direct-transport integration
will land until the source is available as a legal exact runtime dependency
that passes Node 22 and deployment-platform installation tests.

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
- keep staging scoped with `scripts/committer`; use the final repo-wide gate to
  cover cross-commit lint and type interactions;
- run the relevant drift check whenever config or Plugin SDK contracts change.

Before the final branch handoff:

1. changed-file Oxfmt check and `git diff --check`
2. `pnpm check`
3. `pnpm config:docs:check`
4. `pnpm plugin-sdk:api:check` when the SDK changed
5. `pnpm build`, with no `[INEFFECTIVE_DYNAMIC_IMPORT]` warnings
6. `pnpm test`

If a full-suite failure also exists on the exact target tag, record the target
control run and the scoped green tests. Do not broaden the migration into an
unrelated fix without approval.
