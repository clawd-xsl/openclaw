# Custom commit analysis for `v2026.7.1-beta.2`

This document records the semantic review of every commit unique to
`origin/custom/20260415` after its common base with upstream. It is the decision
record for rebuilding the intentional product differences on top of the target
release rather than rebasing or replaying the old implementation.

## Baseline and method

- Source branch: `origin/custom/20260415` at `0f4877e7cf`
- Common base: `v2026.4.14` at `323493fa1b6adc1e10b9954a68d5eaa5a6ef1170`
- Target release: `v2026.7.1-beta.2` at `a580a7fe3fbd1b3329c978d58ca2f70e8ca37aee`
- Source-only commits reviewed: 95
- Target-side commits after the common base: 32,700
- Review order: chronological, followed by end-state review by feature family

Handoff branch: `custom/20260705`. It is rooted directly at the peeled target
release and rebuilds the retained behavior without moving or replaying the
source branch. The final implementation preserves the four decisions below;
direct `signal-ts`, restricted security bypasses, obsolete compaction overlays,
and the old summary table design remain deliberately absent.

The review compared behavior, not patch identity. A `git cherry` result of `+`
only says a patch is not byte-for-byte present upstream; it does not establish
that its bug or product need remains. Every decision below was checked against
the target implementation, public plugin boundaries, current lifecycle hooks,
and current tests.

Decision meanings:

- **REDESIGN**: preserve the product behavior, but rebuild it on current seams.
- **ADOPT UPSTREAM**: the target implements the intent more completely; do not replay.
- **DROP**: obsolete, generated, diagnostic-only, unsafe, or no longer desirable.
- **DEFER**: potentially useful, but needs deployment evidence or a missing prerequisite.
- **BLOCKED**: a real product capability that cannot be made reproducible from the available source.

## Executive result

The 95 commits collapse into four product decisions:

1. **Session summaries and durable memory are retained.** Completed-session
   summaries, direct-successor recall, rollover memory capture, and CLI
   context-pressure memory capture remain meaningful product differences. The
   old implementation must be replaced because it writes an auxiliary table
   into the memory index database, identifies records by `session_id` alone,
   reads raw JSONL synchronously, performs non-durable fire-and-forget work, and
   has no claim/retry/version/fingerprint model. Existing legacy summary rows
   are imported through doctor into bounded plugin state before the old
   sidecar is archived.
2. **Claude CLI remains a first-class product path, but upstream now owns the
   persistent process.** The target `claude-cli` backend already has warm
   `claude-stdio` sessions, bounded reseed, concurrency control, process caps,
   context recovery, MCP, exec approvals, and launch fingerprints. Replaying
   the custom persistent process would regress correctness and security. The
   retained product differences are implemented as actual block delivery while
   generation is in progress, an explicit isolated tool policy, `/fast`
   forwarding, and CLI-aware durable-memory flush.
3. **Signal reply and sticker behavior is retained, while direct `signal-ts`
   transport remains blocked.** Quoted replies and installed-sticker actions
   now live on the reproducible official signal-cli native/container adapter.
   The custom direct transport depends on `@openclaw/signal-ts` through
   `file:../../../signal-ts`; that source is neither in Git nor present beside
   this checkout. A clean install, CI run, or published plugin cannot reproduce
   it. No direct-transport integration will be added until the dependency has a
   legal, versioned, installable source.
4. **The remaining work adopts upstream.** Session storage, transcript writes,
   hook/cron routing, interrupt fencing, process stdin handling, provider
   catalogs, media preservation, memory SQLite hardening, and most performance
   patches have been superseded. Unsafe host-file and unauthenticated-bind
   bypasses are deliberately removed.

## Final retain and drop ledger

Retained on current target seams:

- Claude CLI: OpenClaw MCP coding-tool surface, Anthropic-owned isolation,
  replacement-prompt skills, warm-process-safe policy fingerprints, live block
  delivery, final deduplication, `/fast`, and isolated pressure flush.
- Memory: bounded transcript access, durable summaries, direct-predecessor
  injection, literal/cursor recall, operator UI, config migration, legacy data
  import, and host-projected completed-session Markdown memory.
- Signal: account-scoped native quoted replies plus bounded inbound and outbound
  installed-sticker behavior on the official native/container adapters.

Deliberately not retained:

- the duplicate custom persistent Claude process and provider-private history
  compaction;
