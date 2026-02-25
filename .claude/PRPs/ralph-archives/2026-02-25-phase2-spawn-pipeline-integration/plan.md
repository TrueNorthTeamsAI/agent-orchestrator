# Feature: Spawn Pipeline Integration — PRP Lifecycle

## Summary

Wire PRP methodology into the agent spawn pipeline. When a project has `prp.enabled: true`, the `spawn()` function writes a PRP system prompt file to disk, sets `systemPromptFile` in `AgentLaunchConfig`, and symlinks the PRP plugin's `.claude/` directory into the workspace. This connects the Phase 1 (types/config) and Phase 2 (prompt template) work to the actual spawn flow — agents launched on PRP-enabled projects will receive structured PRP instructions via `--append-system-prompt`.

## User Story

As a developer using Agent Orchestrator
I want auto-spawned agents to receive PRP lifecycle instructions and have the PRP plugin available
So that agents follow the structured investigate → plan → implement → PR → review lifecycle automatically

## Problem Statement

`spawn()` in `session-manager.ts` never sets `systemPromptFile` — the field exists on `AgentLaunchConfig` but is only populated in `spawnOrchestrator()`. The PRP config type and prompt template exist (Phases 1-2) but nothing reads them during spawn.

## Solution Statement

Insert PRP-aware logic between workspace creation (line 428) and agent launch config assembly (line 450) in `spawn()`. When `project.prp?.enabled` and `issueId` are present: (1) call `buildPrpPrompt()` to generate the prompt string, (2) write it to a file using the existing `getProjectBaseDir()` pattern, (3) set `systemPromptFile` on the launch config. For PRP plugin delivery, symlink `pluginPath/.claude/` into the workspace after `postCreate`.

## Metadata

| Field            | Value                                          |
| ---------------- | ---------------------------------------------- |
| Type             | ENHANCEMENT                                    |
| Complexity       | LOW                                            |
| Systems Affected | session-manager, workspace-worktree (optional) |
| Dependencies     | None (all internal)                            |
| Estimated Tasks  | 4                                              |

---

## UX Design

### Before State
```
Developer labels issue → webhook → spawn() →
  workspace created → generic prompt built → agent launches with -p "Work on #42"
  → agent improvises → inconsistent PR quality
```

### After State
```
Developer labels issue → webhook → spawn() →
  workspace created → PRP plugin symlinked into workspace →
  PRP prompt file written → agent launches with
    --append-system-prompt "$(cat prp-prompt.md)" -p "investigate #42 using PRP"
  → agent follows PRP lifecycle → consistent, artifact-backed PRs
```

### Interaction Changes
| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| Agent session | Generic prompt only | PRP system prompt + generic prompt | Agent follows structured lifecycle |
| Workspace | No PRP plugin | `.claude/` symlinked from PRP plugin | PRP commands available to agent |
| Config | `prp` section unused at spawn | `prp.enabled` gates PRP injection | Opt-in per project |

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `packages/core/src/session-manager.ts` | 390-470 | The spawn flow where PRP logic inserts |
| P0 | `packages/core/src/session-manager.ts` | 586-604 | `spawnOrchestrator()` pattern to MIRROR for systemPromptFile |
| P0 | `packages/core/src/prp-prompt-template.ts` | 15-24, 78-124 | `buildPrpPrompt()` signature and behavior |
| P1 | `packages/core/src/types.ts` | 316-344 | `AgentLaunchConfig` with `systemPromptFile` field |
| P1 | `packages/core/src/types.ts` | 855-866 | `PrpConfig` interface |
| P1 | `packages/plugins/agent-claude-code/src/index.ts` | 599-606 | How `systemPromptFile` becomes `--append-system-prompt` |
| P2 | `packages/plugins/workspace-worktree/src/index.ts` | 249-297 | `postCreate()` symlink mechanism |
| P2 | `packages/core/src/__tests__/session-manager.test.ts` | 35-130 | Test infrastructure and mock patterns |

---

## Patterns to Mirror

**SYSTEM_PROMPT_FILE_WRITE:**
```typescript
// SOURCE: packages/core/src/session-manager.ts:586-604
// COPY THIS PATTERN for PRP prompt file:
let systemPromptFile: string | undefined;
if (orchestratorConfig.systemPrompt) {
  const baseDir = getProjectBaseDir(config.configPath, project.path);
  mkdirSync(baseDir, { recursive: true });
  systemPromptFile = join(baseDir, "orchestrator-prompt.md");
  writeFileSync(systemPromptFile, orchestratorConfig.systemPrompt, "utf-8");
}
```

