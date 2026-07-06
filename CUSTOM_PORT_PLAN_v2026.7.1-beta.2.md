# Custom port closeout for `v2026.7.1-beta.2`

This is the executed migration plan, design record, and closeout ledger for
rebuilding the intentional `custom/20260415` product differences on
`custom/20260705`. Read it with
`CUSTOM_COMMIT_ANALYSIS_v2026.7.1-beta.2.md`, which contains the chronological
and feature-family disposition of every source-only commit.

## Closeout identity

- Exact target tag: peeled `v2026.7.1-beta.2` at
  `a580a7fe3fbd1b3329c978d58ca2f70e8ca37aee`.
- Source retained for semantic audit only: `origin/custom/20260415` at
  `0f4877e7cf92a1ed0a1d469dd27986d5186d990d`.
- Source/target merge base: `v2026.4.14` at
  `323493fa1b6adc1e10b9954a68d5eaa5a6ef1170`.
- Source-only commits audited: exactly 95. Each was reviewed for product intent,
  target-release overlap, ownership, migration need, and whether its old patch
  shape should be implemented, redesigned, adopted from upstream, or dropped.
- Handoff branch: `custom/20260705`, created directly from the peeled target
  release. No source commit was cherry-picked, rebased, or replayed.
- Commit metadata: every branch-local subject follows the upstream
  `type(scope): summary` convention. Original author lines and timestamps are
  preserved, and every committer is `小C (clawd-xsl)`.
- Final implementation snapshot immediately before the closeout documentation
  commit: `26015deda069f8820e6a84f4b9b358d401283522`.
- Implementation commits after the peeled target at that snapshot: 170.
- Final gate status: runtime-code snapshot `8d0f378333` passed all 89 Vitest
  shards in the clean-room run. The final implementation tree at `26015deda0`
  passed the broad check, production build, targeted closeout and
  provider/replay/channel tests, tsgo, generated-baseline checks,
  documentation checks, scoped format checks, and authenticated Claude live
  probes recorded below.
- Direct Signal dependency: the host environment must resolve the bare package
  identity `@openclaw/signal-ts`. OpenClaw records no package source,
  filesystem path, version, or revision for that host-provided runtime.

A committed file cannot contain its own stable commit SHA: adding that SHA
changes the commit again. The ledger below is therefore the mechanically
generated pre-closeout log through
`26015deda069f8820e6a84f4b9b358d401283522` (170 commits). The
documentation-only closeout commit is intentionally outside that count and is
expected to make the branch count 171.

## Audit outcome

The migration preserved behavior, not old diffs. The source audit found three
different classes of work:

- Product forks retained and redesigned against target-owned seams: persistent
  Claude Code stream-json, SQLite session state, session summaries and memory,
  direct `signal-ts`, and the local Fable 5 route.
- Narrow fixes retained only where the target still lacked the behavior: PDF
  cancellation, explicit local host-attachment and custom-bind controls,
  structured MCP results, token/context accounting, and selected lifecycle or
  test isolation repairs.
- Old workarounds dropped where the target release already owns the behavior or
  the old shape was unsafe. In particular, the old WhatsApp dot-message/WebP
  sentinel from the combined Signal/WhatsApp source patch was not restored.
  Target WhatsApp behavior is authoritative; no sentinel inference or runtime
  compatibility shim was added.

The source ref remains untouched. `CUSTOM_COMMIT_ANALYSIS_v2026.7.1-beta.2.md`
is the durable 95-row decision matrix; this file records the resulting target
architecture and implementation history.

The branch also carries one later upstream correction that is not part of the
95 source-only custom commits. `08675f375a` adapts upstream `49302fcb7d` to the
target tree so officially externalized providers retain endpoint
classification when their plugins are not installed.

## Executed product contracts

### Persistent Claude Code stream-json is the normal path

The latency-critical backend remains `claude-cli` with
`liveSession: "claude-stdio"`: a target-owned background Claude Code process
accepts stream-json turns over stdin and emits stream-json over stdout. This is
not the Anthropic SDK and it is not a fresh `claude -p` process per prompt. The
Claude executable can still receive its non-interactive protocol flag, but
OpenClaw process ownership spans successful turns.

The implemented lifecycle has the following invariants:

- ownership includes agent, account, auth profile, OpenClaw session id, and
  session key; same-key creation is serialized;
- canonical main is pinned, other idle processes close after six hours, every
  process is reconsidered after 24 hours, and the process cap is 16;
- effective argv, environment, MCP configuration, model policy, and other
  launch-affecting facts participate in a fingerprint; a changed fingerprint
  produces a typed restart rather than unsafe reuse;
- the process owns its MCP capture key, while each admitted turn receives only
  a generation-safe request-context lease; out-of-turn calls fail closed;
- assistant deltas, commentary, tool activity, and assistant message boundaries
  pass through normal block delivery, with final replay suppressed only when
  streaming already delivered the same content;
- timeout, abort, tainted capture, restart, idle/age eviction, and explicit
  session cleanup close the affected child without closing unrelated warm
  sessions;
- timing diagnostics distinguish cold and warm paths and record phase latency
  without prompts, responses, secrets, launch paths, or fingerprints.

