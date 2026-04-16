---
name: custom-porting
description: Use when bringing a long-lived custom OpenClaw branch onto an upstream release in an isolated worktree, with exhaustive per-commit review, phased port planning, implementation, validation, and final runtime bring-up.
---

# Custom Porting

Use this skill when the task is to bring a customized OpenClaw branch forward onto an upstream release while preserving custom behavior intentionally instead of blindly cherry-picking.

## Required artifacts

- `CUSTOM_COMMIT_ANALYSIS_v<release>.md`
  One entry per custom commit. Record what changed, why it existed, user-visible behavior, and rough keep/drop priority.
- `CUSTOM_PORT_PLAN_v<release>.md`
  One entry per custom commit. Record:
  - `Need`: `must|should|optional|no`
  - `Can port`: `yes|partial|no`
  - `Conflict risk`: `low|medium|high`
  - why/decision
  - likely conflicts on the target release
  - proposed port plan

Keep both docs inside the port worktree. They become the source of truth for implementation and final audit.

## End-to-end workflow

1. Lock the target release first.
   Default to the latest stable release unless the user explicitly asks for a beta/prerelease.

2. Create or reuse a dedicated release-based worktree.
   Keep the source custom branch untouched while the release worktree carries the bring-up.

3. Enumerate every custom commit after the branch point.
   This is the complete review set. Do not skip commits just because they look small or obsolete.

4. Build the analysis doc first.
   Work one commit at a time. If using subagents, still write incrementally: one reviewed commit, one written entry.

5. Build the port-plan doc second.
   Every custom commit must end with an explicit decision: direct port, manual port, bundled port, redesign on current seams, or drop.

6. Collapse the plan into implementation waves.
   Execute by dependency and subsystem, not by raw commit order. Large feature families usually port as bundles.

7. Implement on the target release's current seams.
   Prefer semantic end states over replaying intermediate history. When upstream refactored the architecture, port behavior, not patch shape.

8. Validate after every wave.
   Run targeted tests for the touched area immediately. Do not wait until the end to discover a broken subsystem.

9. Close the loop with runtime bring-up.
   Build or install the resulting branch, run the operator's real startup command, and confirm the process actually listens and serves. Config incompatibilities discovered here are part of the bring-up, not an afterthought.

10. Re-slice the final history for audit.
    Replace exploratory work with a small number of boundary-clear commits grouped by subsystem or feature family, then push a new dated custom branch.

## Subagent guidance

- Only use subagents when the user explicitly wants delegation or parallel review.
- For OpenClaw port work, prefer `gpt-5.4` with `xhigh` reasoning when available.
- If the environment caps concurrency, use rolling batches rather than trying to spawn one agent per commit all at once.
- Keep each delegated unit tight: usually one commit, or one known feature bundle if the commits are inseparable.
- Write results back to the docs immediately instead of batching many unread agent outputs.

## What to look for per commit

- Was the bug/feature already absorbed upstream?
- Is this commit only an intermediate step in a later fix chain?
- Did the touched files move or get refactored?
- Does the current target already have a newer architecture that makes the old patch obsolete?
- Is the right action to cherry-pick, manually transplant, or redesign on current seams?

## Port heuristics

- Old race-condition chains often should not be replayed commit-by-commit. Port only the missing end-state behavior.
- Feature families often need to be ported as bundles, not isolated commits.
- UI surfaces should not be ported before the underlying backend/storage/tooling exists.
- If upstream now exposes a cleaner explicit policy/config for the same outcome, prefer that over preserving old custom semantics.
- Treat config-schema drift as part of the port. If runtime fails because old custom config keys no longer exist, decide whether to port the key or migrate the config, and back up local config before changing it.
- A successful code port is not enough. The branch should still build, install, start, and answer the expected gateway/CLI health checks.

## Finalization checklist

- All custom commits reviewed and written into both docs
- Implementation waves completed or explicitly deferred
- Targeted tests passed for each wave
- Real runtime startup command exercised
- Final commits regrouped into audit-friendly boundaries
- New dated custom branch pushed

## Implementation-plan template

If the user wants a concrete implementation order after `CUSTOM_PORT_PLAN_v<release>.md` is done, create:

- `CUSTOM_IMPLEMENTATION_PLAN_v<release>.md`

Do not just restate commit order. Derive waves from:

- `Need`
- `Can port`
- `Conflict risk`
- bundle dependencies
- backend-before-UI requirements
- runtime bring-up dependencies

Use the template in:

- `references/implementation-plan-template.md`

## Current OpenClaw `v2026.4.14` bring-up references

For the current recorded case, read:

- `references/openclaw-v2026.4.14.md`
- `references/implementation-plan-template.md`
