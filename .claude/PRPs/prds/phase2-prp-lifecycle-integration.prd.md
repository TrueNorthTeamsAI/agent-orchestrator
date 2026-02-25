# Phase 2: PRP Lifecycle Integration

## Problem Statement

Agent Orchestrator can now auto-spawn agents from tracker webhooks (Phase 1), but spawned agents receive a generic prompt ("work on issue #N, make a PR") and improvise their approach. This produces inconsistent results — agents skip investigation, write no plans, skip validation, and create PRs with untested code. The PRP methodology (investigate → plan → implement with validation loops → PR → self-review) exists as a Claude Code plugin but requires a human to invoke each command. There is no bridge between AO's autonomous spawning and PRP's structured execution.

## Evidence

- `BASE_AGENT_PROMPT` in `packages/core/src/prompt-builder.ts:22-40` gives agents only generic instructions: "create a branch, implement, open a PR"
- No PRP references exist anywhere in the AO codebase (confirmed via grep)
- The PRP plugin (`PRPs-agentic-sdlc-starter`) provides 15 commands and 10 sub-agents but requires manual `/prp-*` invocation
- The vision document (`.claude/PRPs/prds/vision-prp-task-runner.md`) identifies this as the second foundational gap after event-driven spawning
- `agentRulesFile` and `systemPromptFile` injection paths exist but are unused by the worker agent spawn flow (`session-manager.ts:450-457` never sets `systemPromptFile`)

## Proposed Solution

Extend the spawn pipeline to inject PRP methodology instructions into every agent session. When a project has PRP mode enabled, the spawn flow: (1) writes a PRP-aware system prompt file to the workspace, (2) ensures the PRP plugin is available via `postCreate` or symlinks, (3) instructs the agent to follow the PRP lifecycle (investigate → plan → ralph → PR → self-review), and (4) writes back phase progress to the tracker. Configurable human gates allow pausing at plan approval or PR approval, with tracker notification and resumption on approval.

The PRP plugin remains external — AO tells agents "you have PRP commands, use them" rather than reimplementing methodology in system prompts.

## Key Hypothesis

We believe that **injecting structured PRP methodology into auto-spawned agent sessions** will **produce consistently higher-quality PRs with traceable artifacts** for teams using AI coding agents. We'll know we're right when **an auto-spawned agent produces investigation, plan, and implementation artifacts in `.claude/PRPs/` and all validation levels pass before PR creation**, compared to the current unstructured approach.

## What We're NOT Building

- **PRP methodology reimplementation** — agents use the existing PRP plugin; AO just ensures it's available and instructs agents to use it
- **New agent plugin interface methods** — PRP awareness is injected via prompt and workspace setup, not interface changes
- **Custom state machine states for PRP phases** — detection uses artifact presence and metadata, not new `SessionStatus` values (keeps backward compatibility)
- **Ralph loop reimplementation** — the PRP plugin's Stop hook mechanism handles validation loops; AO doesn't need to replicate this
- **Auto-merge on approval** — the existing `approved-and-green` reaction handles merge; this PRD focuses on the path to PR creation
- **Multi-agent PRP coordination** — each session runs its own PRP lifecycle independently
- **Dashboard UI for PRP phases** — YAML config and tracker comments are sufficient for Phase 2

## Success Metrics

| Metric | Target | How Measured |
|--------|--------|--------------|
| PRP artifact production rate | 100% of PRP-enabled sessions produce investigation + plan artifacts | Check `.claude/PRPs/` directory in session worktrees |
| Validation pass rate before PR | > 90% of PRs pass lint + typecheck + tests on first CI run | CI status on PRs created by PRP-enabled sessions |
| Tracker writeback completeness | Comments posted at investigation, plan, implementation, and PR phases | Issue comment count per session |
| Gate enforcement | 100% of gate-enabled projects pause and notify before proceeding | Lifecycle manager logs + notification delivery |
| End-to-end autonomy | Agent completes investigate → plan → implement → PR with zero human commands | Session lifecycle logs |

