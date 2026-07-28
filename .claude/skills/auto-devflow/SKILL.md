---
name: auto-devflow
description: >
  Use when starting an issue, bugfix, feature, or refactor that should be driven
  by multiple coordinated subagents: explore → plan → code → review, with the main
  agent acting as controller and subagents exchanging handoff files.
---

# Start Devflow

Run a controlled **devflow**: the main agent stays the controller, each subagent owns one phase, and phase outputs are written to temporary handoff files before the next phase starts.

Use this when the user says things like "开始解决这个 issue", "start this issue", "fix this bug end-to-end", "实现这个功能", or asks for a multi-agent workflow rather than a single-agent edit.

## Non-Negotiables

- The main agent owns scope, approvals, TodoWrite, git safety, and final reporting.
- Subagents do focused work only. Do not let a subagent silently broaden scope.
- Use handoff files as the shared memory. Do not rely on hidden subagent context.
- Run writable phases sequentially. Never run two coding subagents against the same checkout at the same time.
- Ask the user before destructive operations, branch changes, commits, or scope expansion.

## Operating Modes

Pick a mode during Intake and record it in `00-context.md`.

### Relaxed Mode

Default for simple, low-risk tasks.

Use relaxed mode when:
- the request is small and localized
- the likely change touches a few files with obvious ownership
- failure impact is low and rollback is straightforward
- the agent has not already made repeated mistakes on this task

Relaxed flow:

```text
Intake → Explore → Plan → Code → Review → Verify → Report
```

Plan review is optional. The main agent may self-check `02-plan.md` instead of dispatching a separate reviewer.

### Cautious Mode

Use cautious mode when the user says the task is hard, risky, subtle, or when the agent has already made too many mistakes. Also use it for public API changes, data/schema changes, security-sensitive code, concurrency, async lifecycle, rendering/event-loop bugs, or broad refactors.

Cautious flow:

```text
Intake → Explore → Plan → Plan Review → User/Controller Gate → Code → Review → Verify → Report
```

Cautious mode adds a plan review before coding. Dispatch a read-only reviewer (`plan` or `code-reviewer`) to critique `02-plan.md` and write `02-plan-review.md`. **Plan Review is a mandatory gate in cautious mode**——coding must not start until every critical issue is fixed or explicitly accepted by the main agent/user. Historical evidence: Plan Review intercepted 9+ blocking issues across 3 major refactors (StageContext、ProviderAdapter、compact_v2) in 2026-07-16 alone.

Completion criterion: `00-context.md` states `Mode: relaxed` or `Mode: cautious`, why that mode was chosen, and which gates are required.

## Handoff Directory

Create one directory per devflow:

```text
.peri/plans/<title>/
  00-context.md
  01-explore.md
  02-plan.md
  02-plan-review.md   # cautious mode only
  03-code.md
  04-review.md
  05-verification.md
```

`<title>` 用任务标题的 kebab-case 形式（如 `fix-auth-timeout`、`add-pagination`），有 issue id 时附加 id。

Each handoff file must contain:

```markdown
# <Phase> Handoff

## Goal
<one sentence>

## Scope
<in scope / out of scope>

## Findings or Changes
<phase-specific details>

## Files
<relevant file paths>

## Commands
<commands run and outcomes, or "not run">

## Open Questions
<none, or exact blockers>

## Next Prompt
<self-contained prompt for the next subagent>
```

Completion criterion: a later subagent can start from the previous handoff file plus the original user request without guessing.

## Flow

### 1. Intake

Clarify only if needed. If the user gave an issue id, URL, stack trace, or spec, capture it exactly in `00-context.md`.

Write `00-context.md` with:
- original request
- success criteria
- operating mode: `relaxed` or `cautious`, with reason
- constraints from the user and project memory
- current git branch/status summary
- explicit approval state for commits or branch changes

Stop and ask if success criteria or target issue is ambiguous.

### 2. Explore

Dispatch an `explore` subagent in read-only mode.

Prompt it to:
- inspect relevant files and tests
- identify execution paths and ownership boundaries
- find existing conventions
- write `01-explore.md`
- not edit code

Completion criterion: `01-explore.md` names likely files to touch, relevant tests, known traps, and at least one plausible implementation seam.

### 3. Plan

Dispatch a `plan` subagent in read-only mode, using `00-context.md` and `01-explore.md`.

Prompt it to:
- produce a small implementation plan
- identify risks and rollback points
- define verification commands
- write `02-plan.md`
- not edit code

Completion criterion: `02-plan.md` has ordered steps, exact files, verification commands, and a clear stop/ask condition.

### 3.5. Plan Review

In relaxed mode, the main agent self-checks the plan for missing files, missing verification, scope creep, and unsafe operations. Write the self-check result into `02-plan.md` or `00-context.md`.

In cautious mode, dispatch a read-only plan reviewer before coding.

Prompt it to:
- read `00-context.md`, `01-explore.md`, and `02-plan.md`
- challenge assumptions and hidden risks
- check that planned files and tests match the exploration findings
- identify scope creep, missing rollback, missing verification, and unsafe steps
- write `02-plan-review.md`
- not edit code

Completion criterion: relaxed mode has a recorded self-check; cautious mode has `02-plan-review.md` with `APPROVED` or a concrete issue list. If the reviewer finds critical issues, update `02-plan.md` and repeat plan review before coding.

If the plan changes user-visible behavior, public APIs, data format, migrations, or architecture boundaries, present the plan summary to the user and wait for approval before coding.

