# Feature: PRP Prompt Template

## Summary

Create a TypeScript module (`packages/core/src/prp-prompt-template.ts`) that exports a template function generating PRP lifecycle instructions for spawned agents. When a project has PRP enabled, this prompt tells the agent to follow the investigate → plan → ralph → PR → self-review methodology using the PRP plugin commands. The module is pure prompt generation — no spawn pipeline changes (that's Phase 3).

## User Story

As the Agent Orchestrator spawn pipeline
I want a function that generates PRP lifecycle instructions for a given project/issue
So that PRP-enabled agent sessions receive structured methodology guidance via `systemPromptFile`

## Problem Statement

`BASE_AGENT_PROMPT` gives agents generic "implement and make a PR" instructions. PRP-enabled projects need a separate system prompt that instructs agents to use PRP commands in the correct order, with conditional gate instructions and project-specific context.

## Solution Statement

Create `buildPrpPrompt()` — a function that takes project config and issue ID, returns a markdown string with PRP lifecycle steps. Export alongside a `PRP_LIFECYCLE_PROMPT` constant (the template body without interpolation). Follow the exact pattern of `orchestrator-prompt.ts` (sections array, typed config interface, exported from `index.ts`).

## Metadata

| Field            | Value                                      |
| ---------------- | ------------------------------------------ |
| Type             | NEW_CAPABILITY                             |
| Complexity       | LOW                                        |
| Systems Affected | core/prp-prompt-template, core/index       |
| Dependencies     | none (pure string generation)              |
| Estimated Tasks  | 3                                          |

---

## UX Design

### Before State
```
╔═══════════════════════════════════════════════════════════════╗
║  spawn(project, issue)                                       ║
║    → buildPrompt() → BASE_AGENT_PROMPT + config layer        ║
║    → agent receives: "Work on issue #42, make a PR"          ║
║    → agent improvises: no investigation, no plan, no loops   ║
║                                                              ║
║  No PRP prompt function exists                               ║
╚═══════════════════════════════════════════════════════════════╝
```

### After State
```
╔═══════════════════════════════════════════════════════════════╗
║  spawn(project, issue)                                       ║
║    → [Phase 3 will call] buildPrpPrompt({project, issueId})  ║
║    → Returns PRP lifecycle instructions:                     ║
║      1. /prp-issue-investigate #42                           ║
║      2. /prp-plan                                            ║
║      3. /prp-ralph                                           ║
║      4. /prp-pr                                              ║
║      5. /prp-review (self-review)                            ║
║    → Conditional gate instructions based on project.prp.gates║
║    → Written to systemPromptFile by Phase 3                  ║
╚═══════════════════════════════════════════════════════════════╝
```

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `packages/core/src/orchestrator-prompt.ts` | 10-14, 21-211 | MIRROR this pattern exactly: typed config interface, sections array, `generateOrchestratorPrompt()` |
| P0 | `packages/core/src/prompt-builder.ts` | 22-40 | `BASE_AGENT_PROMPT` constant pattern to mirror for `PRP_LIFECYCLE_PROMPT` |
| P0 | `packages/core/src/types.ts` | 838-866 | `PrpConfig`, `PrpGates` interfaces — the input types |
| P1 | `packages/core/src/index.ts` | 54-60 | Export pattern for prompt modules |
| P1 | `packages/core/src/__tests__/prompt-builder.test.ts` | all | Test pattern to FOLLOW |

---

## Patterns to Mirror

**PROMPT_MODULE_STRUCTURE:**
```typescript
// SOURCE: packages/core/src/orchestrator-prompt.ts:10-14
export interface OrchestratorPromptConfig {
  config: OrchestratorConfig;
  projectId: string;
  project: ProjectConfig;
}
```

**SECTIONS_ARRAY_PATTERN:**
```typescript
// SOURCE: packages/core/src/orchestrator-prompt.ts:21-30
export function generateOrchestratorPrompt(opts: OrchestratorPromptConfig): string {
  const { config, projectId, project } = opts;
  const sections: string[] = [];
  sections.push(`# ${project.name} Orchestrator\n\nYou are the **orchestrator agent**...`);
  // ... more sections
  return sections.join("\n\n");
}
```

**EXPORTED_CONSTANT_PATTERN:**
```typescript
// SOURCE: packages/core/src/prompt-builder.ts:22-40
export const BASE_AGENT_PROMPT = `You are an AI coding agent...`;
```

**INDEX_EXPORT_PATTERN:**
```typescript
// SOURCE: packages/core/src/index.ts:54-60
// Prompt builder — layered prompt composition
export { buildPrompt, BASE_AGENT_PROMPT } from "./prompt-builder.js";
export type { PromptBuildConfig } from "./prompt-builder.js";
```

**TEST_PATTERN:**
```typescript
// SOURCE: packages/core/src/__tests__/prompt-builder.test.ts:29-43
describe("buildPrompt", () => {
  it("includes base prompt when issue is provided", () => {
    const result = buildPrompt({ project, projectId: "test-app", issueId: "INT-1343" });
    expect(result).toContain(BASE_AGENT_PROMPT);
  });
});
```

---

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `packages/core/src/prp-prompt-template.ts` | CREATE | New module: PRP prompt template function + constant |
| `packages/core/src/index.ts` | UPDATE | Add exports for `buildPrpPrompt`, `PRP_LIFECYCLE_PROMPT`, `PrpPromptConfig` |
| `packages/core/src/__tests__/prp-prompt-template.test.ts` | CREATE | Unit tests for the template function |

---

## NOT Building (Scope Limits)

- **No spawn pipeline changes** — Phase 3 will call `buildPrpPrompt()` and write to `systemPromptFile`
- **No `systemPromptFile` writing** — Phase 3 handles file I/O
- **No `buildPrompt()` modifications** — PRP prompt is a separate system prompt, not a layer in the existing prompt builder
- **No custom prompt file reading** — `PrpConfig.promptFile` override reading will be done in Phase 3 when calling this function
- **No metadata-updater changes** — Phase 4

---

## Step-by-Step Tasks

### Task 1: CREATE `packages/core/src/prp-prompt-template.ts`

- **ACTION**: CREATE new module with `PrpPromptConfig` interface, `PRP_LIFECYCLE_PROMPT` constant, and `buildPrpPrompt()` function
- **IMPLEMENT**:
  ```typescript
  /**
   * PRP Prompt Template — generates PRP lifecycle instructions for spawned agents.
   *
   * When a project has PRP enabled, this prompt is written to a systemPromptFile
   * and passed via --append-system-prompt. It instructs the agent to follow the
   * investigate → plan → implement → PR → self-review lifecycle.
   */

  import type { PrpConfig } from "./types.js";

  // =============================================================================
  // TYPES
  // =============================================================================

  export interface PrpPromptConfig {
    /** The PRP configuration for this project */
    prp: PrpConfig;

    /** Issue identifier (e.g. "#42", "INT-1343") */
    issueId: string;

    /** Project name for display */
    projectName: string;
  }

  // =============================================================================
  // PRP LIFECYCLE PROMPT
  // =============================================================================

  export const PRP_LIFECYCLE_PROMPT = `## PRP Methodology — Structured Agent Lifecycle

  You have the PRP (Product Requirement Prompt) plugin installed. You MUST follow this structured lifecycle for every task. DO NOT skip steps or improvise your own approach.

  ### Lifecycle Steps

  Follow these steps IN ORDER. Each step uses a PRP plugin command.

  **Step 1: Investigate**
  Run the investigation command to understand the issue deeply before writing any code.
  This creates an investigation artifact in \`.claude/PRPs/investigations/\`.

  **Step 2: Plan**
  Create an implementation plan based on your investigation findings.
  This creates a plan artifact in \`.claude/PRPs/plans/\`.

  **Step 3: Implement (Ralph Loop)**
  Execute the plan using the autonomous validation loop.
  Ralph iterates until all validations pass: lint, typecheck, tests, build.
  DO NOT manually implement without the validation loop.

  **Step 4: Create PR**
  Create a pull request with a summary of changes, test plan, and linked issue.

  **Step 5: Self-Review**
  Review your own PR for quality, completeness, and adherence to the plan.
  Address any issues found before marking as ready.

  ### Rules

  - NEVER skip the investigation step — understanding the problem is critical
  - NEVER start coding before creating a plan
  - ALWAYS use the validation loop — do not push untested code
  - If the validation loop fails after multiple iterations, document the blocker
  - Commit PRP artifacts (\`.claude/PRPs/\`) alongside your code changes`;

  // =============================================================================
  // PUBLIC API
  // =============================================================================

  /**
   * Build a PRP lifecycle prompt for an agent session.
   *
   * Returns a markdown string with:
   * 1. PRP lifecycle instructions (the constant above)
   * 2. Issue-specific commands with the actual issue ID
   * 3. Gate instructions if human approval is configured
   */
  export function buildPrpPrompt(config: PrpPromptConfig): string {
    const { prp, issueId, projectName } = config;
    const sections: string[] = [];

    // Section 1: Lifecycle instructions
    sections.push(PRP_LIFECYCLE_PROMPT);

    // Section 2: Issue-specific commands
    sections.push(`## Your Task

  Project: ${projectName}
  Issue: ${issueId}

  Execute these commands in order:

  \`\`\`
  /prp-issue-investigate ${issueId}
  /prp-plan .claude/PRPs/investigations/<investigation-file>.md
  /prp-ralph .claude/PRPs/plans/<plan-file>.plan.md
  /prp-pr
  /prp-review
  \`\`\`

  After \`/prp-issue-investigate\`, the investigation file will be in \`.claude/PRPs/investigations/\`.
  After \`/prp-plan\`, the plan file will be in \`.claude/PRPs/plans/\`.
  Use the actual file paths from the previous step's output.`);

    // Section 3: Gate instructions (conditional)
    if (prp.gates.plan) {
      sections.push(`## Plan Approval Gate

  IMPORTANT: After creating the plan (\`/prp-plan\`), STOP and wait.
  Your plan will be posted to the issue tracker for human review.
  Do NOT proceed to implementation until you receive an approval message.
  When approved, you will receive a message — then continue with \`/prp-ralph\`.`);
    }

    if (prp.gates.pr) {
      sections.push(`## PR Review Gate

  IMPORTANT: After creating the PR (\`/prp-pr\`), STOP and wait.
  The PR will be flagged for human review before merge.
  Complete the self-review (\`/prp-review\`) but do not expect auto-merge.`);
    }

    return sections.join("\n\n");
  }
  ```
- **MIRROR**: `packages/core/src/orchestrator-prompt.ts` — typed config, sections array, join pattern
- **VALIDATE**: `pnpm typecheck`

### Task 2: UPDATE `packages/core/src/index.ts`

- **ACTION**: ADD exports for the new PRP prompt template module
- **IMPLEMENT**: Add after the orchestrator prompt exports (after line 60):
  ```typescript
  // PRP prompt template — PRP lifecycle instructions for spawned agents
  export { buildPrpPrompt, PRP_LIFECYCLE_PROMPT } from "./prp-prompt-template.js";
  export type { PrpPromptConfig } from "./prp-prompt-template.js";
  ```
- **MIRROR**: `packages/core/src/index.ts:54-60` — comment + named exports + type export
- **VALIDATE**: `pnpm typecheck`

### Task 3: CREATE `packages/core/src/__tests__/prp-prompt-template.test.ts`

- **ACTION**: CREATE unit tests for PRP prompt template
- **IMPLEMENT**:
  ```typescript
  import { describe, it, expect } from "vitest";
  import { buildPrpPrompt, PRP_LIFECYCLE_PROMPT } from "../prp-prompt-template.js";
  import type { PrpConfig } from "../types.js";

  function makePrpConfig(overrides?: Partial<PrpConfig>): PrpConfig {
    return {
      enabled: true,
      gates: { plan: false, pr: false },
      writeback: { investigation: true, plan: true, implementation: true, pr: true },
      promptFile: null,
      ...overrides,
    };
  }

  describe("PRP_LIFECYCLE_PROMPT", () => {
    it("is a non-empty string", () => {
      expect(typeof PRP_LIFECYCLE_PROMPT).toBe("string");
      expect(PRP_LIFECYCLE_PROMPT.length).toBeGreaterThan(100);
    });

    it("covers all lifecycle steps", () => {
      expect(PRP_LIFECYCLE_PROMPT).toContain("Step 1: Investigate");
      expect(PRP_LIFECYCLE_PROMPT).toContain("Step 2: Plan");
      expect(PRP_LIFECYCLE_PROMPT).toContain("Step 3: Implement");
      expect(PRP_LIFECYCLE_PROMPT).toContain("Step 4: Create PR");
      expect(PRP_LIFECYCLE_PROMPT).toContain("Step 5: Self-Review");
    });

    it("includes enforcement rules", () => {
      expect(PRP_LIFECYCLE_PROMPT).toContain("NEVER skip");
      expect(PRP_LIFECYCLE_PROMPT).toContain("ALWAYS use the validation loop");
    });
  });

  describe("buildPrpPrompt", () => {
    it("includes lifecycle prompt", () => {
      const result = buildPrpPrompt({
        prp: makePrpConfig(),
        issueId: "#42",
        projectName: "My App",
      });
      expect(result).toContain(PRP_LIFECYCLE_PROMPT);
    });

    it("includes issue ID in commands", () => {
      const result = buildPrpPrompt({
        prp: makePrpConfig(),
        issueId: "#42",
        projectName: "My App",
      });
      expect(result).toContain("/prp-issue-investigate #42");
      expect(result).toContain("Issue: #42");
    });

    it("includes project name", () => {
      const result = buildPrpPrompt({
        prp: makePrpConfig(),
        issueId: "#42",
        projectName: "My App",
      });
      expect(result).toContain("Project: My App");
    });

    it("includes all PRP commands in order", () => {
      const result = buildPrpPrompt({
        prp: makePrpConfig(),
        issueId: "#42",
        projectName: "My App",
      });
      const investigateIdx = result.indexOf("/prp-issue-investigate");
      const planIdx = result.indexOf("/prp-plan");
      const ralphIdx = result.indexOf("/prp-ralph");
      const prIdx = result.indexOf("/prp-pr");
      const reviewIdx = result.indexOf("/prp-review");

      expect(investigateIdx).toBeLessThan(planIdx);
      expect(planIdx).toBeLessThan(ralphIdx);
      expect(ralphIdx).toBeLessThan(prIdx);
      expect(prIdx).toBeLessThan(reviewIdx);
    });

    it("omits gate instructions when gates are disabled", () => {
      const result = buildPrpPrompt({
        prp: makePrpConfig({ gates: { plan: false, pr: false } }),
        issueId: "#42",
        projectName: "My App",
      });
      expect(result).not.toContain("Plan Approval Gate");
      expect(result).not.toContain("PR Review Gate");
    });

    it("includes plan gate instructions when enabled", () => {
      const result = buildPrpPrompt({
        prp: makePrpConfig({ gates: { plan: true, pr: false } }),
        issueId: "#42",
        projectName: "My App",
      });
      expect(result).toContain("Plan Approval Gate");
      expect(result).toContain("STOP and wait");
      expect(result).not.toContain("PR Review Gate");
    });

    it("includes PR gate instructions when enabled", () => {
      const result = buildPrpPrompt({
        prp: makePrpConfig({ gates: { plan: false, pr: true } }),
        issueId: "#42",
        projectName: "My App",
      });
      expect(result).not.toContain("Plan Approval Gate");
      expect(result).toContain("PR Review Gate");
    });

    it("includes both gates when both enabled", () => {
      const result = buildPrpPrompt({
        prp: makePrpConfig({ gates: { plan: true, pr: true } }),
        issueId: "#42",
        projectName: "My App",
      });
      expect(result).toContain("Plan Approval Gate");
      expect(result).toContain("PR Review Gate");
    });

    it("works with different issue ID formats", () => {
      const result = buildPrpPrompt({
        prp: makePrpConfig(),
        issueId: "INT-1343",
        projectName: "My App",
      });
      expect(result).toContain("/prp-issue-investigate INT-1343");
      expect(result).toContain("Issue: INT-1343");
    });
  });
  ```
- **MIRROR**: `packages/core/src/__tests__/prompt-builder.test.ts` — describe blocks, containment assertions, `.js` imports
- **VALIDATE**: `pnpm test packages/core/src/__tests__/prp-prompt-template.test.ts`

---

## Testing Strategy

### Unit Tests to Write

| Test File | Test Cases | Validates |
|-----------|------------|-----------|
| `packages/core/src/__tests__/prp-prompt-template.test.ts` | constant content, issue interpolation, command ordering, gate conditionals | Template function correctness |

### Edge Cases Checklist

- [ ] All lifecycle steps present in constant
- [ ] Issue ID correctly interpolated (GitHub `#42` format)
- [ ] Issue ID correctly interpolated (Linear `INT-1343` format)
- [ ] No gate sections when both gates disabled
- [ ] Plan gate section when `gates.plan: true`
- [ ] PR gate section when `gates.pr: true`
- [ ] Both gate sections when both enabled
- [ ] Commands appear in correct order

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
pnpm lint && pnpm typecheck
```

**EXPECT**: Exit 0, no errors

### Level 2: UNIT_TESTS

```bash
cd packages/core && npx vitest run src/__tests__/prp-prompt-template.test.ts
```

**EXPECT**: All tests pass

### Level 3: FULL_SUITE

```bash
cd packages/core && npx vitest run
```

**EXPECT**: All existing tests still pass, no regressions (paths.test.ts pre-existing Windows failures excluded)

---

## Acceptance Criteria

- [ ] `PRP_LIFECYCLE_PROMPT` constant exported from `packages/core/src/prp-prompt-template.ts`
- [ ] `buildPrpPrompt()` function exported, takes `PrpPromptConfig`, returns `string`
- [ ] Issue ID interpolated into PRP commands
- [ ] Gate instructions conditionally included based on `prp.gates`
- [ ] All exports registered in `packages/core/src/index.ts`
- [ ] All validation levels pass

---

## Completion Checklist

- [ ] All tasks completed in dependency order
- [ ] Each task validated immediately after completion
- [ ] Level 1: Static analysis (lint + typecheck) passes
- [ ] Level 2: Unit tests pass
- [ ] Level 3: Full test suite passes (no regressions)
- [ ] All acceptance criteria met

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Prompt too long for context window | LOW | LOW | PRP prompt is ~1500 chars; `systemPromptFile` via `$(cat)` has no truncation limit |
| Agent ignores PRP instructions | MED | MED | Use `--append-system-prompt` (system level, survives compaction); include "DO NOT skip" emphasis |
| Template indentation issues from template literals | LOW | LOW | Use dedented strings; test exact content in unit tests |

---

## Notes

- This module is consumed by Phase 3 (Spawn Pipeline Integration) which will call `buildPrpPrompt()`, write the result to a file, and set `agentLaunchConfig.systemPromptFile`.
- The `PrpConfig.promptFile` override (custom prompt file) will be handled in Phase 3 — this module provides the built-in default.
- Phase 2 is independent of Phase 1 (Types & Config) since it only imports the `PrpConfig` type which is already committed.
