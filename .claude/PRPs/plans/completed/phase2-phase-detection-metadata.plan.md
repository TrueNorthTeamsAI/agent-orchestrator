# Feature: PRP Phase Detection & Metadata

## Summary

Extend the metadata-updater hook script to detect PRP artifact directories (`.claude/PRPs/investigations/`, `.claude/PRPs/plans/`) in the agent's workspace and write `prpPhase={phase}` to the session metadata file. Also wire `prpPhase` through the TypeScript metadata read/write functions so the lifecycle manager and dashboard can consume it. The `prpPhase` field already exists on the `SessionMetadata` interface (added in Phase 1) but is not yet read, written, or detected.

## User Story

As a developer using PRP-enabled auto-spawned agents
I want the orchestrator to automatically detect which PRP lifecycle phase an agent is in
So that I can see real-time progress (investigating → planning → implementing → pr_open) on the dashboard and in tracker comments without checking the agent's terminal

## Problem Statement

After Phase 3, agents receive PRP instructions and produce artifacts in `.claude/PRPs/`, but AO has no visibility into which phase the agent is in. The `prpPhase` field exists on `SessionMetadata` but nothing writes to it — the hook script only detects git/gh commands, not PRP artifact creation.

## Solution Statement

1. Add PRP artifact detection to the `METADATA_UPDATER_SCRIPT` bash hook — on every Bash tool call, check for the presence of files in `.claude/PRPs/investigations/` and `.claude/PRPs/plans/` directories and update `prpPhase` accordingly
2. Wire `prpPhase` through `readMetadata()` and `writeMetadata()` in `metadata.ts`
3. No lifecycle manager changes needed for this phase — the lifecycle manager already reads raw metadata via `readMetadataRaw()` → `metadataToSession()`, which stores all keys in `session.metadata`. Phase 5 (Tracker Writeback) and Phase 6 (Plan Gate) will consume `prpPhase` from there.

## Metadata

| Field            | Value                                                |
| ---------------- | ---------------------------------------------------- |
| Type             | ENHANCEMENT                                          |
| Complexity       | LOW                                                  |
| Systems Affected | metadata-updater hook, metadata.ts read/write        |
| Dependencies     | None (uses existing infrastructure)                  |
| Estimated Tasks  | 4                                                    |

---

## UX Design

### Before State
```
[Agent spawns with PRP instructions]
  → Agent runs /prp-issue-investigate
  → Agent runs /prp-plan
  → Agent runs /prp-ralph
  → Agent runs /prp-pr

Dashboard shows: status=working (never changes until PR opens)
Lifecycle manager: no idea which PRP phase agent is in
```

### After State
```
[Agent spawns with PRP instructions]
  → Agent runs /prp-issue-investigate
    → Hook detects .claude/PRPs/investigations/ files → prpPhase=investigating
  → Agent runs /prp-plan
    → Hook detects .claude/PRPs/plans/ files → prpPhase=planning
  → Agent runs /prp-ralph
    → prpPhase stays planning (implementation detection is implicit via status)
  → Agent runs /prp-pr → status=pr_open (existing)

Dashboard shows: prpPhase=investigating → planning (real-time)
Lifecycle manager: can trigger phase-specific reactions (Phase 6)
```

### Interaction Changes
| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| Session metadata file | No prpPhase key | `prpPhase=investigating\|planning` | Dashboard and API show PRP phase |
| `readMetadata()` | Returns no prpPhase | Returns `prpPhase` field | TypeScript consumers get typed field |
| `writeMetadata()` | Ignores prpPhase | Persists prpPhase | Full round-trip support |

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `packages/plugins/agent-claude-code/src/index.ts` | 31-167 | `METADATA_UPDATER_SCRIPT` — the bash hook to extend |
| P0 | `packages/core/src/metadata.ts` | 84-152 | `readMetadata` + `writeMetadata` — must add `prpPhase` |
| P1 | `packages/core/src/types.ts` | 999-1016 | `SessionMetadata` interface — `prpPhase` already declared |
| P1 | `packages/core/src/__tests__/metadata.test.ts` | all | Test patterns to FOLLOW |
| P2 | `packages/plugins/agent-claude-code/src/index.ts` | 497-575 | `setupHookInWorkspace` — how the hook gets deployed |