- direct `signal-ts` transport until it has a reproducible dependency;
- the reverted session-metadata SQLite design;
- arbitrary host-file attachment bypasses and exposed unauthenticated Gateway
  binds;
- obsolete model pins, a speculative Fable CLI alias, generated Canvas hashes,
  and diagnostic-only timing patches.

## Per-commit decision matrix

|   # | Commit       | Subject                                                        | Decision                  | Target disposition                                                                                                                                   |
| --: | ------------ | -------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | `34fc5285eb` | Docs: record v2026.4.14 port analysis and plan                 | DROP/REPLACE              | Superseded by this target-specific analysis and plan.                                                                                                |
|   2 | `16b3615f34` | Memory: harden sqlite writes and recovery                      | ADOPT UPSTREAM            | Current memory-core has WAL, transactional publication, recovery, yield, and reindex tests.                                                          |
|   3 | `cf94dada5e` | Runtime: harden hook and reply lifecycle behavior              | ADOPT UPSTREAM            | Current hook, cron, heartbeat, reply-run, and cleanup lifecycles supersede the old combined patch.                                                   |
|   4 | `cff4265778` | Agents: fix subagent timeout and revival semantics             | ADOPT UPSTREAM            | Current task/subagent deadlines and terminal-state handling cover the bug without reviving the old registry mechanism.                               |
|   5 | `357327b264` | Agents: add session continuity and summaries backend           | REDESIGN                  | Keep summaries and lineage in memory-core plugin state, driven by typed lifecycle hooks; import sanitized legacy SQLite summary rows through doctor. |
|   6 | `535a142909` | UI: add session summaries surface and token restore            | REDESIGN/PARTIAL          | Rebuild summary history in the current Control UI; do not restore obsolete token/state plumbing.                                                     |
|   7 | `6ea3f80775` | Media: support PDF aborts and inbound retries                  | DEFER/PARTIAL             | Current PDF stack replaced pdfjs and has timeouts. Only caller cancellation may remain; generic whole-batch retry is unsafe.                         |
|   8 | `b65ee3a141` | Channels: port Signal and WhatsApp custom reply flows          | REDESIGN/PARTIAL          | Adopt target WhatsApp behavior; rebuild Signal quoted replies and installed-sticker actions on the official signal-cli adapter seam.                 |
|   9 | `a3b8e3e977` | Skills: add custom porting workflow                            | DROP/REPLACE              | Hard-coded old tag/path and stale policy; use this generic decision record and current repo guidance.                                                |
|  10 | `2ad305dc79` | Sessions: fix summary generation for current SDK               | REDESIGN                  | Its bug disappears with the new plugin-runtime completion seam.                                                                                      |
|  11 | `f7103902b8` | Tests: format runReplyAgent block streaming mock               | DROP                      | Old-tree formatting-only change.                                                                                                                     |
|  12 | `ee38d5ec70` | Prompt: shorten assistant identity line                        | DROP                      | Low-value token tweak conflicts with current self-knowledge and prompt-cache semantics.                                                              |
|  13 | `47a18eaa66` | Scripts: handle native pnpm npm_execpath                       | ADOPT UPSTREAM            | Current package-manager scripts already handle native pnpm invocation.                                                                               |
|  14 | `4a5f3935b6` | Config: add CLI prompt invalidation toggle                     | ADOPT UPSTREAM            | Current live-session fingerprinting and bounded reseed handle prompt drift more safely.                                                              |
|  15 | `4e8e86bcd3` | CLI: preserve structured output handling                       | ADOPT UPSTREAM            | Current CLI event normalization preserves structured output and tool/commentary events.                                                              |
|  16 | `c7d8973be6` | Sessions: roll over after CLI continuity breaks                | DROP                      | Current backend clears/reseeds the provider binding; rolling the entire OpenClaw session is the wrong ownership boundary.                            |
|  17 | `0ed1f5d213` | Anthropic: add claude-cli catalog entries                      | ADOPT UPSTREAM            | Target Anthropic plugin owns canonical CLI catalog and live-session registration.                                                                    |
|  18 | `9d2d490027` | UI: localize session summaries                                 | REDESIGN                  | Add English source strings, then generate locale files with the current i18n workflow.                                                               |
|  19 | `a25518160f` | Tools: add session_summaries display metadata                  | REDESIGN                  | Register the rebuilt plugin-owned tool and manifest metadata together.                                                                               |
|  20 | `c53b60b534` | fix: preserve claude-cli prompts on resume                     | ADOPT UPSTREAM            | Current resume/reseed path preserves bounded system and conversation context.                                                                        |
|  21 | `3411c7fe9d` | feat: add configurable cli mcp tool surface                    | REDESIGN                  | Keep a generic capability/allowlist seam; do not restore the old static list.                                                                        |
|  22 | `7e1940f36f` | fix: isolate claude cli runtime context                        | REDESIGN                  | Preserve explicit isolation as Anthropic plugin policy after the MCP coding-tool conflict is resolved.                                               |
|  23 | `d955a77e6b` | fix: preserve session transcripts across delivery and rollover | ADOPT UPSTREAM            | Current scoped transcript accessor and delivery mirrors cover all channels.                                                                          |
|  24 | `9a337bf55d` | feat: add persistent claude cli streaming backend              | ADOPT UPSTREAM            | Target `claude-stdio` live sessions are bounded, fingerprinted, recoverable, and concurrency-safe.                                                   |
|  25 | `d73fec6ca2` | fix: pass claude context limit to autocompact                  | DROP                      | Claude owns native compaction in the target backend.                                                                                                 |
|  26 | `6b03b28d2b` | fix: use claude compact env for context limit                  | DROP                      | Old environment workaround conflicts with native compaction ownership.                                                                               |
|  27 | `dbc9a01675` | perf: trim warm reply path overhead                            | ADOPT UPSTREAM            | Current reply initialization and provider-owned session path have different hot boundaries.                                                          |
|  28 | `79f1c387de` | infra: centralize timing tracing                               | DEFER                     | Optional observability only; one hunk touches restricted auth-profile code and is not required for behavior.                                         |
|  29 | `ed825612ec` | perf: cache warm cli reply preparation                         | ADOPT UPSTREAM            | Current live-session preparation and fingerprints replace the old cache.                                                                             |
|  30 | `3ea5a86db4` | perf: trim reply session-store overhead                        | ADOPT UPSTREAM            | Current accessor, writer queue, revision checks, and clone reductions supersede it.                                                                  |
|  31 | `7a143a1fa1` | perf: start signal typing at ingress                           | ADOPT UPSTREAM            | Shared channel reply lifecycle now starts typing/status feedback consistently.                                                                       |
|  32 | `194d0c929c` | fix: preserve MCP image tool results                           | ADOPT UPSTREAM            | Target surfaces structured MCP content and images.                                                                                                   |
|  33 | `5893019283` | fix: use Claude system prompt files                            | ADOPT UPSTREAM            | Current Anthropic CLI launch/reseed path owns system-prompt transport.                                                                               |
|  34 | `0b049bf680` | fix: stream CLI text across tool turns                         | REDESIGN                  | Feed target assistant deltas into the current block pipeline; never retain cumulative snapshots.                                                     |
|  35 | `433acd6689` | fix: preserve CLI continuity across OAuth refresh              | ADOPT UPSTREAM/RESTRICTED | Target ignores token rotation and invalidates identity changes correctly; old auth paths are CODEOWNERS-restricted.                                  |
|  36 | `461ede3e5b` | trace: add signal attachment timing                            | DROP                      | Diagnostic experiment, not product behavior.                                                                                                         |
|  37 | `f2eca5c873` | fix(process): fail closed on stale child stdin                 | ADOPT UPSTREAM            | Current supervisor tracks ended/destroyed/writable stdin and stream errors.                                                                          |
|  38 | `19cb06aef1` | config: expose hook and fs policy toggles                      | DROP                      | Hook lifecycle changed; the filesystem toggle only enables the unsafe bypass below.                                                                  |
|  39 | `c22a171608` | feat(media): allow all host-readable attachment file types     | DROP/RESTRICTED           | Security regression in `src/security/**`; target intentionally validates supported local document types.                                             |
|  40 | `f259f881d5` | fix(agents): persist CLI isolated turn transcripts             | ADOPT UPSTREAM            | Current CLI turn recorder writes normalized user/assistant events through scoped accessors.                                                          |
|  41 | `9da34ff78f` | fix(hooks): persist and route synthetic hook handoffs          | ADOPT UPSTREAM            | Current hook mappings have explicit keys, idempotency, agent routing, and stable sessions.                                                           |
|  42 | `9ba96c3c9d` | chore(canvas): refresh a2ui bundle hash                        | DROP                      | Generated artifact from a removed/moved Canvas surface.                                                                                              |
|  43 | `420c5d7f9c` | fix(openai): port codex oauth gpt-5.5 support                  | ADOPT UPSTREAM            | Target contains newer GPT-5.6 and unified runtime/catalog support.                                                                                   |
|  44 | `4d51374627` | Sessions: stabilize synthetic turns and live model state       | ADOPT UPSTREAM            | Heartbeat model preservation and accessor-owned state replaced the old live-model map.                                                               |
|  45 | `8aa6a92177` | Memory: flush CLI sessions on prompt growth                    | REDESIGN                  | Keep CLI durable-memory capture, but run an isolated maintenance turn before provider compaction.                                                    |
|  46 | `ee56c943f9` | Memory Core: resolve rollover flush model from config          | REDESIGN                  | Keep rollover capture and consume the target `MemoryFlushPlan`; do not reimplement model resolution.                                                 |
|  47 | `c2f581ad34` | Anthropic: default Claude CLI to Opus 4.7                      | DROP                      | Target has newer model policy and must not pin an obsolete default.                                                                                  |
|  48 | `db5451ca33` | CLI: preserve Claude continuity across cold starts             | ADOPT UPSTREAM            | Target reseeds from bounded summary and transcript tail instead of an unbounded full transcript.                                                     |
|  49 | `3655e1b961` | Sessions: persist inbound user turns in transcripts            | ADOPT UPSTREAM            | Current unified user-turn recorder covers CLI, chat, and follow-ups.                                                                                 |
|  50 | `22be281258` | Reply: abort superseded runs and suppress duplicate deliveries | ADOPT UPSTREAM            | Current reply-run fencing and channel-specific supersede/abort logic are more complete.                                                              |
|  51 | `db67a4cf81` | Providers: add DeepSeek V4 and Xiaomi 2.5 catalogs             | ADOPT UPSTREAM            | Target manifest-first catalogs include newer entries and corrected context limits.                                                                   |
|  52 | `1b2dc107bf` | Gateway: allow explicit unauthenticated custom binds           | DROP                      | Security regression; exposed gateways must use trusted proxy, token, or password auth.                                                               |
|  53 | `4213974173` | Chore: bump packageManager to pnpm 10.33.2                     | DROP                      | Target pins pnpm 11.2.2.                                                                                                                             |
|  54 | `fc523374ca` | CLI: add provider-scoped preflight compaction overlays         | DROP                      | Conflicts with target native compaction ownership and CLI compaction lifecycle.                                                                      |
|  55 | `c142f70990` | Config: make untrusted hook ownership downgrade optional       | DROP                      | Upstream replaced and then removed this sender-owner gating model.                                                                                   |
|  56 | `651f1d55bf` | docs: clarify local build and commit workflow rules            | DROP                      | Target `AGENTS.md` is authoritative and materially newer.                                                                                            |
|  57 | `5daa743e4c` | Signal: allow on-connection receive mode                       | DEFER                     | Add only if deployed signal-cli config proves it is still required. It is unrelated to direct signal-ts transport.                                   |
|  58 | `72fb9ce0ab` | Cron: route main jobs through synthetic turns                  | ADOPT UPSTREAM            | Current source-aware child-session/heartbeat flow is deduped and lifecycle-safe.                                                                     |
|  59 | `3a9424bc82` | CLI: use Claude fast mode settings                             | REDESIGN/IMPLEMENTED      | Add an SDK execution-context field, resolve `auto`, map the effective value into isolated Claude settings, and fingerprint the final argv.           |
|  60 | `7cc3ae6e14` | fix(memory-core): handle synthetic dreaming cron events        | ADOPT UPSTREAM            | Target dreaming natively handles cron/heartbeat and prevents self-ingestion.                                                                         |
|  61 | `5d95649ef8` | CLI: track resume usage and clear empty sessions               | ADOPT UPSTREAM            | Current normalized usage and binding state replace the old counters.                                                                                 |
|  62 | `fc1a7829d3` | CLI: rotate hidden usage sessions                              | DROP                      | Hidden rotation is unnecessary with provider-owned native compaction.                                                                                |
|  63 | `3a40b86e38` | Hooks: suppress silent fallback events                         | ADOPT UPSTREAM            | Current announce/delivery policy suppresses successful no-delivery results without fallback duplication.                                             |
|  64 | `9b7db836d0` | Chore: apply oxfmt updates                                     | DROP                      | Old-tree mechanical formatting.                                                                                                                      |
|  65 | `c0e1d0bd0f` | Anthropic: add Claude Opus 4.8 support                         | ADOPT UPSTREAM            | Present in the target catalog/runtime.                                                                                                               |
|  66 | `21f7561c1c` | CLI: sanitize assistant-visible output                         | ADOPT UPSTREAM            | Current event normalization and output limits own this boundary.                                                                                     |
|  67 | `201946f99b` | CLI: stabilize Claude session continuity                       | ADOPT UPSTREAM/PARTIAL    | Keep only explicit isolation intent; target session continuity is superior.                                                                          |
|  68 | `ee01b755a4` | Reply: compact CLI sessions from Claude history                | DROP                      | Competes with Claude native compaction and reads provider-private history.                                                                           |
|  69 | `9a4388e45c` | Sessions: cache hot skill and store state                      | ADOPT UPSTREAM            | Target has current skill cache, session accessor cache, and invalidation semantics.                                                                  |
|  70 | `74f8305a14` | Reply: trace and defer stable persists                         | DROP                      | Deferred persistence weakens crash correctness and bypasses the current serialized writer.                                                           |
|  71 | `216204b9d3` | Signal: type outbound abort propagation                        | ADOPT UPSTREAM            | Current channel outbound contracts already carry `abortSignal`.                                                                                      |
|  72 | `c530be05d8` | Process: normalize child stdin closed state                    | ADOPT UPSTREAM            | Present in the current child-process supervisor.                                                                                                     |
|  73 | `341ed7af96` | Chore: fix TypeScript fixture drift                            | DROP                      | Old generated/test fixture maintenance.                                                                                                              |
|  74 | `f1a44b7941` | CLI: remove auth epoch session binding                         | ADOPT UPSTREAM/RESTRICTED | Target launch identity logic already has the desired end state; auth files are restricted.                                                           |
|  75 | `fc0cf1b54b` | Sessions: move store state to SQLite                           | DROP                      | Upstream explicitly reverted/deferred session-metadata SQLite; do not bypass that architecture decision.                                             |
|  76 | `47264aa30f` | Signal: add signal-ts backend integration                      | BLOCKED/REDESIGN          | Real product capability, but the external file dependency is absent and unreproducible.                                                              |
|  77 | `b787ea4831` | Signal: fix signal-ts disconnect diagnostics                   | BLOCKED/REDESIGN          | Fold into a future transport lifecycle implementation after the dependency is available.                                                             |
|  78 | `3c1d5a6972` | CLI: avoid duplicate current metadata bootstrap                | ADOPT UPSTREAM            | Current live-session bootstrap/reseed owns one bounded metadata path.                                                                                |
|  79 | `318a8c2ad9` | Signal: support signal-ts stickers                             | REDESIGN/PARTIAL          | Rebuild inbound sticker context and installed-sticker send on signal-cli; direct signal-ts transport remains blocked.                                |
|  80 | `4e4eb1d2fe` | Signal: finish signal-ts replies and reactions                 | REDESIGN/PARTIAL          | Rebuild quoted replies on the current threading contract and adopt upstream reactions; direct signal-ts transport remains blocked.                   |
|  81 | `d8891ff072` | Messages: support send buffer media                            | ADOPT UPSTREAM            | Target supports buffer delivery with byte caps, validation, dry-run, and plugin dispatch.                                                            |
|  82 | `1b3487a54b` | CLI: compact from Claude session history                       | DROP                      | Provider-private history compaction conflicts with target ownership.                                                                                 |
|  83 | `af50c0f6f3` | CLI: split streamed replies at assistant messages              | REDESIGN                  | Preserve semantic block boundaries using target event deltas and block delivery.                                                                     |
|  84 | `b978d35843` | build: refresh a2ui bundle hash                                | DROP                      | Obsolete generated artifact.                                                                                                                         |
|  85 | `b99ed73adf` | Signal: surface signal-ts channel errors                       | BLOCKED/REDESIGN          | Future adapter should expose typed probe/channel errors through current status APIs.                                                                 |
|  86 | `66c416f3e2` | CLI: use 1M Opus 4.6 for Claude CLI                            | DROP                      | Obsolete model workaround; current catalog/context policy supports newer models.                                                                     |
|  87 | `305b5124a3` | CLI: avoid final replay of streamed replies                    | REDESIGN                  | Use current `didStream`/`hasSentPayload` state for exact final deduplication.                                                                        |
|  88 | `4f8f2d427b` | CLI: bound Claude compaction prompts                           | DROP                      | The entire custom Claude-history compaction path is removed.                                                                                         |
|  89 | `9c072e9798` | Media: preserve small local images                             | ADOPT UPSTREAM            | Current media policy preserves safe originals by MIME, dimensions, model capability, and format.                                                     |
|  90 | `0b9350f9f7` | Signal: harden signal-ts delivery                              | BLOCKED/REDESIGN          | Future transport must use current outbound lifecycle and stable idempotency.                                                                         |
|  91 | `f555e3edd4` | Signal: retry transient signal-ts sends                        | BLOCKED/REDESIGN          | Retry only proven pre-send failures; ambiguous ACK failures can otherwise duplicate messages.                                                        |
|  92 | `186127c53b` | Memory: count Claude CLI usage for flush                       | REDESIGN                  | Consume fresh normalized usage in the current CLI compaction lifecycle; do not scan provider history in core.                                        |
|  93 | `830fe40388` | Signal: use signal-ts attachment fetch                         | BLOCKED/REDESIGN          | Future media adapter must use current bounded fetch/attachment contracts.                                                                            |
|  94 | `b56494912a` | Anthropic: support Claude Fable 5                              | ADOPT UPSTREAM            | Target already contains Fable 5 adaptive-thinking support; CLI alias needs live evidence before any change.                                          |
|  95 | `0f4877e7cf` | build: refresh a2ui bundle hash                                | DROP                      | Obsolete generated artifact.                                                                                                                         |

