# Custom commit analysis for `v2026.7.1-beta.2`

This is the semantic audit of the 95 commits unique to
`origin/custom/20260415`. It records which product behaviors must survive on
`custom/20260705`, which old patches are superseded by the target release, and
which implementation details must not be replayed.

## Audited baseline

- Source branch: `origin/custom/20260415` at
  `0f4877e7cf92a1ed0a1d469dd27986d5186d990d`
- Source/target merge base: `v2026.4.14` at
  `323493fa1b6adc1e10b9954a68d5eaa5a6ef1170`
- Target release: peeled `v2026.7.1-beta.2` at
  `a580a7fe3fbd1b3329c978d58ca2f70e8ca37aee`
- Source-only commits reviewed: 95, in chronological order and again by
  end-state feature family
- Handoff branch: `custom/20260705`, created directly from the peeled target
  commit; no source commit was cherry-picked or rebased
- Final implementation snapshot before closeout documentation:
  `26015deda069f8820e6a84f4b9b358d401283522`
  (170 commits after the peeled target)
- Direct Signal dependency: the host environment must resolve the bare package
  identity `@openclaw/signal-ts`. OpenClaw records no package source,
  filesystem path, version, or revision for that host-provided runtime.

The audit is behavior-based. Patch inequality does not prove that an old fix is
still needed, while an upstream feature with the same name does not prove that
it satisfies the custom latency or product contract.

Decision labels:

- **IMPLEMENTED**: the product behavior is present on `custom/20260705`.
- **REDESIGN**: retain the intent but use target-owned seams rather than replaying
  the old patch.
- **ADOPT UPSTREAM**: the target already owns the behavior; do not carry the old
  implementation.
- **PARTIAL/IMPLEMENTED**: only the stated product behavior was retained; the
  unsafe or obsolete remainder was not replayed.
- **DROP**: obsolete, generated-only, unsafe by default, or contrary to the
  current ownership model.

For closeout purposes, **DROP** means obsolete, **ADOPT UPSTREAM** means
upstream-covered, and **REDESIGN/IMPLEMENTED** means the intent was absorbed
into a target-owned seam or reimplemented against the current architecture.

## Product conclusions

### Persistent Claude Code is a latency-critical backend

The custom contract is a long-lived background Claude Code child process using
streaming JSON over stdin/stdout. It is not the Anthropic SDK and it is not a
new `claude -p` process for every turn. The Claude executable still receives
its non-interactive flag as part of the stream-json protocol, but process
ownership spans turns.

The target release had a nominal `claude-stdio` live-session implementation,
but captured MCP turns closed that process in the attempt finalizer. Therefore
upstream had not solved the deployed warm-process requirement. The migrated
implementation keeps the process capture key target-owned, leases request
context only while a turn is admitted, rejects tool calls outside that lease,
and reuses the same process safely across turns.

Launch resources now have explicit ownership. A cold or restarted live child
may adopt its launch-only Claude skills/plugin files, backend preparation
cleanup, and MCP capture cleanup exactly once. Warm-turn temporary resources
remain owned by that turn. Failed launches and normal child shutdown both run
the same idempotent cleanup chain, so a turn cannot delete files still needed
by a live child and a closed child cannot leak them.

The warm preparation path is cached only behind validation:

- workspace ensure results use a bounded 60-second LRU, coalesce concurrent
  ensures, validate directory device/inode/mtime/ctime on every hit, and fall
  back to the full attestation-aware path after replacement or mutation;
- onboarding-pending workspaces are never cached, so profile edits and
  `BOOTSTRAP.md` completion remain immediately visible;
- the CLI system-prompt cache is a bounded 64-entry LRU keyed by the complete
  prompt inputs and resolved runtime facts, including config, tool schemas,
  context-file contents, skills, plugin guidance, ACP state, identity, session
  metadata, and the minute-granularity user-time bucket.

The backend also adds:

- canonical-main pinning, a six-hour idle limit for other sessions, a 24-hour
  maximum process age, a 16-process cap, and serialized same-key creation;
- launch fingerprints that include effective argv/environment/policy inputs and
  explicit closed restart reasons;
- content-free cold/warm and phase timing diagnostics, including stdin write,
  first stdout byte, first parsed record, first assistant delta, result, and
  completion timings;
- true assistant-delta block delivery, assistant-message boundaries, and exact
  final-replay suppression;
- OpenClaw MCP-only isolation, skill preservation, effective `/fast` settings,
  and provider-owned native compaction;