## Open Questions

- [ ] Should PRP plugin files be symlinked from a central location or copied into each worktree? Symlinks are lighter but may break if the source moves.
- [ ] How should the system detect PRP phase transitions? Options: (a) poll for artifact files in `.claude/PRPs/`, (b) extend the metadata-updater hook script to detect PRP artifact creation, (c) rely on the agent's prompt to update metadata explicitly.
- [ ] Should the plan gate pause the tmux session (send Ctrl+C) or just notify and let the agent continue? Pausing is safer but requires reliable resume.
- [ ] What happens if the PRP plugin is not installed or fails to load in the agent's session? Should AO fall back to the generic prompt?
- [ ] Should `agentRulesFile` be repurposed for PRP instructions, or should a new `prpPromptFile` config field be added?
- [ ] How should the system handle PRP-enabled projects that receive manual `ao spawn` commands (not webhook-triggered)? Should PRP mode apply regardless of spawn source?

---

## Users & Context

**Primary User**
- **Who**: Developer or team lead who manages AI coding agents and wants consistent, high-quality agent output
- **Current behavior**: Labels an issue "agent-work" → agent spawns automatically (Phase 1) → agent improvises implementation → inconsistent PR quality, no artifacts, no investigation phase
- **Trigger**: Agent spawns from webhook trigger on a PRP-enabled project
- **Success state**: Agent automatically investigates the issue, creates a plan, implements with validation loops, produces traceable artifacts, and creates a well-tested PR — all without human commands

**Job to Be Done**
When an issue is triaged and auto-assigned to an agent, I want the agent to follow a rigorous investigate → plan → implement → validate → PR lifecycle, so that the resulting PR is consistently high quality with traceable artifacts.

**Non-Users**
- Agents themselves (they don't know about AO's orchestration; they see PRP commands and instructions)
- Users of projects without PRP mode enabled (they get the existing generic prompt behavior)
- The PRP plugin itself (it remains a standalone Claude Code plugin; AO is a consumer)

---

## Solution Detail

### Core Capabilities (MoSCoW)

| Priority | Capability | Rationale |
|----------|------------|-----------|
| Must | PRP-aware system prompt injection via `systemPromptFile` | Core value: agents must know to use PRP commands |
| Must | PRP plugin availability in workspaces via `postCreate`/symlinks | Agents can't use PRP if it's not installed |
| Must | Per-project `prp` config section in YAML | Projects opt into PRP mode; non-PRP projects unchanged |
| Must | PRP lifecycle instructions in prompt (investigate → plan → ralph → PR → self-review) | Agents need explicit step-by-step instructions |
| Must | Tracker writeback at PRP phase transitions (investigation, plan, implementation, PR) | Users see progress on the issue without checking the dashboard |
| Should | Plan approval gate (configurable per project) | High-stakes projects want human plan review before implementation |
| Should | PRP phase detection via artifact presence or metadata | Lifecycle manager can report accurate phase to dashboard and tracker |
| Should | `prpPhase` field in session metadata | Track which PRP phase the agent is in |
| Could | PR approval gate (pause before merge) | Some teams want final human review before merge |
| Could | PRP phase-aware reactions (e.g., escalate if stuck in planning for > 30 min) | Phase-specific timeouts prevent agents from spinning |
| Could | CLAUDE.md injection with PRP-specific rules per project | Fine-grained methodology control beyond the system prompt |
| Won't | PRP methodology reimplementation in AO core | PRP plugin handles this; AO is the orchestrator |
| Won't | Custom `SessionStatus` values for PRP phases | Breaks backward compatibility; use metadata field instead |
| Won't | Dashboard UI for PRP phase visualization | YAML + tracker comments sufficient for Phase 2 |

### MVP Scope

