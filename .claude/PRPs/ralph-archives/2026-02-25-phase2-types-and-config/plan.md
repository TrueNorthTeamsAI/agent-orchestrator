# Feature: PRP Lifecycle — Types & Config (Phase 1)

## Summary

Add the `PrpConfig` type, Zod schemas, and config integration so projects can opt into PRP lifecycle mode via `prp:` in their YAML config. Also add `prpPhase` to `SessionMetadata` for later phases to use. This is pure types + config — no runtime behavior changes.

## User Story

As a developer configuring Agent Orchestrator
I want to add a `prp` section to my project config
So that later phases can detect PRP-enabled projects and inject methodology instructions

## Problem Statement

There is no config model for PRP lifecycle settings. Without it, Phases 2-7 cannot determine whether a project uses PRP mode, where the PRP plugin lives, which gates are enabled, or which phases should trigger tracker writeback.

## Solution Statement

Add `PrpConfig` interface to `types.ts`, corresponding Zod schemas to `config.ts`, extend `ProjectConfig` with `prp?: PrpConfig`, extend `SessionMetadata` with `prpPhase?: string`, and update `agent-orchestrator.yaml.example` with commented PRP config.

## Metadata

| Field            | Value                              |
| ---------------- | ---------------------------------- |
| Type             | NEW_CAPABILITY                     |
| Complexity       | LOW                                |
| Systems Affected | core/types, core/config, yaml example |
| Dependencies     | zod (already in use)               |
| Estimated Tasks  | 5                                  |

---

## UX Design

### Before State
```
╔═══════════════════════════════════════════════════════════════╗
║  agent-orchestrator.yaml                                     ║
║  projects:                                                   ║
║    my-app:                                                   ║
║      repo: org/my-app                                        ║
║      path: ~/my-app                                          ║
║      # No PRP config available                               ║
║                                                              ║
║  SessionMetadata: { worktree, branch, status, ... }          ║
║  No prpPhase field — lifecycle can't track PRP progress      ║
╚═══════════════════════════════════════════════════════════════╝
```

### After State
```
╔═══════════════════════════════════════════════════════════════╗
║  agent-orchestrator.yaml                                     ║
║  projects:                                                   ║
║    my-app:                                                   ║
║      repo: org/my-app                                        ║
║      path: ~/my-app                                          ║
║      prp:                          ◄── NEW                   ║
║        enabled: true                                         ║
║        pluginPath: ~/code/PRPs-agentic-sdlc-starter          ║
║        gates:                                                ║
║          plan: false                                         ║
║          pr: false                                           ║
║        writeback:                                            ║
║          investigation: true                                 ║
║          plan: true                                          ║
║          implementation: true                                ║
║          pr: true                                            ║
║                                                              ║
║  SessionMetadata: { ..., prpPhase?: string }  ◄── NEW field  ║
╚═══════════════════════════════════════════════════════════════╝
```

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `packages/core/src/types.ts` | 838-895 | `ProjectConfig` interface — add `prp` field here |
| P0 | `packages/core/src/types.ts` | 966-981 | `SessionMetadata` interface — add `prpPhase` field here |
| P0 | `packages/core/src/config.ts` | 25-136 | All Zod schemas — mirror pattern for PRP schemas |
| P1 | `packages/core/src/__tests__/config-validation.test.ts` | all | Test pattern to FOLLOW |
| P1 | `agent-orchestrator.yaml.example` | 26-86 | YAML format to extend with PRP section |

---

## Patterns to Mirror

**ZOD_NESTED_SCHEMA:**
```typescript
// SOURCE: packages/core/src/config.ts:25-42 (ReactionConfigSchema)
const ReactionConfigSchema = z.object({
  auto: z.boolean().default(true),
  action: z.enum(["send-to-agent", "notify", "auto-merge"]).default("notify"),
  message: z.string().optional(),
  priority: z.enum(["urgent", "action", "warning", "info"]).optional(),
  retries: z.number().optional(),
  escalateAfter: z.union([z.number(), z.string()]).optional(),
  threshold: z.string().optional(),
  includeSummary: z.boolean().optional(),
});
```