#### Cold/restart launch-resource ownership

Cold creation and restart now transfer launch-only resources to the child that
actually uses them. The live child adopts generated Claude configuration,
skills/plugin launch files, the MCP capture attempt, and backend cleanup exactly
once. A warm turn never transfers its unused temporary launch files; those stay
turn-owned and are released by turn cleanup. Launch failure, normal close, and
restart share an idempotent child cleanup promise, and restart waits for both
managed-process exit and adopted-resource cleanup before replacement. Ephemeral
side-question, maintenance, and helper sessions explicitly close their own live
children.

This closes the two dangerous lifetime mismatches: deleting cold-start files at
the end of the first turn while the process is still alive, and leaking them
forever by treating all preparation resources as process-owned.

#### Bounded structured native-history rollover

Claude native context pressure is checked before a user turn from the newest
native assistant-call usage, not by summing historical result totals. The
threshold is the lower of 80% of the effective context window and the configured
reserve/soft-threshold boundary. The native JSONL usage read is a bounded
one-megabyte tail scan.

When pressure crosses the threshold, OpenClaw reads visible native Claude
history and creates a bounded, redacted continuity source. Per-block,
per-message, tool-argument, tool-result, and total-history caps apply; the total
formatted history is capped at 500,000 characters and favors recent messages.
Hidden reasoning and inline image payloads are excluded. Credentials, private
keys, authorization values, tokens, and large base64 values are force-redacted
both before summarization and before persistence.

The isolated, tool-disabled summary run must return exactly these six sections:

1. `## Decisions`
2. `## Open TODOs`
3. `## Constraints/Rules`
4. `## Pending user asks`
5. `## Exact identifiers`
6. `## Useful recent context`

A successful result is fenced to the same OpenClaw session row, persisted as a
provider-scoped continuity overlay, and clears the old native Claude binding so
the next normal turn starts a fresh persistent child with the overlay. Summary
failure, empty history, abort, or a concurrent session change fails soft and
does not corrupt or replace the active binding. `/new`, `/reset`, and the owning
session lifecycle clear stale overlays. The isolated summarizer owns only its
ephemeral CLI child; it does not tear down shared bundle-MCP loopback state.

#### Usage semantics and local model restoration

Claude stream-json exposes two intentionally different usage facts:

- aggregate result usage remains the complete-turn accounting/telemetry value;
- the last assistant-call usage is the active-context snapshot used by context
  engines, transcript persistence, pressure decisions, and token reporting.

Using the aggregate result as active context double-counted multi-call tool
turns. Using an earlier assistant record under-counted the current prompt. The
parser now retains both, with last-call usage preferred for context and aggregate
usage retained for accounting. Fresh prompt and output values stay paired; a
new prompt snapshot is never combined with stale output tokens.

The local Claude Code catalog restores `claude-cli/claude-fable-5` and
`claude-cli/claude-fable-5[1m]`, their `fable` aliases, allowlist/default
surfaces, migration handling, catalog labels, context metadata, and adaptive
reasoning policy. Explicit `[1m]` selectors for supported Claude CLI models are
preserved instead of being silently normalized away.

Sonnet 5 uses the canonical OpenClaw identity
`anthropic/claude-sonnet-5` and an exact 1,000,000-token context window. Direct
Anthropic metadata allows 128,000 output tokens; Claude Code metadata reports a
64,000-token maximum. Direct Anthropic, Anthropic Vertex, and Claude CLI default
to adaptive thinking at `high` effort and honor explicit `off` as disabled.
AWS Bedrock and Bedrock Mantle keep adaptive thinking active, map `off` and
`minimal` to `low`, retain native `xhigh` and `max`, and expose only the
standard/default service tier for Sonnet 5 rather than priority or flex.

Claude Code Sonnet 5 requires version 2.1.197 or later. When the effective
context is the full 1M, OpenClaw preserves Claude Code's native approximately
967K auto-compaction threshold instead of replacing its safety margin with a
1,000,000-token override.

### SQLite session state preserves configured paths and hot-path latency

The canonical per-agent default is `sessions.sqlite`. Configuration resolution
preserves the database-first custom contract:

- configured `.sqlite` and `.db` paths remain exact;
- configured `.json` and `.hot.json` paths map to the sibling `.sqlite` path;
- an extensionless or otherwise arbitrary configured path gains `.sqlite`;
- `~` expansion and `{agentId}` templates happen before the same mapping.

This matters because older custom deployments could configure a JSON-looking
stem while the populated authoritative database lived beside it. Treating that
unchanged config as a live JSON store would silently orphan current state.
Direct low-level JSON paths remain available only where import, migration, or
explicit compatibility tooling needs them; canonical configured runtime access
uses the resolved SQLite target.

The SQLite owner uses Kysely over `node:sqlite`, WAL,
`synchronous=NORMAL`, the shared busy timeout, private directory/file modes,
bounded WAL maintenance, and opaque case-sensitive keys with `COLLATE BINARY`.
Legacy JSON import is digest-backed and crash-resumable, concurrent import has a
deterministic winner, and archival cannot discard a JSON source changed after
the imported digest. The older normalized-key schema migrates without retaining
its case-folding uniqueness bug. Doctor and read-only inspection can examine
stores without creating schema, consuming import state, or archiving files.