The minimum to validate the hypothesis:
1. `prp` config section in `ProjectConfig` with `enabled: true` and `pluginPath` pointing to PRP plugin location
2. `systemPromptFile` written to workspace with PRP lifecycle instructions
3. PRP plugin symlinked or made available in workspace during `postCreate`
4. Agent receives prompt: "Use PRP commands: `/prp-issue-investigate #{issue}` → `/prp-plan` → `/prp-ralph` → `/prp-pr`"
5. Tracker comments posted at spawn (existing) and at PR creation (existing) — no new writeback needed for MVP

### User Flow

```
[Developer]                    [GitHub]                      [AO Web Server]              [AO Core]                    [Agent Session]
     |                              |                              |                          |                              |
     |-- Labels issue "agent-work" →|                              |                          |                              |
     |                              |-- POST /api/webhooks/github →|                          |                              |
     |                              |                              |-- Trigger match           |                              |
     |                              |                              |          spawn(project, issue)                           |
     |                              |                              |                          |                              |
     |                              |                              |                          |-- Create worktree             |
     |                              |                              |                          |-- Symlink PRP plugin          |
     |                              |                              |                          |-- Write PRP system prompt file |
     |                              |                              |                          |-- Launch claude with           |
     |                              |                              |                          |   --append-system-prompt       |
     |                              |                              |                          |   -p "investigate issue #N"    |
     |                              |                              |                          |          ─────────────────────►|
     |                              |                              |                          |                              |
     |                              |←── "AO spawned session" ─────|                          |                              |
     |                              |                              |                          |   /prp-issue-investigate #N   |
     |                              |                              |                          |   Commits investigation       |
     |                              |                              |                          |                              |
     |                              |                              |   [lifecycle detects       |   /prp-plan                   |
     |                              |                              |    PRP phase change]       |   Commits plan                |
     |                              |←── "Investigation complete,  |                          |                              |
     |                              |     plan created" ───────────|                          |                              |
     |                              |                              |                          |                              |
     |                              |                              |                          |   [IF plan gate enabled]      |
     |                              |                              |                          |   Pause — wait for approval   |
     |←── Notification: "Review     |                              |                          |                              |
     |     plan for issue #N" ──────|                              |                          |                              |
     |                              |                              |                          |                              |
     |-- Approves plan (comment) ──►|                              |                          |                              |
     |                              |                              |                          |   Resume — /prp-ralph          |
     |                              |                              |                          |   (autonomous validation loop) |
     |                              |                              |                          |   Commits implementation       |
     |                              |                              |                          |                              |
     |                              |                              |                          |   /prp-pr                      |
     |                              |                              |                          |   Creates PR                  |
     |                              |←── PR #N created ────────────|                          |                              |
     |                              |                              |                          |                              |
     |                              |                              |                          |   /prp-review (self-review)    |
     |                              |                              |                          |                              |
     |                              |←── "PR ready for review" ────|                          |                              |
     |←── (sees PR + artifacts) ────|                              |                          |                              |
```

---

## Technical Approach

**Feasibility**: HIGH

The existing codebase provides all necessary integration points:
- `systemPromptFile` pattern already exists for orchestrator agents (`session-manager.ts:586-600`) — reuse for worker agents
- `postCreate` hooks and `symlinks` config already handle workspace setup
- `writebackToTracker()` is fire-and-forget and easy to extend with new phase comments
- `agentLaunchConfig` already supports `systemPromptFile` field — just needs to be populated for worker spawns
- Claude Code's `--append-system-prompt` and CLAUDE.md discovery handle prompt injection
- The PRP plugin's Stop hook mechanism provides validation loops without AO intervention

**Key technical decisions:**

1. **PRP instructions via `systemPromptFile`** — write a PRP-specific prompt file to the workspace, pass via `--append-system-prompt "$(cat file)"`. This is the existing orchestrator pattern (`session-manager.ts:586-600`). Long prompts avoid tmux truncation.

