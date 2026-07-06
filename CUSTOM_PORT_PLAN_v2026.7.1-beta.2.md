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
- Final implementation snapshot immediately before the closeout documentation
  commit: `bb7844c742d602f2121270cdae6eb5b13996e480`.
- Implementation commits after the peeled target at that snapshot: 166.
- Final gate status: runtime-code snapshot `46c6826740` passed all 89 Vitest
  shards in the clean-room run. The final implementation tree at `bb7844c742`
  passed the targeted closeout tests, broad check, build, tsgo,
  generated-baseline checks, and scoped format checks recorded below.
- Direct Signal dependency: sibling `../signal-ts` at
  `d291d7d30159a713681324410ace608a5aa434e0`.

A committed file cannot contain its own stable commit SHA: adding that SHA
changes the commit again. The ledger below is therefore the mechanically
generated pre-closeout log through
`bb7844c742d602f2121270cdae6eb5b13996e480` (166 commits). The
documentation-only closeout commit is intentionally outside that count and is
expected to make the branch count 167.

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
95 source-only custom commits. `79ddc14602` adapts upstream `49302fcb7d` to the
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

The Signal plugin contains a lazy direct transport backed by the user-owned
sibling `../signal-ts` checkout. Direct client/state ownership, persistent
receive, envelope conversion, inbound handling, outbound handling, and probe
logic stay in the plugin. The path supports direct/group text, replies,
reactions, typing, read and retry receipts, stickers, and bounded attachment
upload/download through Signal's trusted fetch path. Existing signal-cli
configuration remains a compatibility path, but it is not a substitute for the
direct persistent `signal-ts` backend.

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

Provisioning remains explicit: place the sibling repository at `../signal-ts`,
check out `d291d7d30159a713681324410ace608a5aa434e0`, and build it before a clean
local OpenClaw install/build. This is a local deployment dependency, not an
upstream package assumption.

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
  implementation to the pinned sibling library.

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

The remaining material risk is live integration, not an unidentified ownership
or broad-gate gap: real Claude and Signal accounts are still needed to prove
deployed warm-process latency and device behavior.

## Implemented commit ledger

This table is the exact current pre-closeout output of:

```bash
git log --reverse --format='%h%x09%s' v2026.7.1-beta.2..HEAD
```