Known-key operations are row-scoped all the way through their callers:
point-read, updated-at read, transactional upsert, exact mutation, delete, and
inbound/transcript persistence do not materialize and rewrite the full store.
Full enumeration remains only for semantics that require listing, repair,
pruning, export, or lifecycle sweeps. Gateway, reply, heartbeat, cron, subagent,
Codex, QQBot, Feishu, Microsoft Teams, memory-core, QA, doctor, diagnostics,
macOS, ACP, and test fixtures resolve the configured/canonical target instead
of assuming a default filename.

Exact-tree validation retained the compatibility details that matter during
upgrade. Legacy JSON imports continue to accept JSON5 comments and trailing
commas. State-migration planning passes every configured path through the same
runtime `resolveStorePath` mapping before opening or archiving anything.
Microsoft Teams doctor migration intentionally separates discovery from
authority: it may discover the old feedback sidecar beside a directory-shaped
legacy path, but it keys and merges imported state under the canonical SQLite
runtime store. Heartbeat cleanup restores the exact pre-run activity timestamp
unless a genuinely newer one exists, without overwriting unrelated concurrent
session fields.

### Session summaries, lineage, backfill, and durable memory

Completed-session summaries are owned by memory-core plugin state, separate
from the rebuildable memory-search index and from the session store. Records
carry agent/session identity, direct lineage, transcript fingerprint,
prompt/schema version, status/attempt state, model, timestamps, and bounded
diagnostics. Durable enqueue, lease, retry, recovery, and completion transitions
survive restart.

Summary generation uses bounded canonical transcript reads, treats transcript
JSON as untrusted data, removes hidden/model-special content, redacts likely
secrets, and bounds messages, chunks, and stored output. Long sessions use
bounded map/synthesis rather than concatenating partial summaries as the final
record. The prompt preserves concrete facts and, where grounded in the
transcript, emotional tone and relationship dynamics such as trust,
frustration, rapport, boundaries, conflict, repair, and preferred interaction
style. It explicitly forbids diagnosis or invented motives.

Continuity injection follows recorded lineage rather than only one immediately
preceding row:

- up to 20 predecessor records are considered newest-first;
- failed, empty, or still-pending gaps are skipped while older completed
  summaries remain eligible;
- the combined untrusted JSON context is bounded to 2,000 estimated tokens and
  8,000 characters;
- only an oversized newest summary may be truncated; if a later full summary no
  longer fits, traversal stops instead of truncating every ancestor;
- when no completed summary exists, a bounded sanitized transcript tail is
  allowed only while the direct predecessor is pending or processing, never
  after terminal failure.

Operator backfill is implemented through `memory.summaries.generate`. It accepts
exactly one session id or `all=true`, supports `force` and `dryRun`, discovers
bounded transcript candidates, reconstructs next-session relationships from
usage-family lineage, skips existing records unless forced, and reports each
planned/generated status without bypassing normal summary policy.

The configured default summary model is
`anthropic/claude-sonnet-4-6`. The host plugin LLM boundary remains the trust
owner: an explicit model override is forwarded only when
`plugins.entries.memory-core.llm.allowModelOverride=true`; without that trust,
the fixed default safely falls back to the target agent's model. Non-default
agent generation similarly requires `allowAgentIdOverride=true`.

Completed-session Markdown memory remains a separate durable outbox with a
frozen plan/fingerprint, fenced leases, integrity hashes, and exactly-once file
markers. Only the host appends the canonical memory file. CLI pressure flushes
run in isolated maintenance sessions so they cannot resume, mutate, or pollute
the user's warm Claude process. Receipts pair the native-thread fingerprint
with prompt-token and transcript-byte baselines and support repeated flushes
after real context growth.

### Direct `signal-ts`, early supersession, typing, and deadlines

The Signal plugin contains a lazy direct transport that imports only the bare
package identity `@openclaw/signal-ts`. The runtime environment owns package
resolution; OpenClaw records no checkout path, package version, source URL, or
revision. Direct client/state ownership, persistent receive, envelope
conversion, inbound handling, outbound handling, and probe logic stay in the
plugin. The path supports direct/group text, replies, reactions, typing, read
and retry receipts, stickers, and bounded attachment upload/download through
Signal's trusted fetch path. Existing signal-cli configuration remains a
compatibility path, but it is not a substitute for the direct persistent
`signal-ts` backend.

Same-session supersession now begins at accepted ingress, before attachment
work and before the inbound debounce flush. A newer accepted message aborts the
older reply controller immediately. DM typing starts at that same point, so the
user sees activity during debounce; the superseded controller also stops stale
typing and downstream reply/send work. Ownership tokens prevent an older turn's
finally block from clearing the newer controller.

Outbound `signal-ts` operations combine caller cancellation with their own send
deadline. Passing a supersession signal therefore no longer disables the
transport timeout; caller abort reasons are preserved and an otherwise stuck
send still ends with its deadline. Classified connection retries are bounded,
abortable, and reuse one logical message timestamp. Fatal monitor values are
normalized through typed channel errors without logging message content.