**AGENT_LAUNCH_CONFIG:**
```typescript
// SOURCE: packages/core/src/session-manager.ts:450-457
// ADD systemPromptFile to this object:
const agentLaunchConfig = {
  sessionId,
  projectConfig: project,
  issueId: spawnConfig.issueId,
  prompt: composedPrompt ?? spawnConfig.prompt,
  permissions: project.agentConfig?.permissions,
  model: project.agentConfig?.model,
  // systemPromptFile,  <-- ADD THIS
};
```

**BUILD_PRP_PROMPT CALL:**
```typescript
// SOURCE: packages/core/src/prp-prompt-template.ts:78
// Call signature:
buildPrpPrompt({
  prp: project.prp,    // PrpConfig
  issueId: "#42",       // string
  projectName: "My App" // string
})
// Returns: string (markdown prompt content)
```

**TEST_PATTERN:**
```typescript
// SOURCE: packages/core/src/__tests__/session-manager.test.ts:52-55
mockAgent = {
  name: "mock-agent",
  processName: "mock",
  getLaunchCommand: vi.fn().mockReturnValue("mock-agent --start"),
  // ... assert getLaunchCommand was called with config containing systemPromptFile
};
```

---

## Files to Change

| File | Action | Justification |
| ---- | ------ | ------------- |
| `packages/core/src/session-manager.ts` | UPDATE | Add PRP prompt file write + systemPromptFile to agentLaunchConfig + PRP plugin symlink |
| `packages/core/src/__tests__/session-manager.test.ts` | UPDATE | Add tests for PRP-enabled spawn flow |

---

## NOT Building (Scope Limits)

- **PRP plugin symlink via workspace plugin changes** — symlink directly in `spawn()` using `symlinkSync` rather than modifying workspace-worktree plugin. The workspace `postCreate` has already run by the time we check PRP config. Doing it in spawn keeps the change localized.
- **Custom prompt file support** (`prp.promptFile` override) — the config field exists but reading a custom file is Phase 3+ polish; use `buildPrpPrompt()` for now.
- **PRP without issueId** — `buildPrpPrompt` requires `issueId`. Spawns without an issue skip PRP (agents need an issue to investigate).
- **Fallback to generic prompt if PRP plugin missing** — Phase 7 (integration testing) scope; for now trust the config.

---

## Step-by-Step Tasks

### Task 1: ADD import for `buildPrpPrompt` in session-manager.ts

- **ACTION**: Add import statement
- **IMPLEMENT**: Add `import { buildPrpPrompt } from "./prp-prompt-template.js";` near the existing `buildPrompt` import at line 50
- **MIRROR**: Line 50 import style: `import { buildPrompt } from "./prompt-builder.js";`
- **VALIDATE**: `pnpm typecheck`

### Task 2: ADD PRP prompt file write and systemPromptFile to spawn()

- **ACTION**: Insert PRP logic between workspace creation (after line 428) and agentLaunchConfig assembly (line 450)
- **IMPLEMENT**:
  ```typescript
  // After workspace creation (line 428), before prompt generation (line 430):

  // Write PRP system prompt file when PRP is enabled and we have an issue
  let systemPromptFile: string | undefined;
  if (project.prp?.enabled && spawnConfig.issueId) {
    const prpPrompt = buildPrpPrompt({
      prp: project.prp,
      issueId: spawnConfig.issueId,
      projectName: project.name ?? spawnConfig.projectId,
    });
    const baseDir = getProjectBaseDir(config.configPath, project.path);
    mkdirSync(baseDir, { recursive: true });
    systemPromptFile = join(baseDir, `prp-prompt-${sessionId}.md`);
    writeFileSync(systemPromptFile, prpPrompt, "utf-8");
  }
  ```
  Then add `systemPromptFile` to the `agentLaunchConfig` object at line 450-457:
  ```typescript
  const agentLaunchConfig = {
    sessionId,
    projectConfig: project,
    issueId: spawnConfig.issueId,
    prompt: composedPrompt ?? spawnConfig.prompt,
    permissions: project.agentConfig?.permissions,
    model: project.agentConfig?.model,
    systemPromptFile,
  };
  ```
- **MIRROR**: `packages/core/src/session-manager.ts:586-604` (spawnOrchestrator pattern)
- **IMPORTS**: `buildPrpPrompt` from `./prp-prompt-template.js` (Task 1); `getProjectBaseDir` already imported at line 53; `writeFileSync`, `mkdirSync` already imported at line 14; `join` already imported at line 15
- **GOTCHA**: Use `sessionId` in filename (`prp-prompt-${sessionId}.md`) to avoid collisions when multiple sessions spawn for the same project. The orchestrator uses a static `orchestrator-prompt.md` name but there's only one orchestrator per project.
- **GOTCHA**: `project.name` may be undefined — fall back to `spawnConfig.projectId` (same pattern as `buildConfigLayer` in `prompt-builder.ts:72`)
- **VALIDATE**: `pnpm typecheck`

