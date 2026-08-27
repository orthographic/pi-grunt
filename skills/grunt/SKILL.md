---
name: grunt
description: Bounded standalone worker orchestration. Invoke manually with /skill:grunt.
disable-model-invocation: true
---

# Grunt

Grunt is a standalone Pi SDK worker. It does not require `pi-subagents`; the package may remain installed for unrelated workflows. The primary agent remains orchestrator, decision-maker, and final reviewer.

Use Grunt for bounded exploration, mechanical implementation, tests, and focused diagnosis. Keep product, architecture, scope, licensing, safety, release, promotion, and final validation in the primary session. Never send credentials, secrets, or material marked sealed, expected, promotion-only, or evaluation-only.

## Before launch

1. Read the user's task and load-bearing project files yourself.
2. Choose the narrowest profile: `scout` for read-only discovery, `implementer` for authorized edits, `verifier` for read-only tests/review, or `worker` for legacy mixed-access behavior.
3. Confirm the saved worker model. Use `/grunt-swap` interactively to choose or replace it.
4. Use `effort: "low"` by default. Use `effort: "high"` only for bounded multi-file reasoning or root-cause work, or one revised retry after a reasoning blocker. Never repeat the same packet unchanged.
5. `scout` runs may overlap each other; `worker`, `implementer`, and `verifier` runs are serialized because they share the checkout.
6. Keep mutation-capable runs serialized: workers share the checkout. Parallel writes require isolated worktrees, which Grunt does not create.
7. Do not use Grunt for product, architecture, scope, authority, licensing, safety, release, or final-review decisions.

## Packet

Give every worker one compact packet in this order. Set the tool's `profile` to match the authority: `scout`, `implementer`, `verifier`, or `worker`.

```text
GOAL
SCOPE (exact files or bounded directories)
AUTHORITY (read-only or named writable paths)
INPUTS (paths and already-approved decisions)
CONSTRAINTS
ACCEPTANCE
VALIDATION
OUTPUT
```

Put stable instructions first and task-specific material last. Pass paths instead of file contents. For greenfield work, enumerate exact initial files, state that the missing target is expected, and name the worker as sole writer; a directory wildcard alone is not bounded. Require a compact `RESULT / FILES / CHECKS / BLOCKERS` handoff.

## Dispatch

- Call the `grunt` tool once for one bounded packet.
- Select one profile explicitly when the task is clearly scouting, implementing, or verifying; do not chain profiles by default. Profile tool restrictions are enforced by the runner, not only by the prompt.
- Launch independent `scout` packets separately when parallel discovery helps; they share no mutation phase.
- Keep writes to one worker at a time in a shared checkout.
- Use `effort: "low"` unless the escalation rule applies.
- Use `timeoutMs` only when the task has a known upper bound; timeout stops the worker but cannot roll back edits.
- Inspect changed files and validation evidence before reporting completion.

## Lifecycle

Every run returns a `runId`, selected profile, and persisted session details. Use `grunt_control` or the standalone commands instead of relaunching the same packet:

- `grunt_control({ action: "status", runId? })`
- `/grunt-status [runId]`
- `/grunt-steer <runId> <message>` while a run is actively streaming
- `/grunt-cancel <runId>`
- `/grunt-resume <runId> <follow-up packet>`

A worker's `contact_supervisor` request is surfaced as an interactive decision prompt. In a headless session it receives no reply and must report a blocker rather than guess.

## Training work

A Grunt worker may generate approved synthetic shards, normalize or deduplicate data, maintain manifests, run pinned conversion/training/development commands, and summarize non-sealed results. The worker must not choose policy, inspect excluded material, or approve promotion.

If delegation is wasteful, unsafe, or requires a user-owned decision, do the deterministic part locally and explain why no worker was launched.