Provisioning remains explicit but host-owned: before selecting the direct
backend, the runtime must make `@openclaw/signal-ts` importable. OpenClaw does
not prescribe how the host installs or resolves it. If the package is absent,
the lazy loader emits a targeted diagnostic instead of silently selecting
signal-cli.

### Structured MCP results remain structured

Gateway bundle-MCP tool calls no longer flatten every result to text. Valid MCP
`text`, `image`, `audio`, `resource_link`, and embedded `resource` blocks cross
the loopback JSON-RPC boundary with their structured fields intact. Strings,
unknown future blocks, and malformed values receive a deterministic text
fallback rather than crashing serialization. This is required for Claude Code
to consume media and resources through the same persistent MCP capture path.

### Reply-path caches are bounded and correctness-keyed

Two caches remove repeated preparation from the warm path without turning
freshness into an assumption:

- Workspace preparation has a 60-second, 64-entry LRU keyed by resolved
  workspace and bootstrap options. Every hit re-stats directory identity
  (`dev`, inode, mtime, and ctime); replacement or mutation falls back to the
  full attestation-aware path. Concurrent identical ensures coalesce. An
  onboarding-pending workspace is not cached because profile-file edits may not
  change parent-directory identity.
- Complete CLI system prompts use a 60-second time bucket and a 64-entry LRU.
  The stable SHA-256 key includes all source inputs and resolved runtime facts:
  config, workspace/cwd, tool schemas, context files, skills, source/reply
  policy, channel/chat/capabilities, plugin guidance, runtime info, user time,
  model, agent, and session identity. A changed fact is a miss; cached partial
  prompts are never assembled with fresh fragments.

Both caches are process-local, bounded, and lifecycle-owned. They do not poll
plugin manifests or other process-stable metadata on every request.

### Other retained narrow behavior

- `tools.fs.allowAllHostSendFileTypes=true` remains an explicit global or
  per-agent local opt-in. It bypasses only the host-read MIME/file-type
  assertion after capability, allowed-root, safe-open/symlink, and size checks.
- `gateway.bind=custom` with `gateway.auth.mode=none` remains the sole explicit
  non-loopback no-secret startup exception. LAN/auto modes and token/password
  modes without secrets remain blocked, and security audit still reports the
  choice as critical.
- PDF work retains only end-to-end caller `AbortSignal` propagation through
  native providers, web fetch/media, document-extractor, and local extraction.
  The old whole-batch inbound retry remains dropped because replay after partial
  effects can duplicate messages.
- Control UI gateway confirmation restores only the token scoped to the
  confirmed gateway. Node 22 worker loading and affected singleton/test cleanup
  were repaired in isolated commits rather than hidden inside feature commits.

## Ownership and quality assessment

The final architecture keeps product forks at their narrowest valid owners:

- Anthropic owns Claude argv, model aliases, native history policy, long-context
  selection, and the persistent Claude transport adapter.
- Core owns provider-neutral CLI streaming, reply cancellation, session
  accessor contracts, and Gateway MCP framing.
- memory-core owns summary policy, durable summary/outbox state, recall, and
  doctor migration.
- Signal owns direct protocol behavior and delegates cryptographic/protocol
  implementation to the host-provided `@openclaw/signal-ts` package.

Hot paths carry prepared identities and use point access instead of rediscovery.
Resource ownership is explicit across cold, warm, restart, cancellation, and
ephemeral runs. Compatibility is concentrated at import/doctor/config mapping
boundaries rather than spread through runtime fallback stacks. Generated schema,
Plugin SDK baselines, public-surface budgets, and affected shrinkwraps are
separate commits. Test-only fixture conversions and singleton cleanup are also
separate from runtime behavior.

Fixture teardown now follows the same ownership model. Ordinary Gateway RPCs
clear read-side caches only; they do not close SQLite handles or reject active
writer queues. Full teardown is reserved for explicit fixture boundaries after
asynchronous chat work reaches a terminal or post-dispatch barrier and before
its temporary directory is removed. A deterministic regression holds one
writer, queues another, performs an unrelated health RPC, and proves both
writes complete in FIFO order.

The remaining material risk is deployment-specific integration, not an
unidentified ownership or broad-gate gap. Real Claude first-turn and resume
behavior has been exercised, while a dedicated cold/warm latency benchmark and
a linked Signal account E2E remain useful follow-up work.

## Implemented commit ledger

This table is the exact output through the parent of the documentation-only
closeout commit:

```bash
git log --reverse --format='%h%x09%s' v2026.7.1-beta.2..HEAD^
```

