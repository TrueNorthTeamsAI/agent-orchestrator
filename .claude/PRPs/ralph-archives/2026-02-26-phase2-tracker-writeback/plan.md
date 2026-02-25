# Feature: PRP Phase Tracker Writeback

## Summary

Extend the lifecycle manager's tracker writeback system to post progress comments on linked issues when PRP-enabled sessions transition between phases (investigating, planning, implementing, PR open). The `prp.writeback` config controls which phases produce comments. This requires: (1) tracking `prpPhase` transitions in `checkSession()` alongside status transitions, (2) generating phase-specific comment templates, and (3) respecting the per-project writeback config.

## User Story

As a developer managing AI coding agents
I want the issue tracker to receive progress comments as the agent moves through PRP phases
So that I can monitor agent progress without checking the dashboard

## Problem Statement

PRP-enabled sessions now detect phases and write `prpPhase` to metadata (Phase 4), but the lifecycle manager ignores `prpPhase` changes entirely. Users get no tracker feedback between spawn and PR creation.

## Solution Statement

Add `prpPhase` change detection to `checkSession()` using a parallel tracking map. When a phase transition is detected, generate a phase-specific comment via a new `getPrpWritebackComment()` function and post it using the existing `writebackToTracker()`. Filter comments through the project's `prp.writeback` config.

## Metadata

| Field            | Value                                             |
| ---------------- | ------------------------------------------------- |
| Type             | ENHANCEMENT                                       |
| Complexity       | MEDIUM                                            |
| Systems Affected | lifecycle-manager, lifecycle-manager tests         |
| Dependencies     | None (uses existing types, config, metadata)       |
| Estimated Tasks  | 4                                                  |

---

## UX Design

### Before State

```
Developer labels issue → Agent spawns → ... silence ... → PR comment appears
                                         (no phase progress visible)
```

### After State

```
Developer labels issue → Agent spawns
  → "🔍 Investigation started" comment on issue
  → "📋 Plan created — 5 tasks" comment on issue
  → "🔨 Implementation in progress" comment on issue
  → "🤖 PR #42 opened" comment on issue (existing)
```

### Interaction Changes

| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| Issue tracker | Silent between spawn and PR | Comments at each PRP phase | Can monitor progress without dashboard |

---

## Mandatory Reading

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `packages/core/src/lifecycle-manager.ts` | 417-487 | `writebackToTracker`, `getWritebackComment`, `checkSession` call site — extend these |
| P0 | `packages/core/src/types.ts` | 839-866, 999-1016 | `PrpConfig`, `PrpWriteback`, `SessionMetadata.prpPhase` |
| P1 | `packages/core/src/__tests__/lifecycle-manager.test.ts` | 1-148 | Test setup pattern with `makeSession`, mock registry, config |
| P1 | `packages/core/src/config.ts` | 88-106 | `PrpWritebackSchema` — defaults all true |

---

## Patterns to Mirror

**WRITEBACK_COMMENT:**
```typescript
// SOURCE: packages/core/src/lifecycle-manager.ts:434-460
// COPY THIS PATTERN:
function getWritebackComment(session: Session, newStatus: SessionStatus): string | null {
  switch (newStatus) {
    case "pr_open":
      return [
        `🤖 **Agent Orchestrator** completed work on this issue.`,
        "",
        session.pr ? `Pull Request: ${session.pr.url}` : "",
        `Session: \`${session.id}\``,
      ]
        .filter(Boolean)
        .join("\n");
    // ...
    default:
      return null;
  }
}
```

**WRITEBACK_CALL:**
```typescript
// SOURCE: packages/core/src/lifecycle-manager.ts:484-487
const writebackComment = getWritebackComment(session, newStatus);
if (writebackComment) {
  writebackToTracker(session, writebackComment);
}
```

**TEST_PATTERN:**
```typescript
// SOURCE: packages/core/src/__tests__/lifecycle-manager.test.ts:31-48
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "spawning",
    activity: "active",
    // ...
    metadata: {},
    ...overrides,
  };
}
```

---

## Files to Change

| File | Action | Justification |
| ---- | ------ | ------------- |
| `packages/core/src/lifecycle-manager.ts` | UPDATE | Add `prpPhases` tracking map, `getPrpWritebackComment()`, prpPhase change detection in `checkSession()` |
| `packages/core/src/__tests__/lifecycle-manager.test.ts` | UPDATE | Add PRP writeback tests |

---

## NOT Building (Scope Limits)

- **Plan gate reaction** — Phase 6 handles this; we only post comments here
- **New reaction types for PRP phases** — out of scope; reactions remain status-based
- **Implementation phase detection in hook script** — the hook currently only detects `investigating` and `planning`; the `implementing` phase comment triggers when `prpPhase` changes from `planning` to anything else OR when status becomes `working` after planning. We work with what the hook provides.
- **Dashboard UI for PRP phases** — PRD explicitly excludes this

---

## Step-by-Step Tasks

### Task 1: ADD `getPrpWritebackComment()` function to lifecycle-manager.ts

- **ACTION**: Add a new function below `getWritebackComment()` (after line 460)
- **IMPLEMENT**: A function `getPrpWritebackComment(session: Session, newPhase: string, oldPhase: string | undefined): string | null` that returns phase-specific comment strings:
  - `"investigating"` → `🔍 **Agent Orchestrator** session \`${session.id}\` started investigating this issue.`
  - `"planning"` → `📋 **Agent Orchestrator** session \`${session.id}\` is creating an implementation plan.`
  - `"implementing"` → (if the hook ever detects this) `🔨 **Agent Orchestrator** session \`${session.id}\` is implementing the plan.`
  - Other/unknown → `null`