- effective context propagation to the backend, retained explicit Opus 4.6 1M
  selectors, locally restored Fable 5 routing, and a bounded
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` derived from the actual model context.

The Gateway MCP loopback preserves valid structured `text`, `image`, `audio`,
`resource_link`, and embedded `resource` blocks. Only unknown or malformed
blocks fall back to safe text serialization, so Claude Code does not lose image
or resource tool results at the loopback boundary.

Claude stream-json usage has two meanings and they are stored separately. The
result record remains aggregate turn usage for accounting, while the final
assistant record is `lastCallUsage`, the current context snapshot used by
transcript persistence, context engines, token-pressure decisions, and session
state. Aggregate usage is only the fallback when a last-call snapshot is absent.

#### Claude Sonnet 5 is a route-aware model contract

The canonical OpenClaw model identity is `anthropic/claude-sonnet-5`. Sonnet 5
has an exact 1,000,000-token context window. The direct Anthropic catalog allows
128,000 output tokens, while the Claude Code catalog advertises the 64,000-token
limit reported by the installed CLI.

Thinking behavior depends on the route. Direct Anthropic, Anthropic Vertex, and
Claude CLI default to adaptive thinking at `high` effort and honor explicit
`off` as disabled thinking. AWS Bedrock and Bedrock Mantle keep adaptive
thinking enabled: `off` and `minimal` converge to `low`, while `xhigh` and `max`
retain their native effort values. Both AWS routes are standard-tier-only for
Sonnet 5; priority and flex service tiers are not advertised.

Claude Code must be at least 2.1.197 for Sonnet 5. At the full 1M context,
OpenClaw leaves Claude Code's native approximately 967K auto-compaction margin
intact instead of overriding it with the raw 1,000,000-token ceiling.

### SQLite session state is an intentional latency architecture

The old SQLite work was not a disposable experiment. The default session store
is now `sessions.sqlite`. A configured `sessions.json`, `sessions.hot.json`, or
other non-database path is a compatibility location stem and resolves to its
sibling `.sqlite` database; this preserves the authority of databases created
by the previous custom branch. Explicit `.sqlite` and `.db` paths remain exact.
The low-level store API can still open an explicit JSON backend for focused
tests and offline APIs, but runtime config does not opt back into JSON.

The target design uses Kysely with `node:sqlite`, WAL,
`synchronous=NORMAL`, the shared busy timeout, exact `COLLATE BINARY` keys,
keyed point reads, and transactional hot updates. It imports the legacy JSON
store once and migrates the older custom normalized-key schema without
reintroducing case folding.

The runtime migration is complete. JSON import uses a digest-backed, crash-resumable
archive protocol; state repair and doctor transforms serialize with SQLite
writers; read-only inspection does not create schema or consume import state;
and the default-store consumers in doctor, diagnostics, extensions, QA, Codex,
QQBot, Feishu, memory-host SDK, Gateway, reply dispatch, heartbeat, cron,
subagent delivery, export commands, and macOS now use canonical store/session
accessors. Known-key paths remain row-scoped; cold compatibility misses may do
one bounded alias scan, while exact hot reads, patches, transcript updates, and
inbound metadata writes stay keyed.

Exact-tree validation closed several additional compatibility gaps. Legacy
session-store imports retain JSON5 comments and trailing commas. Migration path
planning uses the canonical runtime `resolveStorePath` contract. Microsoft
Teams doctor migration may scan a legacy directory-shaped sidecar location, but
keys and merges imported state under the canonical SQLite runtime store.
Heartbeat cleanup restores the pre-run `updatedAt` value unless a genuinely
newer value exists, while preserving other fields written concurrently.

Officially externalized provider plugins also retain endpoint classification
when their manifests are absent from the packaged dist. The bundled catalog is
the fallback, installed manifests remain authoritative, and endpoint classes
unknown to core remain inert. This is a target-compatible backport of the later
upstream `49302fcb7d` correction.

### Summary and memory behavior is a product fork

The custom product keeps three related but distinct durability paths:

1. completed-session summaries with lineage, retry/recovery, bounded and
   sanitized transcript input, literal search, scoped recall, operator RPC, and
   Control UI history;
2. completed-session Markdown memory projection through a durable outbox and
   exactly-once file markers;
3. repeated CLI pressure flushes before Claude native compaction, using an
   isolated maintenance run so the user's live Claude process and transcript
   are not contaminated.

The migrated summary records live in memory-core plugin state rather than in
the rebuildable memory-search index. Legacy summary rows are imported through
doctor. The `openclaw summary generate` command and operator-write Gateway RPC can
generate one historical transcript, backfill all missing transcripts, force a
regeneration, or dry-run the plan. Backfill maps archived transcript IDs through
the current usage-family lineage, deduplicates transcript variants, and waits
for the durable summary service rather than bypassing its claim/retry state.

Automatic continuity injection walks a typed predecessor index for up to 20
same-session-key ancestors. It injects completed summaries newest first under
both a 2,000-token and 8,000-character cap, keeps accepted summaries whole, and
stops before the first older summary that would overflow. Failed or pending
records do not hide older completed summaries. Only when no completed summary
is available may the direct predecessor contribute a bounded, sanitized tail,
and only while that predecessor is pending or processing; terminal failures do
not leak transcript tails into later prompts.

The summary prompt is versioned and explicitly preserves grounded emotional
tone and relationship dynamics such as trust, frustration, rapport, boundaries,
conflict, repair, and preferred interaction style. It requires cautious
observations rather than diagnosis or invented motives. The configured local
default is `anthropic/claude-sonnet-4-6`, but the plugin LLM trust boundary wins:
the fixed model is forwarded only when
`plugins.entries.memory-core.llm.allowModelOverride=true`; otherwise generation
uses the target agent's trusted model. Legacy config migration enables the
needed override policies when they were not explicitly set and preserves an
explicit `false` with a doctor warning.

CLI pressure accounting uses the freshest persisted last-call prompt snapshot
paired with its matching output-token count. Cache-read and cache-write
contributions are normalized before persistence, and transcript-derived usage
can replace a stale snapshot. This is required for both 200K and 1M contexts.

### Claude native-history rollover is restored as a bounded continuity seam

The normal Claude backend remains the persistent stream-json child. A one-shot
Claude process is used only for rare maintenance after native context pressure
crosses the smaller of the configured reserve threshold and 80 percent of the
effective context window.

Core reads at most the newest 1 MiB of native history to find the latest usage
snapshot. Only after the threshold is crossed does it load visible native
messages for summarization. Hidden reasoning is removed, images are represented
as omissions, tool arguments/results and individual messages are independently
capped and redacted, and the rendered history is capped at 500,000 characters.
The isolated maintenance run has tools disabled, uses a temporary OpenClaw
transcript, and closes its own live-session resources when it ends.

The result must use exactly six Markdown sections: Decisions, Open TODOs,
Constraints/Rules, Pending user asks, Exact identifiers, and Useful recent
context. The sanitized summary is persisted as a provider-scoped continuity
overlay anchored to both the OpenClaw session and, when present, the retired
native Claude session. Persistence clears that provider binding, fences against
a concurrent local-session reset, and fails soft if usage reading, generation,
or persistence fails. On the next cold Claude child, the overlay replaces a
stale local compaction summary ahead of the recent transcript tail. `/new`,
`/reset`, daily/idle rollover, and a later canonical OpenClaw compaction clear
the overlay so it cannot cross lifecycle boundaries.

### Direct `signal-ts` is retained

The direct transport imports only the bare package identity
`@openclaw/signal-ts`; it is not blocked or replaced by signal-cli. The host
environment owns package resolution. OpenClaw does not encode a checkout path,
package version, source URL, or revision. The Signal plugin selects `signal-ts`
explicitly or when a durable signal-ts state path is configured; existing
signal-cli installations remain compatible.

The port separates client/state ownership, envelope conversion, inbound
handling, outbound handling, and a lazy runtime facade. It supports probes,
persistent receive, replies, reactions, typing, receipts, retry receipts,
stickers, attachment upload/download through Signal's trusted fetch path,
bounded retries for classified connection failures, and typed channel errors.
Retry attempts reuse one logical message timestamp, fatal monitor values are
normalized through the typed error path, and logs report metadata and sizes
rather than message content.

Direct-message typing starts immediately after an inbound message is accepted,
before attachment work, debouncing, or session-store access, and is deduplicated
against the normal reply-start typing signal. Acceptance also installs a
per-session abort controller: a newer inbound turn aborts the older turn before
it can enqueue or deliver a stale reply, queued dispatcher deliveries are
cancelled, and tokenized ownership prevents the old turn's cleanup from deleting
the replacement controller. The same abort signal reaches formatted chunks,
media, and signal-ts sends. Caller cancellation is always combined with the
transport timeout, so cancellation cannot accidentally remove the hard send
deadline.

The deployment contract is deliberately narrower than a package-manager
contract: when the direct backend is selected, the host must make
`@openclaw/signal-ts` importable. A missing package fails with a targeted
diagnostic instead of silently falling back to signal-cli.

### The old WhatsApp sticker sentinel is deliberately dropped

The source branch treated a captionless small WebP, including a literal `.`
caption, as an implicit WhatsApp sticker. That encoding was a version-specific
workaround and is not replayed. The target has explicit sticker/message-action
surfaces; ordinary WebP media remains ordinary media unless the caller selects
an explicit sticker operation. This avoids turning legitimate captionless WebP
images into stickers based on a magic caption.

### Two dangerous capabilities remain explicit local opt-ins

- `tools.fs.allowAllHostSendFileTypes` may bypass only the host-read file-type
  assertion. Capability checks, allowed roots, safe-open/symlink checks, and
  size limits still run. Global and per-agent use is included in dangerous
  configuration reporting.
- A non-loopback Gateway may run without auth only when the operator explicitly
  chooses both `gateway.bind=custom` and `gateway.auth.mode=none`. LAN, auto,
  and tailnet-like discovery modes do not inherit the exception; token/password
  modes still require their secret. Security audit continues to report this
  configuration as critical.

These are local product choices, not defaults and not permission to weaken
adjacent checks.

### Narrow old fixes are not replayed wholesale

The PDF commit contained one still-useful behavior: propagate `AbortSignal`
through native-provider, document-extractor, fetch, and PDF parsing layers.
That behavior is reimplemented in `88fc0c7b25`. The old generic inbound batch
retry is dropped because a whole-batch replay can duplicate side effects; the
target already has provider timeouts, SSRF checks, bounded error reads, and
remote idle timeouts.

The old unbounded Claude-history compaction implementation is not replayed
wholesale; its continuity intent is retained through the threshold-gated,
redacted, provider-scoped rollover described above. Hidden usage-session
rotation, deferred stable persistence, obsolete model defaults, stale
configuration toggles, old hook ownership bypasses, and generated Canvas hash
churn are not retained.

## Per-commit decision matrix

|   # | Commit       | Subject                                                        | Decision                                | Target disposition                                                                                                                                                                                                          |
| --: | ------------ | -------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | `34fc5285eb` | Docs: record v2026.4.14 port analysis and plan                 | DROP/REPLACE                            | Superseded by this target-specific audit and plan.                                                                                                                                                                          |
|   2 | `16b3615f34` | Memory: harden sqlite writes and recovery                      | ADOPT UPSTREAM                          | Target memory indexing owns WAL, publication, recovery, and reindex behavior; do not mix session-store tables into that index.                                                                                              |
|   3 | `cf94dada5e` | Runtime: harden hook and reply lifecycle behavior              | ADOPT UPSTREAM                          | Current hook, cron, reply-run, and cleanup lifecycles supersede the combined old patch.                                                                                                                                     |
|   4 | `cff4265778` | Agents: fix subagent timeout and revival semantics             | ADOPT UPSTREAM                          | Current task deadlines and terminal-state handling cover the old defects.                                                                                                                                                   |
|   5 | `357327b264` | Agents: add session continuity and summaries backend           | REDESIGN/IMPLEMENTED                    | Summaries now use memory-core plugin state, typed lifecycle hooks, durable recovery, and scoped lineage.                                                                                                                    |
|   6 | `535a142909` | UI: add session summaries surface and token restore            | REDESIGN/PARTIAL IMPLEMENTED            | Current Control UI summary history is retained; obsolete token/state restoration is not.                                                                                                                                    |
|   7 | `6ea3f80775` | Media: support PDF aborts and inbound retries                  | PARTIAL/IMPLEMENTED                     | Caller cancellation was reimplemented in `88fc0c7b25`; unsafe whole-batch retry is obsolete and was dropped.                                                                                                                |
|   8 | `b65ee3a141` | Channels: port Signal and WhatsApp custom reply flows          | REDESIGN/PARTIAL IMPLEMENTED            | Signal reply/sticker behavior is retained across signal-cli and signal-ts; the WhatsApp `.`/captionless-WebP sticker sentinel is deliberately dropped in favor of explicit sticker APIs.                                    |
|   9 | `a3b8e3e977` | Skills: add custom porting workflow                            | DROP/REPLACE                            | Hard-coded old release guidance is replaced by this audited decision record and current repository rules.                                                                                                                   |
|  10 | `2ad305dc79` | Sessions: fix summary generation for current SDK               | REDESIGN/IMPLEMENTED                    | The rebuilt memory-core lifecycle and isolated completion seam remove the old SDK mismatch.                                                                                                                                 |
|  11 | `f7103902b8` | Tests: format runReplyAgent block streaming mock               | DROP                                    | Old-tree formatting only.                                                                                                                                                                                                   |
|  12 | `ee38d5ec70` | Prompt: shorten assistant identity line                        | DROP                                    | Low-value prompt tweak conflicts with current prompt identity/cache ownership.                                                                                                                                              |
|  13 | `47a18eaa66` | Scripts: handle native pnpm npm_execpath                       | ADOPT UPSTREAM                          | Current package-manager scripts handle native pnpm invocation.                                                                                                                                                              |
|  14 | `4a5f3935b6` | Config: add CLI prompt invalidation toggle                     | ADOPT UPSTREAM                          | Launch fingerprints and bounded reseed own prompt drift without a legacy toggle.                                                                                                                                            |
|  15 | `4e8e86bcd3` | CLI: preserve structured output handling                       | ADOPT UPSTREAM + IMPLEMENTED BOUNDARIES | Target event normalization is retained; current custom work adds semantic assistant boundaries without reviving the old parser.                                                                                             |
|  16 | `c7d8973be6` | Sessions: roll over after CLI continuity breaks                | DROP                                    | A tainted Claude child is restarted; the whole OpenClaw session is not rolled over for provider-owned continuity.                                                                                                           |
|  17 | `0ed1f5d213` | Anthropic: add claude-cli catalog entries                      | ADOPT UPSTREAM                          | Target Anthropic plugin owns the CLI catalog and registration.                                                                                                                                                              |
|  18 | `9d2d490027` | UI: localize session summaries                                 | REDESIGN/IMPLEMENTED                    | Strings are maintained from the current English source and generated locale workflow.                                                                                                                                       |
|  19 | `a25518160f` | Tools: add session_summaries display metadata                  | REDESIGN/IMPLEMENTED                    | The memory-core tool, policy group, and display/manifest surface are registered together.                                                                                                                                   |
|  20 | `c53b60b534` | fix: preserve claude-cli prompts on resume                     | ADOPT UPSTREAM                          | Current live launch/reseed path owns bounded system and conversation context.                                                                                                                                               |
|  21 | `3411c7fe9d` | feat: add configurable cli mcp tool surface                    | REDESIGN/IMPLEMENTED                    | A generic backend capability selects the host-admitted OpenClaw MCP surface.                                                                                                                                                |
|  22 | `7e1940f36f` | fix: isolate claude cli runtime context                        | REDESIGN/IMPLEMENTED                    | Anthropic policy disables ambient hooks/settings/tools and allows only the intended OpenClaw surface.                                                                                                                       |
|  23 | `d955a77e6b` | fix: preserve session transcripts across delivery and rollover | ADOPT UPSTREAM + REDESIGN               | Current transcript ownership is retained; a bounded sanitized Plugin SDK reader serves summaries and memory.                                                                                                                |
|  24 | `9a337bf55d` | feat: add persistent claude cli streaming backend              | REDESIGN/IMPLEMENTED                    | Target `claude-stdio` was only nominally persistent under MCP capture; capture leasing keeps the stream-json child warm and launch-only resources transfer to that child until close.                                       |
|  25 | `d73fec6ca2` | fix: pass claude context limit to autocompact                  | REDESIGN/IMPLEMENTED                    | Effective context tokens are passed through the generic CLI preparation hook.                                                                                                                                               |
|  26 | `6b03b28d2b` | fix: use claude compact env for context limit                  | REDESIGN/IMPLEMENTED                    | Anthropic maps that limit to bounded `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; native compaction remains provider-owned.                                                                                                           |
|  27 | `dbc9a01675` | perf: trim warm reply path overhead                            | REDESIGN/IMPLEMENTED                    | Warm workspace preparation uses a bounded TTL/LRU with inflight coalescing and directory-identity validation; onboarding-pending or changed workspaces fall back to the full attestation path.                              |
|  28 | `79f1c387de` | infra: centralize timing tracing                               | REDESIGN/IMPLEMENTED                    | Keep content-free Claude turn phase diagnostics; drop broad auth/global trace plumbing not needed for the product question.                                                                                                 |
|  29 | `ed825612ec` | perf: cache warm cli reply preparation                         | REDESIGN/IMPLEMENTED                    | A bounded warm system-prompt cache hashes the complete source inputs and resolved runtime facts, including tool schemas, context contents, skills, plugin guidance, ACP state, identity, session metadata, and time bucket. |
|  30 | `3ea5a86db4` | perf: trim reply session-store overhead                        | REDESIGN/IMPLEMENTED                    | Default SQLite and canonical row-scoped accessors replace the old whole-store JSON optimization across hot consumers.                                                                                                       |
|  31 | `7a143a1fa1` | perf: start signal typing at ingress                           | REDESIGN/IMPLEMENTED                    | Signal DMs start deduplicated typing at accepted ingress, before attachment/session-store work; groups retain reply-start typing.                                                                                           |
|  32 | `194d0c929c` | fix: preserve MCP image tool results                           | REDESIGN/IMPLEMENTED                    | Gateway MCP loopback now preserves valid text, image, audio, resource-link, and embedded-resource blocks and stringifies only unknown content.                                                                              |
|  33 | `5893019283` | fix: use Claude system prompt files                            | ADOPT UPSTREAM                          | Current Anthropic launch/reseed path owns prompt transport and fingerprinting.                                                                                                                                              |
|  34 | `0b049bf680` | fix: stream CLI text across tool turns                         | REDESIGN/IMPLEMENTED                    | Parsed deltas flow through block delivery across text/tool/commentary transitions.                                                                                                                                          |
|  35 | `433acd6689` | fix: preserve CLI continuity across OAuth refresh              | ADOPT UPSTREAM                          | Stable profile identity and launch fingerprints avoid binding warm state to token rotation.                                                                                                                                 |
|  36 | `461ede3e5b` | trace: add signal attachment timing                            | DROP                                    | One-off diagnostic experiment; direct transport now has bounded metadata-only diagnostics.                                                                                                                                  |
|  37 | `f2eca5c873` | fix(process): fail closed on stale child stdin                 | ADOPT UPSTREAM                          | Current supervisor validates ended/destroyed/writable stdin and stream errors.                                                                                                                                              |
|  38 | `19cb06aef1` | config: expose hook and fs policy toggles                      | SPLIT                                   | Retain only `allowAllHostSendFileTypes` as an explicit global/per-agent opt-in; drop the stale hook toggle.                                                                                                                 |
|  39 | `c22a171608` | feat(media): allow all host-readable attachment file types     | REDESIGN/IMPLEMENTED                    | Bypass only the type assertion after host capability, root, safe-open, symlink, and size checks; audit as dangerous.                                                                                                        |
|  40 | `f259f881d5` | fix(agents): persist CLI isolated turn transcripts             | ADOPT UPSTREAM                          | Current CLI recorder and scoped transcript accessors own normalized turn persistence.                                                                                                                                       |
|  41 | `9da34ff78f` | fix(hooks): persist and route synthetic hook handoffs          | ADOPT UPSTREAM                          | Current mappings and synthetic-turn routing are keyed and lifecycle-safe.                                                                                                                                                   |
|  42 | `9ba96c3c9d` | chore(canvas): refresh a2ui bundle hash                        | DROP                                    | Generated old-tree artifact.                                                                                                                                                                                                |
|  43 | `420c5d7f9c` | fix(openai): port codex oauth gpt-5.5 support                  | ADOPT UPSTREAM                          | Target has newer unified OpenAI runtime/catalog behavior.                                                                                                                                                                   |
|  44 | `4d51374627` | Sessions: stabilize synthetic turns and live model state       | ADOPT UPSTREAM                          | Current accessor-owned state and source-aware synthetic turns supersede the old live-model map.                                                                                                                             |
|  45 | `8aa6a92177` | Memory: flush CLI sessions on prompt growth                    | REDESIGN/IMPLEMENTED                    | Repeated pressure flushes run in an isolated maintenance execution before native compaction.                                                                                                                                |
|  46 | `ee56c943f9` | Memory Core: resolve rollover flush model from config          | REDESIGN/IMPLEMENTED                    | Completed-session projection consumes the current `MemoryFlushPlan`.                                                                                                                                                        |
|  47 | `c2f581ad34` | Anthropic: default Claude CLI to Opus 4.7                      | DROP                                    | Obsolete model default; keep current catalog selection.                                                                                                                                                                     |
|  48 | `db5451ca33` | CLI: preserve Claude continuity across cold starts             | ADOPT UPSTREAM                          | Bounded reseed and target-owned warm sessions replace unbounded transcript replay.                                                                                                                                          |
|  49 | `3655e1b961` | Sessions: persist inbound user turns in transcripts            | ADOPT UPSTREAM                          | Unified turn recording covers CLI, chat, and follow-ups.                                                                                                                                                                    |
|  50 | `22be281258` | Reply: abort superseded runs and suppress duplicate deliveries | REDESIGN/IMPLEMENTED                    | Generic reply dispatch accepts abort signals and cancels unsent queued deliveries; Signal installs the supersession controller at accepted ingress and propagates it through direct sends.                                  |
|  51 | `db67a4cf81` | Providers: add DeepSeek V4 and Xiaomi 2.5 catalogs             | ADOPT UPSTREAM                          | Target manifest-first catalogs contain newer provider data.                                                                                                                                                                 |
|  52 | `1b2dc107bf` | Gateway: allow explicit unauthenticated custom binds           | REDESIGN/IMPLEMENTED                    | Permit only explicit custom bind plus explicit auth `none`; keep other non-loopback no-auth binds blocked and audit severity critical.                                                                                      |
|  53 | `4213974173` | Chore: bump packageManager to pnpm 10.33.2                     | DROP                                    | Target package-manager pin wins.                                                                                                                                                                                            |
|  54 | `fc523374ca` | CLI: add provider-scoped preflight compaction overlays         | REDESIGN/IMPLEMENTED                    | Threshold-gated Claude history is summarized once in an isolated no-tool run, persisted as a provider/local-session-scoped overlay, and injected only when reseeding a fresh child.                                         |
|  55 | `c142f70990` | Config: make untrusted hook ownership downgrade optional       | DROP                                    | The old sender-owner gating model no longer exists and is not part of the local product fork.                                                                                                                               |
|  56 | `651f1d55bf` | docs: clarify local build and commit workflow rules            | DROP                                    | Current root repository guidance is authoritative.                                                                                                                                                                          |
|  57 | `5daa743e4c` | Signal: allow on-connection receive mode                       | DROP FOR DIRECT PATH                    | signal-ts owns a persistent receive connection; existing signal-cli modes remain unchanged.                                                                                                                                 |
|  58 | `72fb9ce0ab` | Cron: route main jobs through synthetic turns                  | ADOPT UPSTREAM                          | Current cron/heartbeat source routing is deduplicated and lifecycle-safe.                                                                                                                                                   |
|  59 | `3a9424bc82` | CLI: use Claude fast mode settings                             | REDESIGN/IMPLEMENTED                    | Resolve effective fast mode after queue admission, forward it through backend execution, and fingerprint final settings.                                                                                                    |
|  60 | `7cc3ae6e14` | fix(memory-core): handle synthetic dreaming cron events        | ADOPT UPSTREAM                          | Target dreaming handles cron/heartbeat and prevents self-ingestion.                                                                                                                                                         |
|  61 | `5d95649ef8` | CLI: track resume usage and clear empty sessions               | REDESIGN/IMPLEMENTED                    | Result-level aggregate usage is retained for accounting, while the latest assistant-call snapshot drives context pressure, transcripts, and session state; ephemeral helpers close their live sessions.                     |
|  62 | `fc1a7829d3` | CLI: rotate hidden usage sessions                              | DROP                                    | Hidden rotation is unnecessary with provider-owned native compaction and stable usage receipts.                                                                                                                             |
|  63 | `3a40b86e38` | Hooks: suppress silent fallback events                         | ADOPT UPSTREAM                          | Current announce/delivery policy suppresses successful no-delivery results.                                                                                                                                                 |
|  64 | `9b7db836d0` | Chore: apply oxfmt updates                                     | DROP                                    | Old-tree mechanical formatting.                                                                                                                                                                                             |
|  65 | `c0e1d0bd0f` | Anthropic: add Claude Opus 4.8 support                         | ADOPT UPSTREAM                          | Present in target catalog/runtime.                                                                                                                                                                                          |
|  66 | `21f7561c1c` | CLI: sanitize assistant-visible output                         | ADOPT UPSTREAM                          | Current event normalization and assistant-visible output limits own this boundary.                                                                                                                                          |
|  67 | `201946f99b` | CLI: stabilize Claude session continuity                       | REDESIGN/IMPLEMENTED                    | Target-owned warm-process reuse, fingerprints, process caps, and restart reasons preserve the intended continuity.                                                                                                          |
|  68 | `ee01b755a4` | Reply: compact CLI sessions from Claude history                | REDESIGN/IMPLEMENTED                    | Core reads a bounded native usage tail and, only at the rollover threshold, sanitizes/caps visible Claude history for one isolated six-section continuity summary; normal turns remain persistent.                          |
|  69 | `9a4388e45c` | Sessions: cache hot skill and store state                      | REDESIGN/IMPLEMENTED                    | Current skill caches remain; SQLite keyed reads/hot writes replace whole-store JSON optimization.                                                                                                                           |
|  70 | `74f8305a14` | Reply: trace and defer stable persists                         | DROP                                    | Deferred persistence weakens crash correctness; content-free latency tracing is retained separately.                                                                                                                        |
|  71 | `216204b9d3` | Signal: type outbound abort propagation                        | REDESIGN/IMPLEMENTED                    | The reply dispatcher and Signal send surfaces carry typed abort signals through chunks, media, and signal-ts; transport timeouts are combined with caller cancellation.                                                     |
|  72 | `c530be05d8` | Process: normalize child stdin closed state                    | ADOPT UPSTREAM                          | Present in the current child-process supervisor.                                                                                                                                                                            |
|  73 | `341ed7af96` | Chore: fix TypeScript fixture drift                            | DROP                                    | Old generated/test fixture maintenance.                                                                                                                                                                                     |
|  74 | `f1a44b7941` | CLI: remove auth epoch session binding                         | ADOPT UPSTREAM                          | Current launch identity has the desired token-rotation behavior.                                                                                                                                                            |
|  75 | `fc0cf1b54b` | Sessions: move store state to SQLite                           | REDESIGN/IMPLEMENTED                    | SQLite is the runtime latency store; configured JSON-like paths map to sibling SQLite, while explicit low-level JSON remains only for tests/offline APIs. Import, repair, and hot consumers are SQLite-safe.                |
|  76 | `47264aa30f` | Signal: add signal-ts backend integration                      | REDESIGN/IMPLEMENTED                    | Direct backend uses the host-provided bare `@openclaw/signal-ts` package identity and current plugin seams; OpenClaw does not own its install source or revision.                                                           |
|  77 | `b787ea4831` | Signal: fix signal-ts disconnect diagnostics                   | REDESIGN/IMPLEMENTED                    | Typed, metadata-only probe and disconnect errors flow through current status APIs.                                                                                                                                          |
|  78 | `3c1d5a6972` | CLI: avoid duplicate current metadata bootstrap                | ADOPT UPSTREAM                          | Current bounded bootstrap/reseed owns one metadata path.                                                                                                                                                                    |
|  79 | `318a8c2ad9` | Signal: support signal-ts stickers                             | REDESIGN/IMPLEMENTED                    | Direct inbound and outbound installed stickers are supported with bounded attachment handling.                                                                                                                              |
|  80 | `4e4eb1d2fe` | Signal: finish signal-ts replies and reactions                 | REDESIGN/IMPLEMENTED                    | Direct quotes/reactions use current threading contracts and stored recipient/group state.                                                                                                                                   |
|  81 | `d8891ff072` | Messages: support send buffer media                            | ADOPT UPSTREAM                          | Target buffer delivery has caps, validation, dry-run, and plugin dispatch.                                                                                                                                                  |
|  82 | `1b3487a54b` | CLI: compact from Claude session history                       | REDESIGN/IMPLEMENTED                    | The history intent is restored with threshold gating, hidden-reasoning/image omission, secret redaction, bounded visible content, race fencing, and provider-scoped cold reseed.                                            |
|  83 | `af50c0f6f3` | CLI: split streamed replies at assistant messages              | REDESIGN/IMPLEMENTED                    | Stream parser emits explicit assistant boundaries consumed by block delivery.                                                                                                                                               |
|  84 | `b978d35843` | build: refresh a2ui bundle hash                                | DROP                                    | Obsolete generated artifact.                                                                                                                                                                                                |
|  85 | `b99ed73adf` | Signal: surface signal-ts channel errors                       | REDESIGN/IMPLEMENTED                    | Probe/send/monitor errors are surfaced without message-content logging.                                                                                                                                                     |
|  86 | `66c416f3e2` | CLI: use 1M Opus 4.6 for Claude CLI                            | REDESIGN/IMPLEMENTED                    | Bare Opus 4.6 aliases select `[1m]`, catalog context is 1,048,576, and native compact window is capped at 1,000,000.                                                                                                        |
|  87 | `305b5124a3` | CLI: avoid final replay of streamed replies                    | REDESIGN/IMPLEMENTED                    | Current streamed-send evidence suppresses exactly one final replay.                                                                                                                                                         |
|  88 | `4f8f2d427b` | CLI: bound Claude compaction prompts                           | REDESIGN/IMPLEMENTED                    | Continuity input caps text/tool/result/message blocks and the rendered history, requires an exact six-section output, disables tools, and sanitizes the generated summary before persistence.                               |
|  89 | `9c072e9798` | Media: preserve small local images                             | ADOPT UPSTREAM                          | Target media policy preserves safe originals using MIME, dimensions, format, and model capability.                                                                                                                          |
|  90 | `0b9350f9f7` | Signal: harden signal-ts delivery                              | REDESIGN/IMPLEMENTED                    | Direct transport uses current abort, delivery, state, and group/recipient contracts.                                                                                                                                        |
|  91 | `f555e3edd4` | Signal: retry transient signal-ts sends                        | REDESIGN/IMPLEMENTED                    | Retry is bounded and restricted to classified connection failures.                                                                                                                                                          |
|  92 | `186127c53b` | Memory: count Claude CLI usage for flush                       | REDESIGN/IMPLEMENTED                    | Last-call context usage is separated from aggregate accounting; core reads only the newest bounded native usage tail for rollover gating and otherwise uses fresh persisted/transcript snapshots.                           |
|  93 | `830fe40388` | Signal: use signal-ts attachment fetch                         | REDESIGN/IMPLEMENTED                    | Direct upload/download uses the signal-ts trusted fetch and current size/path contracts.                                                                                                                                    |
|  94 | `b56494912a` | Anthropic: support Claude Fable 5                              | REDESIGN/IMPLEMENTED                    | Fable 5 is restored locally in the Claude CLI catalog, aliases, migration/default wiring, 1M context routing, media limits, and adaptive-thinking profile; it was not present upstream.                                     |
|  95 | `0f4877e7cf` | build: refresh a2ui bundle hash                                | DROP                                    | Obsolete generated artifact.                                                                                                                                                                                                |