## Code-quality findings in retained areas

### Session summaries

The custom summary implementation has valuable product behavior but is not a
safe migration candidate:

- It stores `session_summaries` inside the memory-search SQLite database. The
  current memory manager publishes/rebuilds shadow indexes, so unrelated tables
  do not belong there and can be lost.
- Its primary key is only `session_id`; it does not scope records by agent.
- It uses `INSERT OR REPLACE` with no pending claim, transcript fingerprint,
  prompt/schema version, retry state, or crash recovery. Duplicate lifecycle
  events can repeat paid model work.
- It reads an entire transcript synchronously and limits characters rather than
  tokens. Large sessions are summarized in parts without a final synthesis.
- Tool results, delivery mirrors, metadata, side branches, secrets, and prompt
  injection are not handled robustly.
- Normal rollover launches a void promise that can disappear on restart, while
  a provider-error path waits on the external summarizer and delays the reply.
- Its gateway query is unbounded and its UI asks for 1,000 records before
  slicing locally.

The replacement therefore belongs in `extensions/memory-core`, backed by the
plugin state database, canonical scoped transcript APIs, durable state
transitions, bounded generation, literal search, and cursor pagination.

### Claude CLI

The custom persistent process should not survive the migration. Compared with
the target live-session implementation, it has:

- no global process cap and special main-session processes that do not expire;
- a same-key concurrent-start race that can leak a process;
- unbounded stdout, stderr, raw JSONL, and cumulative text snapshots;
- a launch signature missing model, auth identity, system prompt, MCP surface,
  working directory, skills, and fast-mode inputs;