|   # | Commit       | Subject                                                           |
| --: | ------------ | ----------------------------------------------------------------- |
|   1 | `7babaa734c` | docs: record v2026.7.1-beta.2 custom migration plan               |
|   2 | `45f0025f50` | feat(gateway): expose coding tools to isolated CLI backends       |
|   3 | `bea1bcb924` | feat(anthropic): isolate Claude CLI behind OpenClaw tools         |
|   4 | `a2576d6c4e` | fix(anthropic): enforce isolated Claude CLI overrides             |
|   5 | `5262f27848` | fix(agents): preserve skills with disabled Claude commands        |
|   6 | `8711065b7e` | feat(auto-reply): stream CLI deltas through block delivery        |
|   7 | `2d756725f7` | feat(plugin-sdk): add bounded transcript reads                    |
|   8 | `ac9ecc81d9` | fix(plugin-sdk): sanitize bounded transcript reads                |
|   9 | `c244d76c90` | feat(control-ui): add session summary history                     |
|  10 | `1c489172be` | refactor(anthropic): retire claude-cli-streaming config id        |
|  11 | `901638b1bc` | fix(sessions): migrate retired Claude CLI state                   |
|  12 | `1ef85ccb6a` | fix(memory): isolate CLI pressure flushes                         |
|  13 | `77ca164810` | feat(memory-core): add durable session summary records            |
|  14 | `99761f0ec5` | feat(memory-core): wire session summary lifecycle and recall      |
|  15 | `b6d35ac429` | fix(doctor): migrate legacy session summary config                |
|  16 | `14b76f3c96` | fix(memory-core): harden session summary boundaries               |
|  17 | `22de178e43` | fix(agents): forward fast mode to backend execution hooks         |
|  18 | `d02101dc34` | refactor(config): retire custom fork settings                     |
|  19 | `c3d98e846a` | refactor(sessions): drop retired custom compaction state          |
|  20 | `b0d9bedb10` | feat(memory-core): add durable completed-session flush outbox     |
|  21 | `94f774ba69` | feat(memory-core): wire completed-session memory projection       |
|  22 | `8f571c630e` | fix(signal): restore reply and sticker delivery                   |
|  23 | `a659b5e2bf` | chore(config): refresh custom feature schema baseline             |
|  24 | `69df8c4372` | fix(plugin-sdk): enforce bounded transcript snapshots             |
|  25 | `3568991d9e` | fix(agents): resolve fast mode after queue admission              |
|  26 | `ef5ef5efab` | fix(memory): resolve implicit CLI pressure runtimes               |
|  27 | `449ceaa16e` | fix(memory-core): fence completed-session projections             |
|  28 | `1d1fe5c502` | feat(plugin-sdk): expose doctor migration capacity                |
|  29 | `e633e678dc` | feat(memory-core): import legacy session summaries                |
|  30 | `c4112c2020` | docs: document custom continuity migration                        |
|  31 | `5cd1357d51` | chore: format custom migration files                              |
|  32 | `c41165e857` | chore(lint): satisfy custom migration lint gates                  |
|  33 | `8e7001bc72` | fix(agents): route memory temp files through safe wrapper         |
|  34 | `97c9c4477e` | test(memory-core): complete plugin entry test runtime             |
|  35 | `558ef1b03a` | docs(memory): preserve memory reference manual content            |
|  36 | `2cbad12618` | feat(memory-core): expose session summaries to agents             |
|  37 | `c4c97a7815` | fix(memory-core): stop injecting failed summary tails             |
|  38 | `0277bc9a25` | docs(memory): document session summary policy                     |
|  39 | `e13bddd510` | fix(memory): repeat CLI pressure flushes after context growth     |
|  40 | `b4720ba7d8` | fix(sessions): clear transient CLI flush state on reset           |
|  41 | `6ede630aaf` | docs: finalize custom migration ledger                            |
|  42 | `009ed270e0` | perf(agents): keep captured Claude sessions warm                  |
|  43 | `9057a9ade6` | refactor(sessions): move default store to SQLite                  |
|  44 | `e0f24c285a` | fix(agents): preserve assistant message boundaries                |
|  45 | `89d8652770` | fix(build): support local file dependency shrinkwraps             |
|  46 | `a26843929a` | feat(signal): add direct signal-ts runtime                        |
|  47 | `7a91dd0539` | feat(signal): route channel through signal-ts                     |
|  48 | `be4e77e4ad` | fix(memory): project fresh CLI output pressure                    |
|  49 | `8588ca2ede` | perf(agents): trace warm Claude turn latency                      |
|  50 | `5fbb098933` | feat(agents): expose effective context to backends                |
|  51 | `33cf239c81` | fix(anthropic): retain Claude CLI long context                    |
|  52 | `8d535c434d` | feat(media): allow opted-in host attachment types                 |
|  53 | `47e94c01e7` | feat(gateway): allow explicit unauthenticated custom binds        |
|  54 | `88fc0c7b25` | fix(pdf): propagate caller cancellation through analysis          |
|  55 | `ea99c13526` | fix(signal): reuse timestamps across send retries                 |
|  56 | `a73b81d1b7` | fix(sessions): harden SQLite import and migration primitives      |
|  57 | `e21ffc53f3` | refactor(sessions): migrate legacy repair flows to SQLite         |
|  58 | `1e813cb60d` | feat(doctor): inspect and repair SQLite session stores            |
|  59 | `feec385da8` | fix(memory): resolve transcript identity through session accessor |
|  60 | `1e0c776200` | refactor(qa-lab): read sessions through canonical store           |
|  61 | `240d1709f2` | perf(codex): read startup session metadata by key                 |
|  62 | `f5d930064c` | perf(qqbot): read group activation by session key                 |
|  63 | `039ddbf632` | fix(macos): keep the default SQLite store implicit                |
|  64 | `9a90bfd417` | fix(sessions): add race-safe store inspection and deletion        |
|  65 | `2239930a2f` | fix(feishu): make session repair SQLite-safe                      |
|  66 | `471163f7d5` | perf(sessions): keep latest SQLite reads keyed                    |
|  67 | `16e95f67d2` | fix(agents): recover subagent depth from SQLite                   |
|  68 | `6fcc04d3ab` | perf(sessions): keep logical SQLite access row-scoped             |
|  69 | `b6c24caba2` | feat(plugin-sdk): append scoped transcript events                 |
|  70 | `8225ceac64` | fix(msteams): persist feedback through session accessors          |
|  71 | `2a6fff79ce` | perf(gateway): use point reads for keyed session lookups          |
|  72 | `4eb6a765f5` | perf(agents): point-read known command sessions                   |
|  73 | `c0c713317d` | perf(auto-reply): point-read dispatch session state               |
|  74 | `048457a657` | perf(heartbeat): keep session access row-scoped                   |
|  75 | `34585298aa` | perf(cron): point-read isolated session state                     |
|  76 | `cc09f3d07a` | perf(agents): point-read follow-up session state                  |
|  77 | `5917d90340` | perf(auto-reply): point-read export session state                 |
|  78 | `754dac2b52` | chore(config): refresh generated schema baseline                  |
|  79 | `ddbb90d44e` | chore(plugin-sdk): refresh generated API baseline                 |
|  80 | `2e2279a937` | chore(deps): refresh root dependency shrinkwrap                   |
|  81 | `27eb5cdeb6` | chore(deps): refresh llama-cpp shrinkwrap                         |
|  82 | `10d6928ea4` | chore(deps): refresh Microsoft Teams shrinkwrap                   |
|  83 | `2e294b78ed` | chore(deps): refresh Twitch shrinkwrap                            |
|  84 | `a49499ec4c` | fix(signal): normalize fatal monitor errors                       |
|  85 | `300a908950` | fix(agents): load source workers on Node 22                       |
|  86 | `4392185037` | fix(sessions): keep temporary mapping restores keyed              |
|  87 | `c0353b9771` | test(gateway): isolate boot session store tests                   |
|  88 | `67a3b755b1` | test(gateway): isolate shared worker test state                   |
|  89 | `36f1bb9ceb` | test(sessions): close SQLite handles in test cleanup              |
|  90 | `4eb2a246d8` | test(tasks): exercise maintenance through SQLite stores           |
|  91 | `c2a8e7efbe` | test(cron): seed delivery tests through session stores            |
|  92 | `2ab2e334a6` | test(acp): expect canonical SQLite session stores                 |
|  93 | `d103ecba87` | test(agents): persist subagent fixtures through session stores    |
|  94 | `5788f0c443` | test(agents): align ACP spawn fixture with depth policy           |
|  95 | `84b89cbadd` | test(auto-reply): cover default per-agent SQLite stores           |
|  96 | `cc3b60d9aa` | fix(doctor): honor resolved session stores                        |
|  97 | `a9e30036b9` | test(memory-core): exercise dreaming cleanup through SQLite       |
|  98 | `0211161e47` | test(matrix): clear runtime state after approval tests            |
|  99 | `c94eae625c` | test(imessage): isolate watch retry runtime state                 |
| 100 | `8da75e0a02` | test(cli): isolate gateway auth test state                        |
| 101 | `fe4a9a9f53` | fix(node-host): compare canonical allowlist executables           |
| 102 | `f151baa844` | chore(plugin-sdk): refresh public surface budgets                 |
| 103 | `c541567aac` | refactor(scripts): share pnpm lock package parsing                |
| 104 | `3c189563ad` | test(plugins): register typed hook contract surfaces              |
| 105 | `077970d91e` | test(plugins): expect memory-core at gateway startup              |
| 106 | `4b944dae6d` | perf(auto-reply): point-read fast path session state              |
| 107 | `7d21349f23` | test(cli): restore gateway auth test environment                  |
| 108 | `fb71ea0e2f` | test(memory-core): close dreaming SQLite handles                  |
| 109 | `efcbbcd543` | refactor(agents): retire reset main generations                   |
| 110 | `44e5af1202` | fix(memory-core): close isolated Claude maintenance sessions      |
| 111 | `48d8bdb9ed` | fix(anthropic): restore Fable 5 routing                           |
| 112 | `9d702cc6ca` | perf(sessions): point-write inbound SQLite state                  |
| 113 | `191de7df07` | fix(anthropic): restore explicit 1M selectors                     |
| 114 | `40762ae4ef` | fix(control-ui): restore scoped tokens on gateway confirm         |
| 115 | `bf604bb4e5` | fix(gateway): release ephemeral CLI live sessions                 |
| 116 | `512f17c8af` | fix(agents): close ephemeral helper sessions                      |
| 117 | `c53086e348` | fix(agents): separate aggregate and context usage                 |
| 118 | `7060fdee11` | fix(sessions): preserve legacy SQLite store paths                 |
| 119 | `3aad9ede23` | perf(sessions): keep exact SQLite mutations row-scoped            |
| 120 | `663b3137b9` | perf(sessions): point-read transcript persistence                 |
| 121 | `8efb2058b7` | fix(auto-reply): cancel superseded queued deliveries              |
| 122 | `f680066691` | fix(signal): preempt stale inbound replies                        |
| 123 | `0e0bd19766` | fix(gateway): preserve structured MCP tool results                |
| 124 | `78065b85af` | fix(sessions): preserve arbitrary legacy store paths              |
| 125 | `b75ce31200` | fix(sessions): verify SQLite fast-path targets                    |
| 126 | `a52c304f80` | fix(memory-core): restore summary lineage and backfill            |
| 127 | `f8633030d1` | perf(agents): cache validated workspace preparation               |
| 128 | `327719b4da` | perf(agents): cache complete warm system prompts                  |
| 129 | `3f1118384f` | fix(agents): use last-call context usage                          |
| 130 | `3f97c57ff8` | fix(signal): supersede replies at accepted ingress                |
| 131 | `0b19a2d5b2` | fix(signal): retain send deadlines under cancellation             |
| 132 | `a78799edbd` | fix(agents): bind launch resources to live children               |
| 133 | `c0e71e6a91` | test(sessions): read configured SQLite session state              |
| 134 | `88b7e93a99` | fix(agents): restore structured continuity rollover               |
| 135 | `3c81d13298` | chore(config): refresh memory summary baseline                    |
| 136 | `96f1fb69d8` | test(plugins): resolve configured plugin session stores           |
| 137 | `94dbdf9239` | docs(memory): document summary continuity                         |
| 138 | `08675f375a` | feat(providers): classify externalized endpoints without plugins  |
| 139 | `476e4e73a7` | fix(sessions): preserve JSON5 legacy imports                      |
| 140 | `d7eedc101f` | fix(msteams): discover legacy feedback sidecars                   |
| 141 | `1f1b5cf2ea` | test(gateway): resolve gateway session backends                   |
| 142 | `6ec018752a` | test(cron): resolve scheduled session backends                    |
| 143 | `afd3ad2c2e` | test(channels): resolve channel session backends                  |
| 144 | `62bdbb2f95` | test(agents): resolve agent session backends                      |
| 145 | `5b88ec6ebb` | test(acp): resolve ACP session backends                           |
| 146 | `d77c405d6d` | test(auto-reply): resolve reply session backends                  |
| 147 | `06ce751044` | test(sessions): resolve session management backends               |
| 148 | `35cf069cb7` | test(state): exercise SQLite state migrations                     |
| 149 | `2c29716b49` | test(plugins): resolve plugin host session backends               |
| 150 | `16287058b2` | fix(msteams): key migrated feedback by runtime store              |
| 151 | `7786c5c4ce` | test(gateway): preserve malformed checkpoint sources              |
| 152 | `2ac99bb73f` | refactor(sessions): normalize migration store path planning       |
| 153 | `9addef3bfc` | fix(heartbeat): restore activity timestamps exactly               |
| 154 | `dcea59bc7d` | test(heartbeat): preserve seeded heartbeat timestamps             |
| 155 | `269a677032` | test(gateway): restore checkpoint trim fixture directory          |
| 156 | `98a27c7589` | test(gateway): resolve gateway agent session backends             |
| 157 | `52c6246780` | test(gateway): resolve gateway chat session backends              |
| 158 | `bc33a90ad0` | test(cli): resolve command session backends                       |
| 159 | `a10019d07c` | test(onboarding): isolate onboarding git trust fixture            |
| 160 | `924383803f` | test(state): read migrated orphan keys from SQLite                |
| 161 | `e8c2bb66b0` | test(sessions): close SQLite stores before temp cleanup           |
| 162 | `8d0f378333` | test(gateway): preserve active Gateway session writers            |
| 163 | `943be66042` | chore(plugin-sdk): refresh generated API baseline                 |
| 164 | `f646eaf1df` | fix(agents): initialize pending sessions atomically               |
| 165 | `6f6082b50a` | test(agents): simplify Claude launch cleanup assertions           |
| 166 | `b6ad4a78a7` | fix(memory-core): avoid placeholder backfill timestamps           |
| 167 | `646a3d4a73` | docs: finalize custom port audit                                  |
| 168 | `402702439b` | feat(anthropic): add Claude Sonnet 5 support                      |
| 169 | `44e5296688` | refactor(signal): decouple signal-ts host runtime                 |
| 170 | `26015deda0` | docs: document Sonnet 5 and direct Signal runtime                 |