## Code-quality assessment

### Claude CLI

The old custom implementation proved the latency requirement but mixed process
ownership, provider policy, MCP capture, transcript history, and reply delivery.
The migrated design keeps the target process supervisor and generic CLI backend
contract, while the Anthropic plugin owns vendor args/environment. Launch
resources have one explicit owner, warm preparation caches validate all inputs
that affect correctness, and aggregate accounting is not confused with the
last-call context snapshot. The native-history rollover is isolated, bounded,
redacted, race-fenced, and lifecycle-scoped rather than interleaved with normal
turn execution. Unit coverage proves that repeat turns reuse the same warm
persistent child, including captured resume turns. An authenticated local
Gateway run also completed an initial Sonnet 5 turn and a resumed follow-up.
That is functional persistence evidence; a dedicated cold/warm
time-to-first-delta benchmark remains separate performance work.

### Session storage and memory

SQLite is appropriate for the hot keyed workload, and the repository-wide
consumer migration is complete. Read-only tools do not mutate schema or import
state, migrations serialize with writers, staged JSON archival survives
restart, and a source that changes after import is quarantined rather than
discarded. Configured JSON-looking paths resolve to the same sibling SQLite
authority used by the old custom branch. Session identity and token-pressure
consumers use canonical keyed access so the DB architecture improves latency
without case-folding opaque keys or splitting authority across legacy files.