- **MIRROR**: `getWritebackComment()` at lifecycle-manager.ts:434-460 — same return type, same `[...].join("\n")` pattern
- **VALIDATE**: `pnpm typecheck`

### Task 2: ADD `prpPhase` change detection to `checkSession()` in lifecycle-manager.ts

- **ACTION**: Add a `prpPhases` map (`Map<string, string>`) alongside existing `states` map (near line 176). In `checkSession()`, after the status transition block (after line 487), add prpPhase change detection:
  1. Read `newPrpPhase` from `session.metadata?.["prpPhase"]`
  2. Read `oldPrpPhase` from `prpPhases.get(session.id)`
  3. If `newPrpPhase` exists and differs from `oldPrpPhase`:
     - Update `prpPhases.set(session.id, newPrpPhase)`
     - Check `project?.prp?.enabled` — skip if not PRP-enabled
     - Map phase to writeback config key: `investigating` → `investigation`, `planning` → `plan`, `implementing` → `implementation`
     - Check `project?.prp?.writeback?.[writebackKey]` — skip if `false`
     - Call `getPrpWritebackComment(session, newPrpPhase, oldPrpPhase)`
     - If non-null, call `writebackToTracker(session, comment)`
  4. Also update `prpPhases` when `newPrpPhase` exists even if no change (to initialize tracking)
- **GOTCHA**: The prpPhase check must run on EVERY poll, not just when status changes. Place it OUTSIDE the `if (newStatus !== oldStatus)` block — prpPhase can change without a status change.
- **GOTCHA**: The existing `pr_open` writeback already covers the `pr` phase — do NOT duplicate it. The `pr` writeback key in `prp.writeback` controls whether the existing `pr_open` comment is suppressed for PRP projects. Actually, keep it simple: PRP `pr` writeback is already handled by the existing `getWritebackComment("pr_open")`. No new code needed for `pr` phase.
- **VALIDATE**: `pnpm typecheck`

### Task 3: UPDATE `getWritebackComment()` to respect `prp.writeback.pr` config

- **ACTION**: The existing `pr_open` case already posts a comment. For PRP-enabled projects with `writeback.pr: false`, this should be suppressed. Modify `getWritebackComment()` to accept the project config and check `project?.prp?.enabled && project?.prp?.writeback?.pr === false` — if so, return `null` for `pr_open`.
- **IMPLEMENT**: Change signature to `getWritebackComment(session: Session, newStatus: SessionStatus, project?: ProjectConfig): string | null`. At the `pr_open` case, add early return `if (project?.prp?.enabled && project?.prp?.writeback?.pr === false) return null;`. Update the call site at line 484 to pass `project`.
- **GOTCHA**: `project` may be undefined — use optional chaining. Non-PRP projects (no `prp` config) must still get `pr_open` comments.
- **VALIDATE**: `pnpm typecheck && pnpm lint`

### Task 4: ADD PRP writeback tests to lifecycle-manager.test.ts

