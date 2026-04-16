# OpenClaw `v2026.4.14` Port Bring-Up Notes

This reference records the concrete process and findings from the `custom/20260314` -> `v2026.4.14` bring-up.

## Worktree and artifacts

- Worktree: `/root/openclaw-v2026.4.14-port`
- Branch: `port/v2026.4.14`
- Analysis doc: `/root/openclaw-v2026.4.14-port/CUSTOM_COMMIT_ANALYSIS_v2026.4.14.md`
- Port-plan doc: `/root/openclaw-v2026.4.14-port/CUSTOM_PORT_PLAN_v2026.4.14.md`

## Abstract workflow distilled from this run

1. Lock the exact upstream target.
   In this case the user explicitly rejected `v2026.4.15-beta.1`; the target stayed on stable `v2026.4.14`.

2. Produce the exhaustive per-commit analysis before any real porting.
   The user wanted strict incremental behavior: read one commit, write one entry.

3. Convert that analysis into a per-commit port plan before touching code.
   Each port-plan entry captured:
   - `Need`
   - `Can port`
   - `Conflict risk`
   - why/decision
   - likely conflicts
   - proposed port plan

4. Use rolling subagent batches if the user asks for parallelism.
   The effective pattern here was one commit per agent, immediate writeback, then agent reuse for the next commit.

5. Derive implementation waves from dependencies and seams, not commit order.
   The successful flow was:
   - low-risk runtime/storage fixes first
   - lifecycle/race semantics next
   - subagent timeout/revival next
   - continuity/summaries as a bundled feature family
   - optional channel/media/UI customizations after the core runtime was stable

6. Validate after each wave.
   Targeted tests after each batch were more valuable than one huge end-of-port test run.

7. Close the loop with real runtime startup.
   Bring-up did not end at passing tests. The branch was built/installed, then started with the operator's real gateway command.

8. Re-slice the exploratory history into audit-friendly commits.
   The final result was pushed as a new dated custom branch rather than leaving one huge bring-up commit.

## Process details that worked

### Analysis doc shape

Each analysis entry captured:

- files touched
- what changed
- why it existed
- behavior
- port priority

### Subagent configuration

- Model requirement from user: `gpt-5.4`, `xhigh`
- Practical concurrency limit encountered: 6 agents
- Workflow: send one commit per agent, write result immediately, then reuse that agent for the next commit

## Porting heuristics learned in this run

- Favor end-state fixes over intermediate steps.
  Examples:
  - Compaction recovery: skip `d69ec793c3` and `21cbfdbaa3`; evaluate `37ad5d0d22`
  - Interrupt race chain: skip older precursors like `56e9ffe439` and `ca16c6262a`; evaluate residual missing semantics from `51f6338141` and `8ad787ff0f`

- Port related commits as bundles when needed.
  Examples:
  - Hooks cleanup: `3719905ed7` with `4c0c47e73a`
  - Continuity prompt chain: `eaf035e70f` + `7b2a2c5229` + `03ab0f8683`
  - Session summaries: `e01bdaf8ae` + `93a6dc5136` and optionally `02e33cbf36`
  - Subagent revival/timeouts: `61c685de43` + `32d5b828e7`

- Do not preserve old custom semantics if upstream now has a cleaner explicit model.
  Example:
  - `51730e8328` widened `tree` visibility, but `v2026.4.14` already has explicit `agent` visibility

- Drop backports that upstream already subsumed.
  Examples:
  - `8ee38ec1a1`
  - `9acf99d5c0`
  - `19c9428592`

## Validation staircase used in this run

1. Finish a wave of ports.
2. Run targeted tests for the changed subsystem.
3. Repeat until core runtime, subagent, UI, and channel bundles are all green.
4. Build or install the final branch in the main checkout.
5. Run the real gateway startup command.
6. If startup fails on local config incompatibility, back up config first, then decide whether the missing config key should be ported or migrated away.

## High-signal outcomes from this run

Commits marked especially worth keeping or evaluating early:

- `32d5b828e7` subagent timeout semantics
- `80e504d867` memory transaction batching
- `df0cc1e544` memory WAL mode
- `36f4d9e398` stale cleanup yield
- `61277c678d` disable block streaming for heartbeat replies
- `4c0c47e73a` deleteAfterRun cleanup for all delivery paths
- `8ad787ff0f` remaining interrupt-path semantics
- `aef969d034` PDF abort propagation
- `eee6493af5` preserve `chat.send` session identity
- `716855f9eb` decouple hook delivery from heartbeat runner

## Final commit slicing from this run

The port landed as a small set of audit-friendly subsystem commits instead of preserving exploratory port history:

- docs and planning
- memory/runtime hardening
- agent lifecycle and subagent semantics
- continuity and summaries backend
- UI summaries/token restore
- media and retry behavior
- channel-specific Signal/WhatsApp behavior

## Notes for future use

- For OpenClaw bring-up work, the skill should be used before any mass cherry-picking.
- The docs created in the worktree are the source of truth for what to port next.
- If the user asks for execution ordering, derive it from `Need`, `Can port`, and bundle dependencies rather than from raw commit order.
- Treat local startup/config checks as part of the bring-up workflow. A branch that ports cleanly but cannot start on realistic operator config is not done yet.