Summary and memory durability are substantially stronger than the old branch:
records are agent-scoped, versioned and fingerprinted; jobs are claimable and
retryable; transcript input is bounded and treated as untrusted; projections
use a fenced outbox; historical backfill uses the same service; and predecessor
lineage is independently indexed and bounded. Model selection remains subject
to the plugin LLM trust contract, and the prompt preserves grounded emotional
continuity without turning inference into fact. The cost is a large state-machine
surface, so lifecycle, restart, duplicate-event, backfill, lineage, and policy
tests are part of the feature contract.

The final fixture migration follows the same ownership model as production.
Configured JSON-looking test paths are resolved to their canonical SQLite
backend. Ordinary Gateway RPC helpers invalidate only read-side caches; they do
not close database handles or clear an active writer queue. Full store teardown
belongs only to fixture boundaries, after asynchronous chat dispatch has
reached its terminal or post-dispatch barrier and before the temporary
directory is removed. A deterministic regression test holds one SQLite writer,
queues a second, performs an unrelated RPC, and proves both writes still
complete in order.

The fixture closeout commits converted Gateway, scheduled, channel, agent, ACP,
reply, command, plugin-host, and state-migration fixtures to the resolved
backend. They also preserve malformed checkpoint sources, seeded heartbeat
timestamps, orphan-key migration assertions, and isolate onboarding Git trust
state. These are verification repairs rather than additional product forks.