|   # | Commit       | Subject                                                      |
| --: | ------------ | ------------------------------------------------------------ |
|   1 | `f96fdd95aa` | Docs: record v2026.7.1-beta.2 custom migration plan          |
|   2 | `fc5b8d5fc1` | Gateway: expose coding tools to isolated CLI backends        |
|   3 | `7c5504cce5` | Anthropic: isolate Claude CLI behind OpenClaw tools          |
|   4 | `3b80939b61` | Anthropic: enforce isolated Claude CLI overrides             |
|   5 | `cb33c75017` | CLI: preserve skills with disabled Claude commands           |
|   6 | `b07bcaabae` | Reply: stream CLI deltas through block delivery              |
|   7 | `1c819e6024` | Plugin SDK: add bounded transcript reads                     |
|   8 | `9117d4b37e` | Plugin SDK: sanitize bounded transcript reads                |
|   9 | `afdd58eade` | Control UI: add session summary history                      |
|  10 | `b00de71aa4` | Anthropic: retire claude-cli-streaming config id             |
|  11 | `1942f32d23` | Sessions: migrate retired Claude CLI state                   |
|  12 | `a38c54d954` | Memory: isolate CLI pressure flushes                         |
|  13 | `3b713fcce1` | Memory: add durable session summary records                  |
|  14 | `8f2d2d067e` | Memory: wire session summary lifecycle and recall            |
|  15 | `ae5d89ab9e` | Memory: migrate legacy session summary config                |
|  16 | `dedbbedf5b` | Memory: harden session summary boundaries                    |
|  17 | `c596546b2c` | CLI: forward fast mode to backend execution hooks            |
|  18 | `31abc29687` | Config: retire custom fork settings                          |
|  19 | `931b191e42` | Sessions: drop retired custom compaction state               |
|  20 | `fcfdd96258` | Memory: add durable completed-session flush outbox           |
|  21 | `b4dd9b3536` | Memory: wire completed-session memory projection             |
|  22 | `c86830fd87` | Signal: restore reply and sticker delivery                   |
|  23 | `974030fc71` | Config: refresh custom feature schema baseline               |
|  24 | `660630a217` | Plugin SDK: enforce bounded transcript snapshots             |
|  25 | `a728b5be59` | CLI: resolve fast mode after queue admission                 |
|  26 | `00374ed4b5` | Memory: resolve implicit CLI pressure runtimes               |
|  27 | `d9bf14acce` | Memory: fence completed-session projections                  |
|  28 | `a91b3331c1` | Plugin state: expose doctor migration capacity               |
|  29 | `9b9f23a6a3` | Memory: import legacy session summaries                      |
|  30 | `71d97e388d` | Docs: document custom continuity migration                   |
|  31 | `ef9678f149` | Chore: format custom migration files                         |
|  32 | `f08c52d711` | Chore: satisfy custom migration lint gates                   |
|  33 | `6cdb51409e` | CLI: route memory temp files through safe wrapper            |
|  34 | `dee063f31c` | Memory: complete plugin entry test runtime                   |
|  35 | `8225c24011` | Docs: preserve memory reference manual content               |
|  36 | `2dcbf4ade6` | Memory: expose session summaries to agents                   |
|  37 | `8e668c60a4` | Memory: stop injecting failed summary tails                  |
|  38 | `a9194042ab` | Memory: document session summary policy                      |
|  39 | `481f3205d3` | Memory: repeat CLI pressure flushes after context growth     |
|  40 | `2d7f2d59ff` | Sessions: clear transient CLI flush state on reset           |
|  41 | `6d210c42fb` | Docs: finalize custom migration ledger                       |
|  42 | `348f0c4712` | CLI: keep captured Claude sessions warm                      |
|  43 | `0f599f9f2d` | Sessions: move default store to SQLite                       |
|  44 | `dd942c3ef2` | CLI: preserve assistant message boundaries                   |
|  45 | `f9733ca43a` | Build: support local file dependency shrinkwraps             |
|  46 | `0bfc11b5a3` | Signal: add direct signal-ts runtime                         |
|  47 | `8007ac4440` | Signal: route channel through signal-ts                      |
|  48 | `6a96445633` | Memory: project fresh CLI output pressure                    |
|  49 | `53a80b0888` | CLI: trace warm Claude turn latency                          |
|  50 | `e6bb981364` | CLI: expose effective context to backends                    |
|  51 | `03d5c25338` | Anthropic: retain Claude CLI long context                    |
|  52 | `917b81e58a` | Media: allow opted-in host attachment types                  |
|  53 | `5059233fa9` | Gateway: allow explicit unauthenticated custom binds         |
|  54 | `2d443e6651` | PDF: propagate caller cancellation through analysis          |
|  55 | `3ec40849b0` | Signal: reuse timestamps across send retries                 |
|  56 | `4c0c3e6e97` | Sessions: harden SQLite import and migration primitives      |
|  57 | `b8b1b7a04b` | Sessions: migrate legacy repair flows to SQLite              |
|  58 | `4f0b55b1bd` | Doctor: inspect and repair SQLite session stores             |
|  59 | `d2a9943ef1` | Memory: resolve transcript identity through session accessor |
|  60 | `f232517692` | QA Lab: read sessions through canonical store                |
|  61 | `295345eb20` | Codex: read startup session metadata by key                  |
|  62 | `8af1844d64` | QQBot: read group activation by session key                  |
|  63 | `8809338099` | macOS: keep the default SQLite store implicit                |
|  64 | `ff00bd5f12` | Sessions: add race-safe store inspection and deletion        |
|  65 | `3b2ff6f785` | Feishu: make session repair SQLite-safe                      |
|  66 | `644dc1aa09` | Sessions: keep latest SQLite reads keyed                     |
|  67 | `2d068c1ce1` | Agents: recover subagent depth from SQLite                   |
|  68 | `c38afca9ea` | Sessions: keep logical SQLite access row-scoped              |
|  69 | `24c18e9956` | Plugin SDK: append scoped transcript events                  |
|  70 | `a79ac36f19` | Microsoft Teams: persist feedback through session accessors  |
|  71 | `754ad61ccc` | Gateway: use point reads for keyed session lookups           |
|  72 | `9a731e2121` | Agents: point-read known command sessions                    |
|  73 | `645dda4aa1` | Reply: point-read dispatch session state                     |
|  74 | `f1c9d0b10c` | Heartbeat: keep session access row-scoped                    |
|  75 | `7e881d9d32` | Cron: point-read isolated session state                      |
|  76 | `55693813b2` | Agents: point-read follow-up session state                   |
|  77 | `83fdc2dbd1` | Reply: point-read export session state                       |
|  78 | `658ec70397` | Config: refresh generated schema baseline                    |
|  79 | `cf0d294efe` | Plugin SDK: refresh generated API baseline                   |
|  80 | `7dd420188d` | Build: refresh root dependency shrinkwrap                    |
|  81 | `0e70784c11` | Build: refresh llama-cpp shrinkwrap                          |
|  82 | `3c5584dcd3` | Build: refresh Microsoft Teams shrinkwrap                    |
|  83 | `d783dcbfb3` | Build: refresh Twitch shrinkwrap                             |
|  84 | `40fda913ba` | Signal: normalize fatal monitor errors                       |
|  85 | `5ffc6489b0` | Agents: load source workers on Node 22                       |
|  86 | `aafbcac3f1` | Sessions: keep temporary mapping restores keyed              |
|  87 | `643c3fec3c` | Gateway: isolate boot session store tests                    |
|  88 | `1188f6aa34` | Gateway: isolate shared worker test state                    |
|  89 | `445b41cf57` | Sessions: close SQLite handles in test cleanup               |
|  90 | `b2b111279a` | Tasks: exercise maintenance through SQLite stores            |
|  91 | `6555ad5ad4` | Cron: seed delivery tests through session stores             |
|  92 | `4600fa2509` | ACP: expect canonical SQLite session stores                  |
|  93 | `8f4ae7e36a` | Agents: persist subagent fixtures through session stores     |
|  94 | `e62b155ee5` | Agents: align ACP spawn fixture with depth policy            |
|  95 | `8c5b0222d7` | Reply: test default per-agent SQLite stores                  |
|  96 | `77240cd509` | Doctor: honor resolved session stores                        |
|  97 | `c97e4e370b` | Memory: exercise dreaming cleanup through SQLite             |
|  98 | `3ef24c13fe` | Matrix: clear runtime state after approval tests             |
|  99 | `6e6606fc1a` | iMessage: isolate watch retry runtime state                  |
| 100 | `d6a9fd034d` | CLI: isolate gateway auth test state                         |
| 101 | `5ff36a98ec` | Node host: compare canonical allowlist executables           |
| 102 | `af2995fbb2` | Plugin SDK: refresh public surface budgets                   |
| 103 | `ce79c895eb` | Build: share pnpm lock package parsing                       |
| 104 | `5c5c9235ac` | Memory: register typed hook contract surfaces                |
| 105 | `1b11d954d9` | Plugins: expect memory-core at gateway startup               |
| 106 | `c757fa6147` | Reply: point-read fast path session state                    |
| 107 | `72c0bf9706` | CLI: restore gateway auth test environment                   |
| 108 | `10c09e0c16` | Memory: close dreaming SQLite handles                        |
| 109 | `ba08f08946` | Claude CLI: retire reset main generations                    |
| 110 | `90115b2dfe` | Memory: close isolated Claude maintenance sessions           |
| 111 | `bd45689bc1` | Claude CLI: restore Fable 5 routing                          |
| 112 | `4335ee3490` | Sessions: point-write inbound SQLite state                   |
| 113 | `eb43bdcee1` | Claude CLI: restore explicit 1M selectors                    |
| 114 | `b577151dfc` | Control UI: restore scoped tokens on gateway confirm         |
| 115 | `427d45c87e` | Gateway: release ephemeral CLI live sessions                 |
| 116 | `499a0ddaba` | CLI: close ephemeral helper sessions                         |
| 117 | `eaeb59334e` | Claude CLI: separate aggregate and context usage             |
| 118 | `24925c104b` | Sessions: preserve legacy SQLite store paths                 |
| 119 | `4749a74f2a` | Sessions: keep exact SQLite mutations row-scoped             |
| 120 | `65c6eece37` | Sessions: point-read transcript persistence                  |
| 121 | `db499674c3` | Reply: cancel superseded queued deliveries                   |
| 122 | `fd197c92c5` | Signal: preempt stale inbound replies                        |
| 123 | `85f2585789` | Gateway: preserve structured MCP tool results                |
| 124 | `8ba169d2d6` | Sessions: preserve arbitrary legacy store paths              |
| 125 | `2d02358e7b` | Sessions: verify SQLite fast-path targets                    |
| 126 | `6fc4413ab9` | Memory: restore summary lineage and backfill                 |
| 127 | `4d4d3c8e42` | Reply: cache validated workspace preparation                 |
| 128 | `119402733b` | CLI: cache complete warm system prompts                      |
| 129 | `94814b4e77` | Claude CLI: use last-call context usage                      |
| 130 | `b429eb2cce` | Signal: supersede replies at accepted ingress                |
| 131 | `cf8490d5eb` | Signal: retain send deadlines under cancellation             |
| 132 | `d528187d5d` | Claude CLI: bind launch resources to live children           |
| 133 | `6a5f2955fa` | Tests: read configured SQLite session state                  |
| 134 | `21aecdcc7b` | Claude CLI: restore structured continuity rollover           |
| 135 | `78a1eb10e1` | Config: refresh memory summary baseline                      |
| 136 | `41276e07ed` | Tests: resolve configured plugin session stores              |
| 137 | `5ca56b84bf` | Docs: document summary continuity                            |
| 138 | `79ddc14602` | Providers: classify externalized endpoints without plugins   |
| 139 | `d6afc7a25f` | Sessions: preserve JSON5 legacy imports                      |
| 140 | `873b8d2307` | MS Teams: discover legacy feedback sidecars                  |
| 141 | `8ac26907ee` | Tests: resolve gateway session backends                      |
| 142 | `adc3caf6a2` | Tests: resolve scheduled session backends                    |
| 143 | `67ee7baf92` | Tests: resolve channel session backends                      |
| 144 | `b7f2bcd55d` | Tests: resolve agent session backends                        |
| 145 | `1d8cd3b705` | Tests: resolve ACP session backends                          |
| 146 | `4cf13e1195` | Tests: resolve reply session backends                        |
| 147 | `0914851f94` | Tests: resolve session management backends                   |
| 148 | `7354cc787f` | Tests: exercise SQLite state migrations                      |
| 149 | `e39c6543f7` | Tests: resolve plugin host session backends                  |
| 150 | `45357b8053` | MS Teams: key migrated feedback by runtime store             |
| 151 | `14a6c1be17` | Tests: preserve malformed checkpoint sources                 |
| 152 | `d0de347533` | Sessions: normalize migration store path planning            |
| 153 | `7cf199b64f` | Heartbeat: restore activity timestamps exactly               |
| 154 | `66b99a07c1` | Tests: preserve seeded heartbeat timestamps                  |
| 155 | `4dd25e6c9b` | Tests: restore checkpoint trim fixture directory             |
| 156 | `afe8114353` | Tests: resolve gateway agent session backends                |
| 157 | `5621f3dae1` | Tests: resolve gateway chat session backends                 |
| 158 | `d21e1bd4aa` | Tests: resolve command session backends                      |
| 159 | `efcbda721d` | Tests: isolate onboarding git trust fixture                  |
| 160 | `b12a483414` | Tests: read migrated orphan keys from SQLite                 |
| 161 | `f2e3a222f2` | Tests: close SQLite stores before temp cleanup               |
| 162 | `46c6826740` | Tests: preserve active Gateway session writers               |
| 163 | `5db8988bbc` | Plugin SDK: refresh generated API baseline                   |
| 164 | `5cb6bed3b2` | Claude CLI: initialize pending sessions atomically           |
| 165 | `48b8f358c5` | Tests: simplify Claude launch cleanup assertions             |
| 166 | `bb7844c742` | Memory: avoid placeholder backfill timestamps                |

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
- `pnpm docs:list` passed;
- scoped formatting/diff checks recorded for the touched fixes passed.