**PROJECT_CONFIG_FIELD_ADDITION:**
```typescript
// SOURCE: packages/core/src/config.ts:88-111 (ProjectConfigSchema)
// Pattern: add optional field with schema reference
  triggers: z.array(TriggerRuleSchema).optional(),
  // NEW fields follow this exact pattern
```

**INTERFACE_FIELD_ADDITION:**
```typescript
// SOURCE: packages/core/src/types.ts:893-894
  /** Trigger rules — when to auto-spawn */
  triggers?: TriggerRule[];
  // NEW fields follow this exact pattern with JSDoc
```

**TEST_PATTERN:**
```typescript
// SOURCE: packages/core/src/__tests__/config-validation.test.ts:277-321
describe("Config Schema Validation", () => {
  it("requires projects field", () => {
    const config = { /* ... */ };
    expect(() => validateConfig(config)).toThrow();
  });
});
```

---

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `packages/core/src/types.ts` | UPDATE | Add `PrpGates`, `PrpWriteback`, `PrpConfig` interfaces; add `prp?` to `ProjectConfig`; add `prpPhase?` to `SessionMetadata` |
| `packages/core/src/config.ts` | UPDATE | Add `PrpGatesSchema`, `PrpWritebackSchema`, `PrpConfigSchema` Zod schemas; add `prp` to `ProjectConfigSchema` |
| `agent-orchestrator.yaml.example` | UPDATE | Add commented PRP config section to project example |
| `packages/core/src/__tests__/config-validation.test.ts` | UPDATE | Add PRP config validation tests |
| `packages/core/src/__tests__/prompt-builder.test.ts` | UPDATE | Verify existing tests still pass with PRP fields on ProjectConfig (may need no changes) |

---

## NOT Building (Scope Limits)

- **No prompt template** — that's Phase 2
- **No spawn pipeline changes** — that's Phase 3
- **No metadata-updater.sh changes** — that's Phase 4
- **No writeback changes** — that's Phase 5
- **No gate logic** — that's Phase 6
- **No runtime behavior** — this phase is pure types and config schema

---

## Step-by-Step Tasks

### Task 1: ADD PRP interfaces to `packages/core/src/types.ts`

- **ACTION**: ADD three interfaces before `ProjectConfig` and extend both `ProjectConfig` and `SessionMetadata`
- **IMPLEMENT**:
  ```typescript
  // Add after line 836 (after DefaultPlugins), before ProjectConfig

  /** PRP gate configuration — which phases require human approval */
  export interface PrpGates {
    /** Pause after plan creation for human approval */
    plan: boolean;
    /** Pause after PR creation for human review */
    pr: boolean;
  }

  /** PRP writeback configuration — which phases post tracker comments */
  export interface PrpWriteback {
    investigation: boolean;
    plan: boolean;
    implementation: boolean;
    pr: boolean;
  }

  /** PRP lifecycle configuration for a project */
  export interface PrpConfig {
    /** Enable PRP lifecycle for this project */
    enabled: boolean;
    /** Path to PRP plugin installation (skills, hooks, etc.) */
    pluginPath?: string;
    /** Human approval gates */
    gates: PrpGates;
    /** Which phases trigger tracker writeback comments */
    writeback: PrpWriteback;
    /** Path to custom PRP prompt template; null = use built-in */
    promptFile?: string | null;
  }
  ```
- **ALSO**: Add to `ProjectConfig` (after `triggers` at line 894):
  ```typescript
    /** PRP lifecycle configuration */
    prp?: PrpConfig;
  ```
- **ALSO**: Add to `SessionMetadata` (after `directTerminalWsPort` at line 980):
  ```typescript
    /** Current PRP lifecycle phase (investigating, planning, implementing, etc.) */
    prpPhase?: string;
  ```