### Signal

The former monolithic direct runtime has been split into client, envelope,
inbound, outbound, and facade modules. The split makes protocol state and retry
decisions reviewable and keeps lazy loading intact. Stable retry timestamps and
fatal-error normalization close the monitor/delivery correctness gaps. Early
typing and accepted-ingress supersession are explicitly ordered before slow
attachment and session work, while the combined abort/deadline contract bounds
outbound cancellation. The runtime seam imports only
`@openclaw/signal-ts` and leaves resolution to the host without recording a
path, version, or revision in OpenClaw. A clean external package checkout passed
its own check and build; positive host-injection coverage proved the bare import
resolves when supplied, and negative coverage proved the missing-package error
is explicit. A linked-account channel-status and reaction round-trip remains
useful but is not a migration blocker.

### Explicit opt-ins

The host-file and unauthenticated-custom-bind features are narrow and visibly
dangerous. Their quality bar is negative coverage: nearby configurations must
remain blocked, and audit output must continue to identify enabled risk. They
must not become implicit defaults during later upstream merges.

## Snapshot caveats

This audit describes committed implementation behavior through
`26015deda069f8820e6a84f4b9b358d401283522` (170 commits after the peeled
target). The documentation-only commit containing this closeout update is
intentionally outside that implementation count.

`c41165e857` (`chore(lint): satisfy custom migration lint gates`) is a
historical scope caveat. It aggregated lint-driven edits across nine migration
files and is broader than the branch's preferred feature-scoped commit style.
The metadata rewrite preserved its tree and commit boundary instead of
redistributing those edits; future work should not use that commit as a
grouping model.