Final verification status for
`bb7844c742d602f2121270cdae6eb5b13996e480`:

- clean-room full `pnpm test` at runtime-code snapshot `46c6826740`: 89 Vitest
  shards passed in 3462.76 seconds. The later atomic pending-session
  initialization and two lint-only cleanups were covered by the exact-tree
  targeted batch above; the generated-hash refresh was verified by the Plugin
  SDK API check below;
- full `pnpm build`: passed. CLI/runtime output, Plugin SDK exports, bundled
  plugin assets, Control UI, and CLI startup metadata all built successfully;
  no `[INEFFECTIVE_DYNAMIC_IMPORT]` warning was emitted. The existing Control
  UI chunk-size advisory remains informational;
- broad `pnpm check --timed`: passed, including all preflight and policy guards,
  production core/extension typechecks, and core/extension/script lint;
- `pnpm config:docs:check` and `pnpm plugin-sdk:api:check`: passed with both
  generated hashes current;
- explicit `pnpm tsgo`: passed. Targeted oxfmt checks passed for every final
  closeout file and both audit documents;
- full `pnpm format` is a write-mode command on this release and exposed 203
  formatter changes inherited unchanged from the peeled target. Their path
  intersection with `v2026.7.1-beta.2..HEAD` is zero, so those unrelated target
  changes were discarded rather than folded into this custom port;