- **ACTION**: Add a new `describe("PRP phase writeback")` block
- **IMPLEMENT** these test cases:
  1. **Posts investigation comment when prpPhase transitions to "investigating"** — session with PRP-enabled project, metadata `prpPhase: "investigating"`. Mock tracker's `updateIssue`. After `lm.check()`, verify `updateIssue` called with comment containing "investigating".
  2. **Posts planning comment when prpPhase transitions to "planning"** — same pattern.
  3. **Respects writeback.investigation: false** — PRP-enabled project with `writeback: { investigation: false }`. After check, `updateIssue` NOT called for investigation phase.
  4. **Does not post PRP comments for non-PRP projects** — project without `prp` config, session with `prpPhase` in metadata. No comment posted.
  5. **Does not duplicate comment on same phase** — call `check()` twice with same `prpPhase`. Comment posted only once.
  6. **Respects writeback.pr: false for pr_open status** — PRP-enabled project with `writeback: { pr: false }`. Status transition to `pr_open` does NOT post comment.
- **MIRROR**: Existing test patterns in lifecycle-manager.test.ts — use `makeSession()`, mock registry with tracker, `config.projects` with PRP config.
- **SETUP**: For each test, configure `config.projects["my-app"]` with `prp: { enabled: true, gates: { plan: false, pr: false }, writeback: { investigation: true, plan: true, implementation: true, pr: true } }` and override as needed. Add a mock tracker to `mockRegistry.get` that returns a tracker with `updateIssue: vi.fn()`.
- **VALIDATE**: `pnpm test -- packages/core/src/__tests__/lifecycle-manager.test.ts`

---

## Testing Strategy

### Unit Tests to Write

| Test File | Test Cases | Validates |
| --------- | ---------- | --------- |
| `packages/core/src/__tests__/lifecycle-manager.test.ts` | 6 cases in "PRP phase writeback" describe block | Phase comment generation, writeback config filtering, deduplication, non-PRP passthrough |

### Edge Cases Checklist

- [ ] Session with no `prpPhase` in metadata — no PRP comment posted
- [ ] Non-PRP project with `prpPhase` in metadata — no PRP comment posted
- [ ] PRP project with `writeback.investigation: false` — investigation comment suppressed
- [ ] PRP project with `writeback.pr: false` — `pr_open` comment suppressed
- [ ] Same phase seen twice — comment posted only on first detection
- [ ] Session with no `issueId` — `writebackToTracker` returns early (existing guard)
- [ ] Unknown `prpPhase` value (e.g., `"unknown"`) — `getPrpWritebackComment` returns null

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
pnpm lint && pnpm typecheck
```

**EXPECT**: Exit 0, no errors

### Level 2: UNIT_TESTS

```bash
pnpm test -- packages/core/src/__tests__/lifecycle-manager.test.ts
```

**EXPECT**: All tests pass including new PRP writeback tests

### Level 3: FULL_SUITE

```bash
pnpm test && pnpm build
```

**EXPECT**: All tests pass, build succeeds

---

## Acceptance Criteria

- [ ] `prpPhase` transitions in session metadata trigger tracker comments
- [ ] Comments are phase-specific (different text for investigating, planning, implementing)
- [ ] `prp.writeback` config controls which phases produce comments
- [ ] Non-PRP projects are unaffected (no PRP comments, existing writeback unchanged)
- [ ] Same phase seen twice does not produce duplicate comments
- [ ] Level 1-3 validation commands pass with exit 0
- [ ] No regressions in existing tests

---

## Completion Checklist

- [ ] All tasks completed in dependency order
- [ ] Each task validated immediately after completion
- [ ] Level 1: Static analysis (lint + typecheck) passes
- [ ] Level 2: Unit tests pass
- [ ] Level 3: Full test suite + build succeeds
- [ ] All acceptance criteria met

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| `prpPhase` not yet set when lifecycle polls | LOW | LOW | No comment posted until phase detected — expected behavior |
| Hook only detects `investigating` and `planning` — `implementing` never fires | MED | LOW | Comment template exists but won't fire until hook is extended; acceptable for Phase 5 |
| Too many tracker comments annoy users | LOW | MED | `prp.writeback` config lets users disable specific phases; all default to true but are configurable |

---

## Notes

- The `implementing` phase is not currently detected by the metadata-updater hook (it only detects `investigating` and `planning` via artifact presence). The implementing comment template is defined but won't fire until the hook is extended in a future phase or the agent explicitly sets `prpPhase=implementing`.
- The `pr` phase writeback is already handled by the existing `pr_open` status transition in `getWritebackComment()`. Task 3 adds config-based suppression for PRP projects that set `writeback.pr: false`.
- PRP phase tracking uses a separate `prpPhases` map (not the `states` map) because phases change independently of `SessionStatus`.