- **MIRROR**: Interface pattern from `types.ts:897-917` (TrackerConfig, SCMConfig, AgentSpecificConfig)
- **VALIDATE**: `pnpm typecheck`

### Task 2: ADD PRP Zod schemas to `packages/core/src/config.ts`

- **ACTION**: ADD three Zod schemas before `ProjectConfigSchema` and extend the project schema
- **IMPLEMENT**:
  ```typescript
  // Add after AgentSpecificConfigSchema (line 86), before ProjectConfigSchema (line 88)

  const PrpGatesSchema = z.object({
    plan: z.boolean().default(false),
    pr: z.boolean().default(false),
  });

  const PrpWritebackSchema = z.object({
    investigation: z.boolean().default(true),
    plan: z.boolean().default(true),
    implementation: z.boolean().default(true),
    pr: z.boolean().default(true),
  });

  const PrpConfigSchema = z.object({
    enabled: z.boolean().default(false),
    pluginPath: z.string().optional(),
    gates: PrpGatesSchema.default({}),
    writeback: PrpWritebackSchema.default({}),
    promptFile: z.string().nullable().default(null),
  });
  ```
- **ALSO**: Add to `ProjectConfigSchema` (before the closing `});` at line 111):
  ```typescript
    prp: PrpConfigSchema.optional(),
  ```
- **MIRROR**: Nested schema pattern from `config.ts:25-42` (ReactionConfigSchema with defaults)
- **VALIDATE**: `pnpm typecheck`

### Task 3: UPDATE `agent-orchestrator.yaml.example`

- **ACTION**: ADD commented PRP config section to the project example
- **IMPLEMENT**: Add after the `reactions` section (after line 85), before `# Notification channels`:
  ```yaml
    # PRP lifecycle integration (structured agent methodology)
    # prp:
    #   enabled: true
    #   pluginPath: ~/code/PRPs-agentic-sdlc-starter
    #   gates:
    #     plan: false          # Pause after plan creation for human approval
    #     pr: false            # Pause after PR creation for human review
    #   writeback:
    #     investigation: true  # Post summary when investigation completes
    #     plan: true           # Post plan link when plan is created
    #     implementation: true # Post progress during ralph loop
    #     pr: true             # Post PR link when PR is created
    #   # promptFile: null     # Path to custom PRP prompt; null = use built-in
  ```
- **MIRROR**: Existing commented config pattern from `agent-orchestrator.yaml.example:41-85`
- **VALIDATE**: Visual inspection — commented YAML must be valid if uncommented

### Task 4: ADD PRP config validation tests

- **ACTION**: ADD test describe block to `packages/core/src/__tests__/config-validation.test.ts`
- **IMPLEMENT**:
  ```typescript
  describe("Config Validation - PRP Config", () => {
    it("accepts project without prp config (backward compatible)", () => {
      const config = {
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
          },
        },
      };
      const validated = validateConfig(config);
      expect(validated.projects.proj1.prp).toBeUndefined();
    });

    it("accepts minimal prp config (enabled only)", () => {
      const config = {
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
            prp: { enabled: true },
          },
        },
      };
      const validated = validateConfig(config);
      expect(validated.projects.proj1.prp?.enabled).toBe(true);
      expect(validated.projects.proj1.prp?.gates.plan).toBe(false);
      expect(validated.projects.proj1.prp?.gates.pr).toBe(false);
      expect(validated.projects.proj1.prp?.writeback.investigation).toBe(true);
    });

    it("accepts full prp config", () => {
      const config = {
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
            prp: {
              enabled: true,
              pluginPath: "~/code/prp-plugin",
              gates: { plan: true, pr: false },
              writeback: { investigation: true, plan: true, implementation: false, pr: true },
              promptFile: "/path/to/prompt.md",
            },
          },
        },
      };
      const validated = validateConfig(config);
      expect(validated.projects.proj1.prp?.gates.plan).toBe(true);
      expect(validated.projects.proj1.prp?.writeback.implementation).toBe(false);
      expect(validated.projects.proj1.prp?.promptFile).toBe("/path/to/prompt.md");
    });

    it("applies defaults for gates and writeback", () => {
      const config = {
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
            prp: { enabled: true, gates: {}, writeback: {} },
          },
        },
      };
      const validated = validateConfig(config);
      expect(validated.projects.proj1.prp?.gates).toEqual({ plan: false, pr: false });
      expect(validated.projects.proj1.prp?.writeback).toEqual({
        investigation: true,
        plan: true,
        implementation: true,
        pr: true,
      });
    });

    it("accepts null promptFile", () => {
      const config = {
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
            prp: { enabled: true, promptFile: null },
          },
        },
      };
      const validated = validateConfig(config);
      expect(validated.projects.proj1.prp?.promptFile).toBeNull();
    });
  });
  ```