- `isStreaming()` state that remains false during generation;
- cumulative reply snapshots with roughly quadratic memory growth;
- a static native-tool denylist that fails open when Claude gains new tools.

The target `extensions/anthropic/cli-backend.ts` and
`src/agents/cli-runner/claude-live-session.ts` already solve process ownership.
Custom work must be limited to missing policy and delivery behavior.

### Signal

The custom direct transport is a 1,756-line runtime plus an 810-line test file.
Protocol state, reconnect, inbound/outbound normalization, attachment handling,
receipts, retry, and diagnostic logging are mixed together. It also performs
synchronous writes to a hard-coded `/root/.codex/logs` path. A future port must
split transport, state, inbound, outbound, media, and retry responsibilities and
attach them to `extensions/signal/src/client-adapter.ts` without replacing the
target native/container transports.

## Restricted and deliberately removed changes

No migration commit may revive these changes without explicit review from the
listed CODEOWNERS:

- arbitrary host-readable attachment types from `c22a171608`;
- unauthenticated non-loopback Gateway binds from `1b2dc107bf`;
- the auth-profile/CLI-auth epoch hunks in `79f1c387de`, `433acd6689`, and
  `f1a44b7941`;
- untrusted-hook ownership bypasses from `c142f70990`.

Their removal is part of the migration result, not missing work.