2. **PRP plugin delivery via symlinks** — add `.claude` directory (containing the PRP plugin's skills, hooks, etc.) to `project.symlinks` configuration. Claude Code auto-discovers `.claude/skills/` at launch. No code changes needed — pure config.

3. **Phase detection via metadata updates** — extend the `metadata-updater.sh` hook script to detect PRP artifact creation (presence of `.claude/PRPs/investigations/`, `.claude/PRPs/plans/`). The hook already runs on every `PostToolUse` Bash event. Adding artifact checks is a small shell script extension.

4. **Gates via lifecycle manager reactions** — add a `"plan-gate"` reaction type that posts the plan to the tracker, sends a notification, and sets metadata `prpPhase=plan_gate`. The lifecycle manager already has reaction infrastructure with retry/escalation. Resumption: human posts an approval comment → webhook receives it → trigger engine recognizes it → sends resume message to agent via `sessionManager.send()`.

5. **No new plugin slot or interface methods** — PRP integration is entirely config-driven (prompt injection, symlinks, postCreate) and lifecycle-driven (phase detection, reactions, writeback).

**Architecture notes:**
- PRP config lives on `ProjectConfig.prp` — a new optional object with `enabled`, `pluginPath`, `gates`, `writebackPhases`
- The `buildPrompt()` function gains a new layer for PRP instructions (between base prompt and config layer)
- Session metadata gains `prpPhase` field for lifecycle tracking
- Writeback comment templates expand to cover PRP phase transitions

**Technical Risks**

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| PRP plugin not found or incompatible version in workspace | MED | Validate plugin presence in `postCreate`; log warning and fall back to generic prompt if missing |
| Agent ignores PRP instructions and improvises anyway | MED | Use `--append-system-prompt` (system-level, survives context compaction) rather than `-p` (user turn); include explicit "DO NOT skip PRP steps" instruction |
| Plan gate resumption race condition (two approval webhooks) | LOW | Idempotent resume: if already past plan_gate, ignore duplicate approvals |
| `metadata-updater.sh` hook becomes too complex with PRP detection | MED | Keep PRP detection in a separate script called from the main hook; maintain single-responsibility |
| tmux 2000-char limit on `--append-system-prompt` inline | LOW | Already mitigated: using `systemPromptFile` pattern with `$(cat file)` — no inline limit |
| Claude Code context compaction drops PRP instructions | MED | `--append-system-prompt` content persists through compaction (confirmed in docs); CLAUDE.md is re-injected as first user message |

---

## Config Schema

### New Config Section

```yaml
projects:
  my-app:
    repo: "org/my-app"
    path: "~/code/my-app"

    # NEW: PRP lifecycle integration
    prp:
      enabled: true
      # Path to PRP plugin installation (skills, hooks, etc.)
      # Contents of this path's .claude/ directory are symlinked into workspaces
      pluginPath: "~/code/PRPs-agentic-sdlc-starter"

      # Human approval gates (default: no gates)
      gates:
        plan: false          # Pause after plan creation for human approval
        pr: false            # Pause after PR creation for human review

      # Which phases trigger tracker writeback comments
      writeback:
        investigation: true  # Post summary when investigation completes
        plan: true           # Post plan link when plan is created
        implementation: true # Post progress during ralph loop
        pr: true             # Post PR link (already exists from Phase 1)

      # Optional: override the PRP system prompt template
      promptFile: null       # Path to custom PRP prompt; null = use built-in
```

### PRP Config Zod Schema

```typescript
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

---

## Implementation Phases

| # | Phase | Description | Status | Parallel | Depends | PRP Plan |
|---|-------|-------------|--------|----------|---------|----------|
| 1 | Types & Config | `PrpConfig` type, Zod schema, extend `ProjectConfig` with `prp` field | in-progress | with 2 | - | `.claude/PRPs/plans/phase2-types-and-config.plan.md` |
| 2 | PRP Prompt Template | System prompt file content instructing agents to follow PRP lifecycle | in-progress | with 1 | - | `.claude/PRPs/plans/phase2-prp-prompt-template.plan.md` |
| 3 | Spawn Pipeline Integration | Write PRP prompt file to workspace, populate `systemPromptFile` in launch config, symlink PRP plugin | in-progress | - | 1, 2 | `.claude/PRPs/plans/phase2-spawn-pipeline-integration.plan.md` |
| 4 | Phase Detection & Metadata | Extend metadata-updater hook to detect PRP artifacts, add `prpPhase` to metadata | in-progress | with 5 | 3 | `.claude/PRPs/plans/phase2-phase-detection-metadata.plan.md` |
| 5 | Tracker Writeback | Extend `getWritebackComment()` with PRP phase comments, add writeback config filtering | in-progress | with 4 | 3 | `.claude/PRPs/plans/phase2-tracker-writeback.plan.md` |
| 6 | Plan Gate | Gate reaction type, pause/notify/resume flow for plan approval | pending | - | 4, 5 | - |
| 7 | Integration Testing | End-to-end: webhook → PRP-aware spawn → phase detection → writeback → gate | pending | - | 6 | - |

### Phase Details

**Phase 1: Types & Config**
- **Goal**: Define the PRP config data model and extend project config schema
- **Scope**: `PrpConfig` interface, `PrpGatesSchema`, `PrpWritebackSchema`, `PrpConfigSchema` Zod schemas, extend `ProjectConfig` with `prp?: PrpConfig`, extend `SessionMetadata` with `prpPhase?: string`, update `agent-orchestrator.yaml.example`
- **Success signal**: `pnpm typecheck` passes; existing configs still validate; new PRP config fields accepted

**Phase 2: PRP Prompt Template**
- **Goal**: Create the system prompt content that instructs agents to follow PRP lifecycle
- **Scope**: A markdown template file with PRP lifecycle steps, issue number interpolation, conditional gate instructions. Stored in `packages/core/src/prp-prompt-template.ts` as an exported template string function.
- **Success signal**: Template renders correctly with test issue number and project config

**Phase 3: Spawn Pipeline Integration**
- **Goal**: PRP-enabled projects spawn agents with PRP methodology and plugin access
- **Scope**: In `session-manager.ts:spawn()`, when `project.prp?.enabled`: (a) write PRP prompt to workspace file, (b) set `agentLaunchConfig.systemPromptFile`, (c) add PRP plugin path to symlinks. Extend `buildPrompt()` to include PRP layer. Update `workspace-worktree` postCreate if needed.
- **Success signal**: `ao spawn my-app 42` on a PRP-enabled project launches claude with `--append-system-prompt` containing PRP instructions; PRP plugin skills are discoverable in the workspace

**Phase 4: Phase Detection & Metadata**
- **Goal**: Lifecycle manager knows which PRP phase the agent is in
- **Scope**: Extend `metadata-updater.sh` to check for `.claude/PRPs/investigations/`, `.claude/PRPs/plans/`, `.claude/PRPs/reports/` and write `prpPhase={phase}` to metadata. Add `prpPhase` to `SessionMetadata` interface. Lifecycle manager reads and tracks phase transitions.
- **Success signal**: Session metadata shows `prpPhase=investigating` → `planning` → `implementing` → `pr_open` as agent progresses

**Phase 5: Tracker Writeback**
- **Goal**: Issue receives progress comments at each PRP phase
- **Scope**: Extend `getWritebackComment()` in lifecycle manager to produce comments for PRP phase transitions. Respect `prp.writeback` config to filter which phases get comments. Comment templates include artifact summaries (investigation findings, plan link).
- **Success signal**: Issue receives comments like "Investigation complete — 3 files identified for changes" and "Plan created — 5 implementation tasks"

**Phase 6: Plan Gate**
- **Goal**: Projects can require human approval of the plan before implementation
- **Scope**: New `"plan-gate"` reaction in lifecycle manager. When `prp.gates.plan` is true and `prpPhase` transitions to `planning_complete`, the reaction: (a) posts plan content to tracker as a comment, (b) sends notification to human, (c) sets `prpPhase=plan_gate`. Resumption via webhook (approval comment) or manual `ao send <session> "plan approved, proceed"`.
- **Success signal**: PRP-enabled project with `gates.plan: true` pauses after plan creation; human approves via issue comment; agent resumes with `/prp-ralph`

**Phase 7: Integration Testing**
- **Goal**: Validate the full PRP lifecycle pipeline end-to-end
- **Scope**: Test fixtures for PRP config, mock PRP plugin directory, unit tests for prompt template rendering, phase detection logic, writeback comment generation. Integration test: spawn with PRP config → verify systemPromptFile → verify symlinks.
- **Success signal**: `pnpm test` passes; manual test with a real webhook spawns a PRP-aware session

### Parallelism Notes

Phases 1 and 2 can run in parallel in separate worktrees — Phase 1 defines config types, Phase 2 writes prompt content. They merge at Phase 3 which needs both. Phases 4 and 5 can run in parallel after Phase 3 — they touch different systems (metadata vs tracker writeback). Phase 6 depends on both 4 and 5.

---

## Decisions Log

| Decision | Choice | Alternatives | Rationale |
|----------|--------|--------------|-----------|
| PRP instruction delivery | `systemPromptFile` via `--append-system-prompt "$(cat file)"` | Inline `--append-system-prompt`, `-p` flag, CLAUDE.md injection | Survives context compaction; avoids tmux truncation; same pattern as orchestrator spawn |
| PRP plugin delivery | Symlinks via existing `project.symlinks` config | `postCreate` command (`npm install`), copying files, git submodule | Zero code changes for delivery; symlinks are fast; already a config feature |
| Phase detection | Metadata-updater hook + artifact file presence | Polling workspace directory, agent self-reporting, parsing terminal output | Hook already runs on every Bash tool use; low overhead; reliable |
| Gate implementation | Lifecycle reaction with metadata-based state | New `SessionStatus` values, separate gate service, agent-side hook | Backward compatible; uses existing reaction infrastructure; no state machine changes |
| PRP config location | `ProjectConfig.prp` nested object | Top-level `prpMode: boolean`, `agentRules` string, environment variable | Clean separation; doesn't pollute existing config; supports future PRP options |
| Methodology ownership | PRP plugin (external) | Reimplemented in system prompt, built into AO core | Plugin has 15 commands + 10 sub-agents; reimplementing is fragile; independent evolution |

---

## Research Summary

**Market Context**
- Devin and similar platforms use a "Game Plan" → phased execution → checkpoint review pattern, validating the investigate → plan → implement → review lifecycle
- LangGraph's interrupt/resume pattern with serialized state is the reference for approval gates
- The "human-on-the-loop" (HOTL) model (agent runs autonomously, human monitors and intervenes) matches AO's "push, not pull" philosophy

**Technical Context**
- Claude Code's `--append-system-prompt` content survives context compaction (unlike CLAUDE.md which is first user message)
- `--append-system-prompt-file` only works in print mode (`-p`), but AO already uses the `$(cat file)` workaround
- Claude Code auto-discovers `.claude/skills/` and `.claude/rules/` at launch — symlinking the PRP plugin's `.claude/` directory makes all PRP commands available
- The `Stop` hook with `type: "agent"` creates validation loops (this is how PRP's Ralph works) — no AO intervention needed for validation
- `PostToolUse` hooks fire on every Bash execution — extending `metadata-updater.sh` for PRP artifact detection is straightforward

---

*Generated: 2026-02-25*
*Status: DRAFT*
*Parent: `.claude/PRPs/prds/vision-prp-task-runner.md` (Phase 2)*
