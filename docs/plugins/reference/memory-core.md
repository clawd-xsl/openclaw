---
summary: "Adds agent-callable tools."
read_when:
  - You are installing, configuring, or auditing the memory-core plugin
title: "Memory Core plugin"
---

# Memory Core plugin

Adds agent-callable tools.

## Distribution

- Package: `@openclaw/memory-core`
- Install route: included in OpenClaw

## Surface

contracts: tools

<!-- openclaw-plugin-reference:manual-start -->

## Memory Core capabilities

`memory-core` is the bundled memory plugin. It owns the default Markdown memory
search surface and durable session-summary continuity.

### Agent tools

The plugin registers these agent tools:

- `memory_search` finds indexed Markdown memory.
- `memory_get` reads a specific memory file or line range.
- `session_summaries` recalls bounded summaries of earlier sessions that the
  requesting session is allowed to see.

For the Markdown file layout and search backends, see
[Memory overview](/concepts/memory).

## Durable session summaries

Session summaries are enabled by default. On a real session rollover caused by
`new`, `reset`, `idle`, or `daily`, memory-core durably queues the ended
session for summarization. It skips `compaction`, `shutdown`, `restart`, and
unknown lifecycle reasons; deleting a session purges its summary state.

The worker reads a bounded transcript, removes non-conversation records,
redacts likely secrets and model control tokens, and treats transcript text as
untrusted data. Model inputs and stored outputs pass through the same bounded
sanitization, but credential redaction is heuristic and is not a substitute for
keeping secrets out of conversations. Large transcripts use bounded map and
reduce model calls. Pending or retryable work is stored in plugin state and
recovered after restart. Each stored summary is capped at 8 KiB.

When the replacement session is the direct successor on the same session key,
memory-core prepends its completed predecessor summary as bounded, untrusted
context. If generation is still pending, it can temporarily use a small bounded
transcript tail. It does not inject an unrelated recent-session history dump.
Set `autoInject: false` to keep stored summaries available through the tool and
Control UI without adding them to prompts.

```json5
{
  plugins: {
    entries: {
      "memory-core": {
        config: {
          summaries: {
            enabled: true,
            autoInject: true,
            lookbackDays: 30,
            maxPromptTokens: 16000,
            minMessages: 3,
          },
        },
      },
    },
  },
}
```

By default, summary generation uses the ended session's agent and configured
model. An explicit `summaries.model` requires
`plugins.entries.memory-core.llm.allowModelOverride: true`. Generating for an
agent other than the configured default agent also requires
`plugins.entries.memory-core.llm.allowAgentIdOverride: true`.

The `session_summaries` tool applies the normal session-history visibility and
agent-to-agent policy before returning results. Search is literal, responses
are token-bounded, and pagination uses opaque cursors. It is included in the
built-in coding and messaging tool profiles; an explicit deny still takes
precedence. Operators can inspect the same durable records through the
`operator.read`-protected
`memory.summaries.list` RPC and the **Summaries** page in the Control UI. The
operator RPC shares filtering and pagination code with the tool but does not
impersonate a requester session.

Setting `summaries.enabled: false` stops new generation and prompt injection.
It does not erase existing records: the tool, RPC, and Control UI can still
read stored summaries subject to their respective authorization checks.
`lookbackDays` limits queries, recovery, and predecessor lookup; it is not a
physical TTL. The namespace retains at most 4096 live records, and the shared
plugin-state store evicts the oldest live rows when the namespace grows past
that bound.

## Completed-session memory flush

Completed-session memory flush is a separate, default-on path that projects
durable facts into Markdown memory. It runs only for the configured default
agent's main or global session when that session ends for `new`, `reset`,
`idle`, or `daily`. Other agents and isolated channel sessions are skipped.

The worker reads a bounded transcript and can make one isolated model call. It
persists the closed JSON candidate in a durable outbox before the host appends
accepted text to `memory/YYYY-MM-DD.md`. Operation markers and a file lock let
startup recovery reconcile an append that succeeded before a crash without
writing the same operation twice. The extraction session has read-only tools
and cannot deliver messages. The outbox records the enqueue-time workspace
path and filesystem identity; retries validate that snapshot instead of
intentionally following a later workspace configuration change. Projectors and
purges use a stable state-directory lock keyed by the snapshot and daily path.

The call reuses the standard `agents.defaults.compaction.memoryFlush` model,
prompt, system prompt, and timezone-derived daily path. Deleting a session
first writes a durable cancellation fence, then removes the outbox record under
the same projection lock. A lock failure leaves a cancellation tombstone for
startup recovery to retry instead of deleting state without synchronization.
Deletion does not remove content already appended to Markdown.

```json5
{
  plugins: {
    entries: {
      "memory-core": {
        config: {
          completedSessionFlush: {
            enabled: true,
            maxPromptTokens: 16000,
          },
        },
      },
    },
  },
}
```

Set `completedSessionFlush.enabled: false` to disable only this rollover path.
The global `agents.defaults.compaction.memoryFlush.enabled: false` setting
disables pre-compaction, CLI-pressure, and completed-session memory flushes.

## Legacy summary migration

Run `openclaw doctor --fix` once after upgrading a deployment that stored
session summaries in a legacy memory-index SQLite sidecar. This migration is an
explicit doctor repair; the SQLite file alone does not trigger the one-shot
startup migration path.

Doctor prefers configured legacy stores over default and retry paths, sanitizes
and bounds stored text, never overwrites a current record, and repairs an
imported record whose predecessor index was interrupted by a crash. It imports
at most 2048 recent records during the migration, selected fairly across
agents, while leaving 512 rows of headroom in each summary namespace and
additional headroom under the plugin-wide state cap. Older recognized
occurrences can be omitted from the queryable store; the original SQLite
remains preserved under a `.migrated` name so those rows are not destroyed.

Direct-successor lineage is rebuilt only when agent ownership, session key,
time order, and the unique child are unambiguous. A row with clear ownership but
ambiguous lineage remains available for explicit history queries and is not
auto-injected as a predecessor. Invalid, unsupported, or ownership-ambiguous
rows block archival and remain in a retry source. For a shared SQLite path,
doctor records the complete owner set in one shared retry database before
moving the original path aside, so a later run still has the ownership map
after retired `memorySearch.store.path` configuration is removed.

<!-- openclaw-plugin-reference:manual-end -->