No commit from `origin/custom/20260415` was replayed. Runtime behavior,
migration/config boundaries, generated artifacts, package shrinkwraps,
test-fixture conversions, and lifecycle cleanup were kept in separately
reviewable commits with action-oriented subjects.

## Verification evidence and final gate

The following focused results are recorded from the current migration work.
They are separate batches and may overlap; they must not be added together as a
single suite total:

- five-file memory-core summary/memory batch: 101 tests passed;
- precise summary-lineage filter: 8 tests passed;
- memory summary config/manifest batch: 4 tests passed;
- Claude native-history continuity/redaction/MCP-ownership batch: 6 tests
  passed;
- Claude preflight/fail-soft/session-fence batch: 63 tests passed;
- warm CLI system-prompt cache helper batch: 31 tests passed;
- `src/auto-reply/reply/session.test.ts`: 128 tests passed serially after
  configured-store fixture correction;
- `src/plugins/contracts/session-entry-projection.contract.test.ts`: 13 tests
  passed after configured-store fixture correction;
- six-file lifecycle/resource cleanup batch: 164 tests passed;
- provider attribution/Qwen compatibility batch: 3 files, 46 tests passed;
- JSON5/SQLite legacy import batch: 26 tests passed;
- Microsoft Teams doctor migration batch: 6 tests passed;
- auto-reply/channel resolved-store batch: 9 files, 488 tests passed;
- Gateway server/store batch: 11 files, 116 tests passed;
- final Gateway chat, orphan-migration, and writer-queue batch: 210 tests
  passed;