The audit has no remaining product-design or broad-gate blocker. Runtime code
snapshot `8d0f378333c0d50125968a97b8b313d0caee38bd` passed all 89 Vitest shards in
a clean-room `/var/tmp` environment. The later commits refresh the generated
Plugin SDK API hash, make pending Claude child creation atomically visible, and
remove two lint-only placeholder/assertion patterns. That pre-follow-up tree
passed a four-shard, 247-test closeout batch. The subsequent Sonnet 5 and
host-provided Signal commits passed their targeted provider, replay, packaging,
channel, and persistent-process tests; the final `26015deda0` tree passed the
broad check, production build, core/extension typechecks, generated-baseline
checks, documentation MDX/link/map checks, and authenticated Claude first/resume
probes recorded in the companion closeout plan. The write-mode full formatter
also exposed inherited target-tag drift in 203 untouched files; none overlaps a
path changed by this branch, so it was deliberately excluded from the port.

Follow-up live evidence used Claude Code 2.1.201. Direct `claude` CLI Sonnet 5
probes passed at the normal adaptive setting and at `xhigh`; the OpenClaw
Gateway then passed both an initial real turn and a resumed follow-up.
Deterministic live-session unit coverage separately proves same-process warm
reuse, so the remaining Claude work is a latency benchmark rather than a
functional persistence gap.

Signal package validation passed the external package's own check/build, a
positive host-injection import, and the targeted missing-package diagnostic. A
linked-account direct Signal status/reaction E2E has not run. These follow-up
checks do not change the 95 source-commit dispositions above.