- live Claude Code and Signal integration: not run.

The first full-suite attempt used a sandbox temp root whose ancestor contained
an injected empty `.git` directory. Three Git-root assertions failed for that
environmental reason. The same 12 assertions passed in an isolated `/var/tmp`
recheck, after which the complete 89-shard clean-room run passed. No test,
baseline, snapshot, or expected-failure file was changed to hide the issue.

Build was treated as a material gate because the migration changes Plugin
SDK/public types, lazy runtime boundaries, local-file dependency packaging,
generated configuration, and CLI process/resource ownership. It passed without
ineffective dynamic-import warnings.

No live-provider proof is claimed. Focused and integration tests do not replace
a real authenticated persistent Claude Code process test, including warm reuse,
restart, rollover, structured MCP content, and resource cleanup. They also do
not replace a linked Signal device/account test covering receive, early typing,
supersession, replies, attachments, retry identity, and deadline behavior.

## Finalization record

1. Implementation, generated-artifact, and test-fixture work is complete
   through `bb7844c742d602f2121270cdae6eb5b13996e480`.
2. The final targeted closeout, broad check, and static/build gates ran against
   that implementation tree; the earlier clean-room full-suite snapshot and
   exact results are recorded above.
3. This ledger was regenerated from the exact command above while the closeout
   file remained uncommitted; its row count is 166.
4. Commit this closeout as the next, documentation-only scope. Its commit is
   expected to make the branch count 167; do not try to embed that
   self-referential docs commit SHA in this file.
5. The peeled target is an ancestor of the implementation HEAD, and
   `origin/custom/20260415` still points at its audited source SHA.

This branch is local-only. No remote push, PR, GitHub comment, release mutation,
or source-branch rewrite is part of this migration closeout.