---

## Patterns to Mirror

**METADATA_READ_PATTERN:**
```typescript
// SOURCE: packages/core/src/metadata.ts:91-105
// COPY THIS PATTERN for adding prpPhase:
return {
  worktree: raw["worktree"] ?? "",
  branch: raw["branch"] ?? "",
  status: raw["status"] ?? "unknown",
  tmuxName: raw["tmuxName"],
  issue: raw["issue"],
  pr: raw["pr"],
  // ... existing fields ...
  // ADD: prpPhase: raw["prpPhase"],
};
```

**METADATA_WRITE_PATTERN:**
```typescript
// SOURCE: packages/core/src/metadata.ts:137-149
// COPY THIS PATTERN for adding prpPhase:
if (metadata.tmuxName) data["tmuxName"] = metadata.tmuxName;
if (metadata.issue) data["issue"] = metadata.issue;
// ... existing fields ...
// ADD: if (metadata.prpPhase) data["prpPhase"] = metadata.prpPhase;
```

**HOOK_COMMAND_DETECTION_PATTERN:**
```bash
# SOURCE: packages/plugins/agent-claude-code/src/index.ts:118-128
# COPY THIS PATTERN for PRP artifact detection:
# Detect: gh pr create
if [[ "$command" =~ ^gh[[:space:]]+pr[[:space:]]+create ]]; then
  pr_url=$(echo "$output" | grep -Eo 'https://github[.]com/[^/]+/[^/]+/pull/[0-9]+' | head -1)
  if [[ -n "$pr_url" ]]; then
    update_metadata_key "pr" "$pr_url"
    update_metadata_key "status" "pr_open"
    echo '{"systemMessage": "Updated metadata: PR created at '"$pr_url"'"}'
    exit 0
  fi
fi
```

**TEST_PATTERN:**
```typescript
// SOURCE: packages/core/src/__tests__/metadata.test.ts:27-40
// COPY THIS PATTERN:
describe("writeMetadata + readMetadata", () => {
  it("writes and reads basic metadata", () => {
    writeMetadata(dataDir, "app-1", {
      worktree: "/tmp/worktree",
      branch: "feat/test",
      status: "working",
    });
    const meta = readMetadata(dataDir, "app-1");
    expect(meta).not.toBeNull();
    expect(meta!.worktree).toBe("/tmp/worktree");
  });
});
```

---

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `packages/plugins/agent-claude-code/src/index.ts` | UPDATE | Add PRP artifact detection to `METADATA_UPDATER_SCRIPT` |
| `packages/core/src/metadata.ts` | UPDATE | Add `prpPhase` to `readMetadata()` and `writeMetadata()` |
| `packages/core/src/__tests__/metadata.test.ts` | UPDATE | Add tests for `prpPhase` round-trip |

---

## NOT Building (Scope Limits)

