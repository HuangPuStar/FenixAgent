---
name: multitask
description: >-
  Multitask mode hands non-trivial workstreams to exactly one owner through
  `Agent`, keeping the foreground free to coordinate. Use when the user enables
  multitask (`/multitask`) or hands over two or more independent workstreams; its
  rules also answer questions about delegation without enabling the mode.
---

# Multitask Mode

Work splits into a foreground **coordinator** and **owners** that take work through `Agent`. The user enables the mode, and the injected body then stays in the transcript for the rest of the session. A compact drops it — re-load it, or say the mode lapsed, rather than letting it disappear quietly.

The injected body can also arrive **truncated** (a `… [N characters omitted] …` marker): the description only summarizes, and the binding rules below are exactly what gets cut. If what you loaded is not the whole file, read `.claude/skills/multitask/SKILL.md` from disk before acting — never run the mode from the description alone.

Two branches: **enabled** — the hand-off rules below are binding. **Consulted** — the user asked about ownership, launching, follow-up, or tiers without enabling the mode; answer from these rules and change nothing about how the current task runs.

## What this mode changes

The host default works in the foreground whenever it fits, and puts direct work at two to three files. Enabled, this mode **hands off everything outside that zone**.

Hand off when any of these holds:

1. More than three files are in scope.
2. The change crosses a crate boundary.
3. The user hands over two or more independent workstreams — one owner each.

Direct work stays direct: reads, searches, and edits of at most three files in one crate, plus coordination — reading results, synthesizing, asking the user, deciding the next step. Reading and searching to size the work is not a delivery, but that exemption is narrow: a few targeted reads and searches inside files already in your scope, not a survey of ground you do not own yet. Recon that enumerates a directory, greps the tree for references, or reads build, deploy, or CI config to pin down a vague brief is itself a deliverable — hand it off, and keep the work it sizes with that owner. An owner's returned report stays coordination. Where the line is unclear, hand off rather than take a look first.

If `Agent` is unavailable, or the user prohibits delegation, do the permitted work directly and say so. Never refuse work the user has authorized.

## One owner

A handed-off deliverable — investigate → implement → verify — has exactly one owner, and the coordinator is never that owner. Absorbed:

- Do not redo handed-off work in the foreground or in a second owner; follow up only where results expose a gap.
- Verification belongs to the deliverable. Read the evidence the owner reports instead of re-running its verification. When a real gap appears, hand the gap back to that owner (`resume_thread_id`) — a gap that falls outside its original file scope is still the owner's to close, not the foreground's.
- Do not split one deliverable into roles that wait on each other.
- Siblings only for genuinely independent workstreams, with non-overlapping write scopes and settled interfaces. The foreground must not edit files an owner is holding; wait, or hand ownership over explicitly.
- Delegation is one level deep, so the coordinator alone adds siblings. At the concurrency limit, wait for completion notifications instead of launching around it.

Before handing off: does this work already have an owner, and does my write scope overlap it? Then give the brief a file scope, constraints, acceptance criteria, and the expected return. A launch acknowledgment is not delivery.

## Background only

Every hand-off launches with `run_in_background: true`; the foreground never blocks on a synchronous `Agent` call. Blocking trades away the free foreground that the hand-off exists to keep, so no hand-off is the exception.

## Model choice

- Lookup and mechanical sweeps → `haiku`. Implementation with verification → `sonnet`, or omit `model` and take the definition's tier. Cross-crate contracts and architecture trade-offs → `opus`. The user asks for the parent's model → `inherit`.
- Do not cut implementation work to `haiku` to save cost — that trades the price of delegation for a weaker executor.
- `resume_thread_id` and `fork` reuse the original environment and ignore `model`, so never drive a model change through either. Do not interrupt a running owner to switch tiers.

## Follow-up

- Keep the `child_thread_id` and follow up on the same work through `Agent(resume_thread_id: ...)` rather than creating a replacement owner; read the returned `action` to tell sending from resuming.
- Interrupted with work left and no cancellation: resume that thread. If it is still active but has no live receiver in this session, report the blocker rather than silently recreating it.
- A sent `prompt` is queued rather than interrupting an in-flight call. Until it appears in the transcript, do not claim the changed requirement is implemented.
- On completion, do only gap follow-up and one synthesis for the user: changes, verification evidence, blockers, unverified items.

## Cancellation

Background owners have their own lifecycle, so stopping the foreground does not stop them. Use the host's cancellation interface and confirm the result. Cancelled work is not resumed automatically. Evidence of state is the actual tool response or runtime notification, never an assumption.