- **MIRROR**: Test pattern from `config-validation.test.ts:277-321`
- **VALIDATE**: `pnpm test packages/core/src/__tests__/config-validation.test.ts`

### Task 5: VERIFY full validation suite passes

- **ACTION**: Run the complete validation chain
- **VALIDATE**: `pnpm lint && pnpm typecheck && pnpm test`
- **GOTCHA**: If `expandPaths` doesn't handle the `prp.pluginPath` field, add `~` expansion for it in the `expandPaths` function. Check `config.ts` `expandPaths` to see if it iterates known path fields or uses a generic approach.

---

## Testing Strategy

### Unit Tests to Write

| Test File | Test Cases | Validates |
|-----------|------------|-----------|
| `packages/core/src/__tests__/config-validation.test.ts` | backward compat, minimal PRP, full PRP, defaults, null promptFile | Zod schemas + type integration |

### Edge Cases Checklist

- [ ] Project without `prp` field (backward compatibility)
- [ ] `prp: { enabled: true }` with all other fields defaulted
- [ ] `prp: { enabled: false }` (explicitly disabled)
- [ ] `prp.promptFile: null` (nullable, not optional)
- [ ] Full PRP config with all fields populated
- [ ] `prp.pluginPath` with `~` prefix (path expansion)

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
pnpm lint && pnpm typecheck
```

**EXPECT**: Exit 0, no errors

### Level 2: UNIT_TESTS

```bash
pnpm test packages/core/src/__tests__/config-validation.test.ts
```

**EXPECT**: All tests pass including new PRP tests

### Level 3: FULL_SUITE

```bash
pnpm test && pnpm build
```

**EXPECT**: All tests pass, build succeeds, no regressions

---

## Acceptance Criteria

- [ ] `PrpConfig`, `PrpGates`, `PrpWriteback` interfaces exist in `types.ts`
- [ ] `ProjectConfig.prp` is optional `PrpConfig`
- [ ] `SessionMetadata.prpPhase` is optional string
- [ ] Zod schemas validate PRP config with correct defaults
- [ ] Existing configs without `prp` still validate (backward compatible)
- [ ] `agent-orchestrator.yaml.example` includes commented PRP section
- [ ] All validation levels pass

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
|------|------------|--------|------------|
| `expandPaths` doesn't expand `prp.pluginPath` | MED | LOW | Check `expandPaths` implementation; add expansion if needed |
| Zod `.default({})` on nested objects causes type mismatch | LOW | MED | Test that defaults propagate correctly through `validateConfig` |

---

## Notes

- Phase 2 (PRP Prompt Template) can run in parallel — it writes the prompt content that Phase 3 will inject using these config types.
- The `prpPhase` metadata field is a free-form string intentionally — no enum constraint. Phase 4 will define the phase names when implementing detection logic.
- `pluginPath` uses `~` expansion like `project.path` — verify `expandPaths` handles it or add support.