### Task 3: ADD PRP plugin symlink in spawn()

- **ACTION**: After `postCreate` completes and before agent launch, symlink PRP plugin's `.claude/` into workspace
- **IMPLEMENT**:
  ```typescript
  // After postCreate block (line 418), still inside the workspace creation try block:

  // Symlink PRP plugin into workspace when enabled
  if (project.prp?.enabled && project.prp.pluginPath && workspacePath !== project.path) {
    const prpClaudeSource = join(project.prp.pluginPath, ".claude");
    if (existsSync(prpClaudeSource)) {
      const prpClaudeTarget = join(workspacePath, ".claude");
      // Remove existing .claude if present (worktree may inherit one)
      try {
        const stat = lstatSync(prpClaudeTarget);
        if (stat.isSymbolicLink() || stat.isFile() || stat.isDirectory()) {
          rmSync(prpClaudeTarget, { recursive: true, force: true });
        }
      } catch {
        // Doesn't exist — fine
      }
      symlinkSync(prpClaudeSource, prpClaudeTarget);
    }
  }
  ```
- **IMPORTS**: Add `lstatSync`, `rmSync`, `symlinkSync` to the `node:fs` import at line 14. Add `existsSync` if not already imported (check — it IS already imported via the existing `existsSync` usage).
- **MIRROR**: `packages/plugins/workspace-worktree/src/index.ts:274-286` (symlink with remove-existing pattern)
- **GOTCHA**: Only symlink when `workspacePath !== project.path` — never modify the main repo directory. This guard prevents corrupting the original project's `.claude/` directory.
- **GOTCHA**: `pluginPath` is already `~`-expanded by `expandPaths()` in `config.ts:173-181`. No need to expand again.
- **GOTCHA**: The `agent.postLaunchSetup()` at line 510+ writes `.claude/settings.json` into the workspace for the metadata-updater hook. If we symlink `.claude/` as a directory, `postLaunchSetup` will write into the symlink target (the PRP plugin source). **MITIGATION**: Symlink individual subdirectories (`.claude/skills/`, `.claude/rules/`) instead of the whole `.claude/` directory. Or: symlink `.claude/` first, then `postLaunchSetup` will correctly write inside it (acceptable since worktree `.claude/` is ephemeral). **DECISION**: Symlink the whole `.claude/` directory — `postLaunchSetup` writes into the workspace's `.claude/` which is fine since worktrees are disposable. If `.claude/` is a symlink, writes go to the PRP plugin source which is undesirable. **REVISED**: Copy `.claude/` contents or symlink subdirectories individually. Actually, re-reading `postLaunchSetup` — it writes `.claude/settings.json` inside the workspace. If `.claude/` is a symlink to the PRP plugin source, this would modify the PRP plugin's `settings.json`. **FINAL DECISION**: Instead of symlinking `.claude/`, symlink specific PRP subdirectories: `.claude/skills/` and `.claude/rules/` (if they exist). This preserves the workspace's own `.claude/settings.json` for hooks.
- **REVISED IMPLEMENTATION**:
  ```typescript
  // Symlink PRP plugin skill/rule directories into workspace when enabled
  if (project.prp?.enabled && project.prp.pluginPath && workspacePath !== project.path) {
    const prpPluginPath = project.prp.pluginPath;
    const prpSubdirs = [".claude/skills", ".claude/rules"];
    for (const subdir of prpSubdirs) {
      const sourcePath = join(prpPluginPath, subdir);
      if (!existsSync(sourcePath)) continue;

      const targetPath = join(workspacePath, subdir);
      // Remove existing if present
      try {
        lstatSync(targetPath);
        rmSync(targetPath, { recursive: true, force: true });
      } catch {
        // Doesn't exist — fine
      }
      mkdirSync(dirname(targetPath), { recursive: true });
      symlinkSync(sourcePath, targetPath);
    }
  }
  ```
- **IMPORTS**: Add `dirname` to `node:path` import (line 15). Add `lstatSync`, `rmSync`, `symlinkSync` to `node:fs` import (line 14).
- **VALIDATE**: `pnpm typecheck`

### Task 4: ADD tests for PRP spawn pipeline