### 4. Code

Dispatch exactly one `coder` subagent for the current coding slice, using `00-context.md`, `01-explore.md`, and `02-plan.md`.

Prompt it to:
- implement only the approved slice
- follow existing style
- run targeted checks if practical
- write `03-code.md`
- report any blockers instead of guessing

Completion criterion: `03-code.md` lists changed files, commands run, residual risks, and whether the plan was followed exactly.

If the plan is large, split it into sequential slices. After each slice, review before starting the next.

### 5. Review

Dispatch a `code-reviewer` subagent in read-only mode, using all handoff files plus the diff.

Prompt it to check:
- spec compliance: did the code solve the stated task and avoid extras?
- maintainability: style, tests, error handling, security, regressions
- handoff integrity: did `03-code.md` match actual diff?
- write `04-review.md`

Completion criterion: review returns either `APPROVED` or an issue list with severity and exact file references.

If review finds issues, send a focused fix prompt to `coder`, update `03-code.md`, then re-review. Repeat until approved or blocked.

### 6. Verify

The main agent runs or delegates final verification based on risk:
- small change: main agent runs targeted tests/lint/build discovered in `02-plan.md`
- non-trivial change: dispatch `verification` subagent with original task, changed files, and approach

Write `05-verification.md` with commands, outputs, and verdict.

Completion criterion: every planned verification is passed, explicitly skipped with reason, or reported as blocked.

### 7. Report

Reply with:
- outcome
- files changed
- verification evidence
- unresolved risks or follow-up work
- whether commits were created (only if user explicitly requested commits)

Do not claim completion without `05-verification.md` evidence.

## Controller Checklist

Use TodoWrite for the full devflow:

1. Intake / context file
2. Explore handoff
3. Plan handoff
4. Plan review gate (self-check in relaxed mode, reviewer in cautious mode)
5. Code handoff
6. **Worktree safety gate**: `git diff --stat` in both main repo and worktree; verify edits in correct location
7. Review loop
8. Verification handoff
9. Final report

Keep the main context small: read handoff summaries, not every file, unless you need to adjudicate a blocker.

## Subagent Prompt Skeletons

### Explorer

```text
Goal: explore the codebase for <task>. Read .peri/plans/<title>/00-context.md first.

Write .peri/plans/<title>/01-explore.md using the required handoff template.
Do not edit files. Focus on relevant paths, conventions, tests, and risks.
Completion: the next planner can create an implementation plan without additional search.
```

### Planner

```text
Goal: plan <task>. Read 00-context.md and 01-explore.md first.

Write .peri/plans/<title>/02-plan.md using the required handoff template.
Do not edit files. Include ordered steps, exact files, verification commands, risks, and stop/ask conditions.
Completion: a coder can implement from the plan without guessing.
```

### Plan Reviewer

```text
Goal: review the plan for <task>. Read 00-context.md, 01-explore.md, and 02-plan.md first.

Write .peri/plans/<title>/02-plan-review.md. Return APPROVED or list issues with severity, file references, and fix guidance.
Challenge assumptions, hidden risks, missing verification, rollback gaps, unsafe operations, and scope creep.
Do not edit files.
```

### Coder

```text
Goal: implement the approved plan for <task>. Read 00-context.md, 01-explore.md, and 02-plan.md first.

CRITICAL — Worktree safety:
- ALL file paths in edits MUST use absolute paths. Append cwd prefix to every relative path.
- Before any edit, READ the file to confirm it exists at the absolute worktree path.
- After all edits, run: cd <absolute_worktree_path> && git diff --stat HEAD
- If you edited a file NOT in the worktree, STOP and report immediately.

CRITICAL — Scope boundary:
- Only modify files explicitly listed in the plan. DO NOT touch adjacent files.
- If the plan says change Cargo.toml versions and import paths, DO NOT refactor other code.
- If you see a related improvement not in the plan, record it in 03-code.md Open Questions — DO NOT implement it.

Edit only files required by the plan. Follow repository style. Run targeted checks if practical.
Write .peri/plans/<title>/03-code.md using the required handoff template.
If blocked or the plan is wrong, stop and report instead of broadening scope.
```

### Reviewer

```text
Goal: review the implementation for <task>. Read all handoff files and inspect the current diff.

Write .peri/plans/<title>/04-review.md. Return APPROVED or list issues with severity, file references, and fix guidance.
Check spec compliance first, then code quality. Do not edit files.
```

### Verifier

```text
Goal: verify <task> is complete. Read all handoff files and inspect changed files.

Run appropriate checks or explain why they cannot run. Write .peri/plans/<title>/05-verification.md with evidence and verdict.
Do not edit files.
```

## Red Flags

Stop and ask the user when:
- the issue/spec is missing or contradictory
- the chosen operating mode is unclear after intake
- cautious-mode plan review finds unresolved critical issues
- the plan requires deleting data, changing schemas, or altering public behavior not requested
- the repo has unrelated dirty changes that overlap planned files
- a subagent reports `BLOCKED`, `NEEDS_USER_DECISION`, or an unsafe workaround
- **worktree safety gate fails**: main repo has unexpected diffs after coder phase
- verification fails twice for the same reason

## Relationship to Other Skills

- Use `diagnose` or `systematic-debugging` inside the explore phase for hard bugs.
- Use `writing-plans` when the output should be a standalone long-form implementation plan.
- Use `subagent-driven-development` when you already have a detailed plan and just need task-by-task execution.
- Use `verification-before-completion` before claiming success.
