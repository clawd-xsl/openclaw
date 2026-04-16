# Implementation Plan Template

Use this reference after `CUSTOM_PORT_PLAN_v<release>.md` is complete and the user wants an implementation sequence.

## Goal

Turn a per-commit port plan into an implementation document that is optimized for:

- low early risk
- clear dependency ordering
- fast validation
- clean final commit slicing

Recommended output file:

- `CUSTOM_IMPLEMENTATION_PLAN_v<release>.md`

## Inputs

Start from the finished `CUSTOM_PORT_PLAN_v<release>.md` and extract:

- all `must`
- all `should`
- `optional` items the user explicitly wants in round one
- bundle relationships
- commits marked `drop` or `no`
- conflict hotspots
- likely test files or commands per subsystem

## Grouping rules

1. Exclude explicit drops first.
   Do not let already-upstream or obsolete commits clutter wave planning.

2. Collapse intermediate histories into end-state bundles.
   If multiple commits represent one final behavior, plan one bundle.

3. Put backend and storage before UI and channel surfaces.
   A feature is not ready for UI porting if its runtime or data model is not in place.

4. Start with low-conflict, high-confidence ports.
   Early green waves reduce uncertainty for the rest of the bring-up.

5. Put startup-critical runtime fixes ahead of optional product polish.
   The branch should become buildable and runnable as early as possible.

6. Leave clearly optional or product-specific customizations for later waves.
   These should never block the core runtime bring-up.

## Typical wave shape

OpenClaw bring-up work usually compresses well into this order:

1. Baseline low-risk fixes
   Examples: storage hardening, small runtime guards, low-conflict correctness fixes

2. Lifecycle and cleanup semantics
   Examples: queue cleanup, hook cleanup, interrupt/followup correctness

3. Core agent/runtime semantics
   Examples: subagent timeout semantics, revival, session continuity

4. Feature bundles with deeper seams
   Examples: summaries, compaction recovery, prompt/context threading

5. UI and channel surfaces
   Examples: control UI, Signal/WhatsApp behavior, provider-specific integrations

6. Runtime bring-up and config compatibility
   Examples: install/build, real startup command, config migration or compatibility fixes

## Per-wave template

Use this structure for every wave:

```md
## Wave N: <short title>

Goal:

- <what this wave stabilizes or unlocks>

Includes:

- `<commit>` <summary>
- `<commit>` <summary>

Why now:

- <dependency or risk rationale>

Implementation approach:

- <direct port | bundled port | reimplementation on current seams>
- <primary files or subsystems likely involved>

Conflict hotspots:

- <moved files, refactors, schema drift, architectural changes>

Validation:

- `<targeted test command or test area>`
- `<targeted test command or test area>`

Exit criteria:

- <observable condition that means this wave is done>
```

## Document trailer template

End `CUSTOM_IMPLEMENTATION_PLAN_v<release>.md` with:

```md
## Deferred or dropped

- `<commit>` <why not in this round>

## Runtime bring-up checklist

- build or install the resulting branch
- run the operator's real startup command
- verify the expected port is listening
- run the matching health/status command
- inspect first actionable startup error if runtime fails

## Final commit slicing plan

- docs and analysis
- runtime/storage
- agent lifecycle
- major feature bundle(s)
- UI/channel integrations
```

## Quality bar

A good implementation-plan document should make these questions trivial to answer:

- what gets ported first
- what can run in parallel
- what must be bundled
- what is intentionally dropped
- what tests prove each stage
- when the branch is ready for real startup testing

If the result still reads like raw commit order, rewrite it.