- **ACTION**: Add test cases to `session-manager.test.ts`
- **IMPLEMENT**: Add a describe block `"PRP lifecycle integration"` with these tests:
  1. **"sets systemPromptFile when PRP enabled and issueId present"** — configure project with `prp: { enabled: true, gates: { plan: false, pr: false }, writeback: {...}, pluginPath: undefined }`, spawn with `issueId: "#42"`, assert `mockAgent.getLaunchCommand` was called with an object containing a `systemPromptFile` property that is a string (file path).
  2. **"does not set systemPromptFile when PRP disabled"** — `prp: { enabled: false }` or `prp: undefined`, assert `getLaunchCommand` called with `systemPromptFile` being `undefined`.
  3. **"does not set systemPromptFile when no issueId"** — PRP enabled but no `issueId` in spawn config, assert `systemPromptFile` is `undefined`.
  4. **"PRP prompt file contains issue ID"** — Read the file at the `systemPromptFile` path after spawn, assert it contains `#42` and `PRP Methodology`.
  5. **"symlinks PRP plugin subdirectories when pluginPath set"** — Create mock PRP plugin dir with `.claude/skills/` and `.claude/rules/`, set `pluginPath`, assert symlinks exist in workspace after spawn.
- **MIRROR**: Existing test structure in `session-manager.test.ts` — `describe`/`it` blocks, `vi.fn()` mocks, `beforeEach` cleanup
- **GOTCHA**: The `mockWorkspace.create` returns `{ path: "/tmp/mock-ws/app-1" }` — ensure that path exists via `mkdirSync` in the test setup for symlink tests. Also create the mock PRP plugin directory.
- **VALIDATE**: `pnpm test packages/core/src/__tests__/session-manager.test.ts`

---

## Testing Strategy

### Unit Tests to Write

| Test File | Test Cases | Validates |
| --------- | ---------- | --------- |
| `packages/core/src/__tests__/session-manager.test.ts` | PRP systemPromptFile set/unset, file content, symlinks | Spawn pipeline integration |

### Edge Cases Checklist

- [ ] PRP enabled but no issueId → skip PRP prompt (no crash)
- [ ] PRP enabled but no pluginPath → skip symlinks (prompt still written)
- [ ] PRP disabled → no systemPromptFile, no symlinks
- [ ] No prp config at all (undefined) → unchanged behavior
- [ ] pluginPath points to dir without `.claude/skills/` → skip that symlink silently
- [ ] Multiple sessions for same project → unique prompt files (sessionId in filename)

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
pnpm lint && pnpm typecheck
```

**EXPECT**: Exit 0, no errors

### Level 2: UNIT_TESTS

```bash
pnpm test packages/core/src/__tests__/session-manager.test.ts
pnpm test packages/core/src/__tests__/prp-prompt-template.test.ts
```

**EXPECT**: All tests pass

### Level 3: FULL_SUITE

```bash
pnpm test && pnpm build
```

**EXPECT**: All tests pass, build succeeds

---

## Acceptance Criteria

- [ ] `spawn()` with PRP-enabled project + issueId produces `systemPromptFile` in `AgentLaunchConfig`
- [ ] The PRP prompt file contains PRP lifecycle instructions and the issue ID
- [ ] `spawn()` without PRP config or without issueId behaves identically to before
- [ ] PRP plugin subdirectories (`.claude/skills/`, `.claude/rules/`) are symlinked when `pluginPath` is set
- [ ] All existing tests still pass (no regressions)
- [ ] New tests cover PRP-enabled and PRP-disabled paths

---

## Completion Checklist

- [ ] All tasks completed in dependency order (1 → 2 → 3 → 4)
- [ ] Each task validated immediately after completion
- [ ] Level 1: Static analysis (lint + typecheck) passes
- [ ] Level 2: Unit tests pass
- [ ] Level 3: Full test suite + build succeeds
- [ ] All acceptance criteria met

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| `postLaunchSetup` writes to symlinked `.claude/` | HIGH | MED | Symlink subdirs (skills/, rules/) not the whole .claude/ directory |
| PRP prompt file collision between sessions | LOW | LOW | Include sessionId in filename: `prp-prompt-{sessionId}.md` |
| `existsSync` check on pluginPath races with deletion | LOW | LOW | Config is trusted; pluginPath is validated at config load time |

---

## Notes

- This is a pure wiring task — no new types, no new interfaces, no new config fields. All building blocks exist from Phases 1-2.
- The PRP prompt goes via `systemPromptFile` → `--append-system-prompt "$(cat file)"` which survives Claude Code's context compaction (unlike the `-p` prompt which is a user turn).
- The `-p` prompt (from `buildPrompt()`) still includes the generic base prompt and issue context. The PRP system prompt is additive — it layers on top via `--append-system-prompt`.
- After this phase, Phases 4 (Phase Detection) and 5 (Tracker Writeback) can run in parallel.