- final Claude live-session, launch-resource, and memory closeout batch: 4
  shards, 247 tests passed on the exact final implementation tree;
- local Claude Code 2.1.201 selected Sonnet 5 successfully in both its normal
  adaptive mode and `xhigh` mode;
- the authenticated OpenClaw Gateway Sonnet 5 probe passed a real initial turn
  and a resumed follow-up; deterministic unit coverage separately proves that
  repeated warm turns reuse the same persistent child process;
- a clean external `@openclaw/signal-ts` checkout passed its own check and
  build, host-injection validation resolved the bare package import, and the
  missing-package path returned its targeted diagnostic. No linked-account
  Signal live E2E is claimed;
- `pnpm docs:list` passed;
- scoped formatting/diff checks recorded for the touched fixes passed.

Final verification status for
`26015deda069f8820e6a84f4b9b358d401283522`:

- clean-room full `pnpm test` at runtime-code snapshot `8d0f378333`: 89 Vitest
  shards passed in 3462.76 seconds. The later atomic pending-session
  initialization and two lint-only cleanups were covered by the exact-tree
  targeted batch above; the generated-hash refresh was verified by the Plugin
  SDK API check below;
- full `pnpm build`: passed. CLI/runtime output, Plugin SDK exports, bundled
  plugin assets, Control UI, and CLI startup metadata all built successfully;
  no `[INEFFECTIVE_DYNAMIC_IMPORT]` warning was emitted. The existing Control
  UI chunk-size advisory remains informational;