- **Lifecycle manager PRP phase reactions** — that's Phase 6 (Plan Gate); this phase only writes the data
- **Tracker writeback for PRP phases** — that's Phase 5; this phase provides the metadata they'll consume
- **New `SessionStatus` values** — PRD explicitly excludes this; `prpPhase` is a separate metadata field
- **PRP phase detection via polling/timer** — the hook fires on every Bash tool call, which is sufficient
- **Implementation phase detection** — the transition from `planning` to `implementing` is hard to detect via artifacts alone (ralph doesn't create a new directory); Phase 6 will handle this via gate resumption. For now, the hook detects `investigating` and `planning` only.

---

## Step-by-Step Tasks

### Task 1: UPDATE `packages/core/src/metadata.ts` — Add `prpPhase` to read/write

- **ACTION**: Add `prpPhase` field to `readMetadata()` return and `writeMetadata()` serialization
- **IMPLEMENT**:
  - In `readMetadata()` (~line 104), add: `prpPhase: raw["prpPhase"],`
  - In `writeMetadata()` (~line 149), add: `if (metadata.prpPhase) data["prpPhase"] = metadata.prpPhase;`
- **MIRROR**: Follow the exact pattern of other optional fields like `issue`, `pr`, `summary`
- **GOTCHA**: `prpPhase` is a string, not a number — no `Number()` conversion needed (unlike `dashboardPort`)
- **VALIDATE**: `pnpm typecheck`

### Task 2: UPDATE `packages/core/src/__tests__/metadata.test.ts` — Test prpPhase round-trip

- **ACTION**: Add test cases for `prpPhase` in metadata read/write
- **IMPLEMENT**:
  - Add a test in `writeMetadata + readMetadata` describe block: write metadata with `prpPhase: "investigating"`, read it back, verify it's present
  - Add a test: write metadata without `prpPhase`, verify it's `undefined` on read
  - Add a test in `updateMetadata` describe block: update with `{ prpPhase: "planning" }`, verify via `readMetadata`
- **MIRROR**: `packages/core/src/__tests__/metadata.test.ts:42-63` — follow the optional fields test pattern
- **VALIDATE**: `pnpm test packages/core/src/__tests__/metadata.test.ts`

### Task 3: UPDATE `packages/plugins/agent-claude-code/src/index.ts` — Add PRP artifact detection to hook

- **ACTION**: Extend `METADATA_UPDATER_SCRIPT` to detect PRP artifact directories and write `prpPhase`
- **IMPLEMENT**: After the existing command detection block (after the `gh pr merge` detection, before the "No matching command" comment at line ~164), add a new section:

```bash
# ============================================================================
# PRP Phase Detection (artifact-based)
# ============================================================================

# Detect PRP phase by checking for artifact directories in the workspace.
# The workspace root is derived from the worktree path in metadata.
# PRP artifacts are created in .claude/PRPs/ subdirectories.

# Read the worktree path from metadata to find the workspace
worktree=""
if [[ -f "$metadata_file" ]]; then
  worktree=$(grep "^worktree=" "$metadata_file" | cut -d'=' -f2-)
fi

if [[ -n "$worktree" ]]; then
  current_phase=""

  # Check for plan artifacts (plans/ takes priority — it means investigation is done)
  if [[ -d "$worktree/.claude/PRPs/plans" ]] && \
     [[ -n "$(ls -A "$worktree/.claude/PRPs/plans" 2>/dev/null)" ]]; then
    current_phase="planning"
  # Check for investigation artifacts
  elif [[ -d "$worktree/.claude/PRPs/investigations" ]] && \
       [[ -n "$(ls -A "$worktree/.claude/PRPs/investigations" 2>/dev/null)" ]]; then
    current_phase="investigating"
  fi

  # Only update if we detected a phase and it differs from current
  if [[ -n "$current_phase" ]]; then
    existing_phase=$(grep "^prpPhase=" "$metadata_file" | cut -d'=' -f2- || echo "")
    if [[ "$current_phase" != "$existing_phase" ]]; then
      update_metadata_key "prpPhase" "$current_phase"
      echo '{"systemMessage": "Updated metadata: prpPhase = '"$current_phase"'"}'
      exit 0
    fi
  fi
fi
```

- **MIRROR**: Follow the existing detection pattern (check condition → `update_metadata_key` → echo systemMessage → exit 0)
- **GOTCHA**: The PRP detection must run AFTER command-specific detections (like `gh pr create` which sets `status=pr_open`), not before. The `gh pr create` detection already `exit 0`s, so PRP detection won't conflict.
- **GOTCHA**: The workspace path comes from the `worktree` field in the metadata file itself — the hook doesn't have a `WORKSPACE_PATH` env var. Read it from the metadata file.
- **GOTCHA**: Use `ls -A` to check for non-empty directory (not just `[ -d ]` which is true for empty dirs)
- **GOTCHA**: Don't update if phase hasn't changed — avoids unnecessary file writes on every Bash call
- **VALIDATE**: `pnpm typecheck` (the script is a string constant, so TS won't catch bash errors — manually verify the bash logic)

### Task 4: Manual verification of hook behavior

- **ACTION**: Verify the hook script logic by examining the complete updated `METADATA_UPDATER_SCRIPT`
- **IMPLEMENT**: Read through the full updated script to verify:
  - PRP detection section is after all command-specific detections
  - No early `exit 0` before PRP detection (except in command-specific blocks that already matched)
  - The `worktree` path read from metadata is correct
  - Phase priority is correct: `planning` > `investigating` (agent progresses forward)
  - Empty directory check works correctly
- **VALIDATE**: `pnpm build && pnpm typecheck && pnpm lint`

---

## Testing Strategy

### Unit Tests to Write

| Test File | Test Cases | Validates |
|-----------|------------|-----------|
| `packages/core/src/__tests__/metadata.test.ts` | prpPhase write+read round-trip, prpPhase undefined when not set, prpPhase update via updateMetadata | metadata.ts prpPhase support |

### Edge Cases Checklist

- [ ] `prpPhase` not set → `readMetadata` returns `undefined` for `prpPhase`
- [ ] `prpPhase` set to `"investigating"` → round-trips through write/read
- [ ] `prpPhase` updated from `"investigating"` to `"planning"` via `updateMetadata`
- [ ] Empty `.claude/PRPs/investigations/` directory → no phase detected (requires files inside)
- [ ] Both `investigations/` and `plans/` have files → `planning` wins (most advanced phase)
- [ ] No `.claude/PRPs/` directory at all → no phase update
- [ ] `worktree` field missing from metadata → hook skips PRP detection gracefully

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
pnpm lint && pnpm typecheck
```

**EXPECT**: Exit 0, no errors

### Level 2: UNIT_TESTS

```bash
pnpm test packages/core/src/__tests__/metadata.test.ts
```

**EXPECT**: All tests pass including new prpPhase tests

### Level 3: FULL_SUITE

```bash
pnpm test && pnpm build
```

**EXPECT**: All tests pass, build succeeds

---

## Acceptance Criteria

- [ ] `readMetadata()` returns `prpPhase` field when present in metadata file
- [ ] `writeMetadata()` persists `prpPhase` field when set
- [ ] `METADATA_UPDATER_SCRIPT` detects `.claude/PRPs/investigations/` files → writes `prpPhase=investigating`
- [ ] `METADATA_UPDATER_SCRIPT` detects `.claude/PRPs/plans/` files → writes `prpPhase=planning`
- [ ] Hook does NOT update `prpPhase` when it hasn't changed (avoids unnecessary writes)
- [ ] All existing metadata tests still pass
- [ ] `pnpm build && pnpm typecheck && pnpm lint` pass

---

## Completion Checklist

- [ ] Task 1: `metadata.ts` updated with prpPhase read/write
- [ ] Task 2: Metadata tests added and passing
- [ ] Task 3: Hook script extended with PRP artifact detection
- [ ] Task 4: Full build + lint + typecheck pass
- [ ] Level 1: Static analysis passes
- [ ] Level 2: Unit tests pass
- [ ] Level 3: Full suite + build passes

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Hook fires on every Bash call — PRP directory check adds latency | LOW | LOW | `ls -A` on local filesystem is <1ms; only runs if `worktree` is set |
| Hook script bash syntax error (it's a TS string, not linted) | MED | MED | Manually review the script; integration test with real workspace would catch this |
| Worktree path in metadata doesn't match actual workspace | LOW | LOW | Worktree path is written at spawn time and doesn't change; graceful fallback (skip detection) |

---

## Notes

- **Phase ordering**: `investigating` → `planning` is deterministic because agents follow the PRP lifecycle in order. The hook checks `plans/` first (higher priority) then `investigations/`.
- **No `implementing` phase detection**: The transition from `planning` to `implementing` happens when the agent starts `/prp-ralph`, which doesn't create a new artifact directory. Phase 6 (Plan Gate) will handle this by detecting gate approval → setting `prpPhase=implementing`. For non-gated projects, `planning` remains the last detected phase until `pr_open`.
- **Backward compatibility**: Sessions without PRP (no `prpPhase` key in metadata file) are unaffected — `readMetadata` returns `undefined` for `prpPhase`, and the hook only runs PRP detection when `worktree` is set in metadata.