- broad `pnpm check`: passed on the final tree, including all preflight and policy guards,
  production core/extension typechecks, and core/extension/script lint;
- `pnpm config:docs:check` and `pnpm plugin-sdk:api:check`: passed with both
  generated hashes current;
- explicit `pnpm tsgo`: passed. Targeted oxfmt checks passed for every final
  closeout file and both audit documents;
- full `pnpm format` is a write-mode command on this release and exposed 203
  formatter changes inherited unchanged from the peeled target. Their path
  intersection with `v2026.7.1-beta.2..HEAD` is zero, so those unrelated target
  changes were discarded rather than folded into this custom port;
- authenticated Claude Code Sonnet 5 direct-CLI and Gateway first/resume probes:
  passed with Claude Code 2.1.201. A linked-account direct Signal E2E was not
  run;
- `pnpm docs:check-mdx`, `pnpm docs:check-links`, and `pnpm docs:map:check`
  passed. `pnpm docs:check-i18n-glossary` remains blocked by the branch-wide
  inherited glossary backlog (more than 1,000 existing changed labels); no
  generated translation or baseline file was altered to hide it.

The first full-suite attempt used a sandbox temp root whose ancestor contained
an injected empty `.git` directory. Three Git-root assertions failed for that
environmental reason. The same 12 assertions passed in an isolated `/var/tmp`
recheck, after which the complete 89-shard clean-room run passed. No test,
baseline, snapshot, or expected-failure file was changed to hide the issue.

Build was treated as a material gate because the migration changes Plugin
SDK/public types, lazy runtime boundaries, host-provided Signal dependency
resolution, generated configuration, and CLI process/resource ownership. It
passed without ineffective dynamic-import warnings.

The authenticated Claude evidence covers Sonnet 5 selection, normal and
`xhigh` turns, Gateway first-turn execution, and resume. Unit coverage proves
same-process warm reuse. It does not replace dedicated latency measurement or
live restart, rollover, structured MCP content, and resource-cleanup probes.
The Signal package check/build, positive host-injection import, and negative
missing-package diagnostic likewise do not replace a linked Signal
device/account test covering receive, early typing, supersession, replies,
attachments, retry identity, and deadline behavior.

## Finalization record

1. Implementation, generated-artifact, and test-fixture work is complete
   through `26015deda069f8820e6a84f4b9b358d401283522`.
2. The final targeted closeout, broad check, and static/build gates ran against
   that implementation tree; the earlier clean-room full-suite snapshot and
   exact results are recorded above.
3. This ledger was regenerated from the exact command above while the closeout
   file remained uncommitted; its row count is 170.
4. Commit this closeout as the next, documentation-only scope. Its commit is
   expected to make the branch count 171; do not try to embed that
   self-referential docs commit SHA in this file.
5. The peeled target is an ancestor of the implementation HEAD, and
   `origin/custom/20260415` still points at its audited source SHA.

This branch is local-only. No remote push, PR, GitHub comment, release mutation,
or source-branch rewrite is part of this migration closeout.
