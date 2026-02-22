# Vision: PRP-Driven Autonomous Task Runner

**Date**: 2026-02-23
**Status**: Draft
**Repository**: agent-orchestrator
**Git Commit**: ade1322

---

## 1. The Problem

AI coding agents today operate in one of two modes:

1. **Fire-and-forget**: A human spawns an agent with a prompt ("fix issue #123"), the agent figures out how on its own, and the results are inconsistent — especially on complex tasks. This is how Agent Orchestrator works today.

2. **Conversational**: A human directs an agent step-by-step through chat, getting good results but requiring constant attention. This is how Remote Coding Agent works.

Neither mode scales. Fire-and-forget lacks structure. Conversational lacks autonomy. What's missing is a system that combines **autonomous execution** with **structured methodology** — agents that know *how* to do the work, not just *what* to do.

## 2. The Vision

A system that watches task trackers (GitHub Issues, Linear, Plane) for actionable work items, automatically picks them up, and executes them using a proven software development lifecycle — the PRP (Product Requirement Prompt) methodology. The system manages the full CI/review loop autonomously, committing at each step, and escalates to humans only when their judgment is genuinely needed.

**Core principle**: Structured autonomy. Agents follow a rigorous investigate → plan → implement → validate → PR → review lifecycle, producing traceable artifacts at every step, while humans retain configurable control over approval gates.

### The Core Loop

```
WATCH:       Receive webhook or poll tracker for actionable items
  ↓
CLAIM:       Assign the item to the system, mark as in-progress
  ↓
SPAWN:       Create worktree + runtime + agent session with PRP plugin
  ↓
INVESTIGATE: Agent runs /prp-issue-investigate on the issue
  ↓
PLAN:        Agent runs /prp-plan (or loads an attached PRD)
  ↓
[GATE]:      Optional human approval of the plan (configurable)
  ↓
IMPLEMENT:   Agent runs /prp-ralph (autonomous loop until all validations pass)
  ↓
PR:          Agent creates PR via /prp-pr, links to issue
  ↓
SELF-REVIEW: Agent runs /prp-review on its own PR
  ↓
MONITOR:     Lifecycle manager watches CI status and human reviews
  ↓
REACT:       Auto-fix CI failures, address review comments, resolve merge conflicts
  ↓
COMPLETE:    PR merged → mark issue done → archive artifacts → notify human
```

## 3. Prior Art Analysis

Three existing systems each contribute a major piece of this vision. The architectural analysis below informed the decision to extend Agent Orchestrator rather than build from scratch.

### Agent Orchestrator — The Autonomous Lifecycle Engine

**What it provides**:
- Parallel session spawning and management via typed plugin slots (Runtime, Agent, Workspace, Tracker, SCM, Notifier, Terminal)
- 30-second polling lifecycle manager with 13-state session state machine
- Reaction engine with configurable retry counts, time-based escalation, and priority routing
- Push notification routing (desktop, Slack, Composio, webhook)
- Worktree-per-session isolation with atomic session ID reservation
- Next.js dashboard with SSE real-time updates and terminal access
- CLI for all operations (`ao spawn/start/status/kill/restore`)

**What it lacks**:
- No inbound event ingestion (webhooks or tracker polling for new work)
- No trigger evaluation logic (deciding *when* to spawn)
- No structured methodology — agents get a prompt and improvise
- No tracker writeback (posting progress/results back to issues)
- Single-machine only — no distributed execution

### Remote Coding Agent — The Platform Bridge

**What it provides**:
- Webhook adapters for GitHub (HMAC-SHA256 verified) and Jira, plus polling adapters for Telegram and Discord
- AI client abstraction (Claude SDK, Codex SDK) with session resume via stored session IDs
- Worktree-per-issue with PR↔issue worktree sharing via GraphQL
- Conversation lock manager (sequential per conversation, configurable global concurrency cap)
- Per-platform user whitelists and auth verification
- Stream vs batch output modes per platform

**What it lacks**:
- No lifecycle monitoring or automated reactions
- No parallel session management
- No dashboard or system-level visibility
- Conversational model requires human to direct every step

### PRP Agentic SDLC Starter — The Methodology

**What it provides**:
- Complete lifecycle as Claude Code plugin: 15 slash commands, 10 specialized sub-agents
- PRD generation → Planning (with codebase exploration) → Implementation → Validation → Commit → PR → Review
- Ralph loop: autonomous iteration via Stop hook mechanism until all 6 validation levels pass (lint → types → tests → build → e2e → manual)
- Artifact system: plans, reports, investigations, reviews — all archived with git metadata
- Context map system for automatic external knowledge injection
- 7-agent parallel PR review (code quality, tests, docs, types, errors, comments, simplification)

**What it lacks**:
- It's a Claude Code plugin — requires a human to invoke each command
- No system-level orchestration, event handling, or lifecycle management
- No awareness of CI/review state outside the agent's own session

### Capability Matrix

| Capability | Agent Orchestrator | Remote Coding Agent | PRP Starter | Needed |
|-----------|:-:|:-:|:-:|:-:|
| Parallel agent sessions | **yes** | no | no | **yes** |
| Lifecycle monitoring + reactions | **yes** | no | no | **yes** |
| Plugin architecture | **yes** | adapters | plugin | **yes** |
| Dashboard + real-time | **yes** | no | no | **yes** |
| Notification routing | **yes** | to-platform | no | **yes** |
| Webhook ingestion | no | **yes** | no | **yes** |
| Tracker writeback | no | **yes** | partial | **yes** |
| Structured SDLC methodology | no | no | **yes** | **yes** |
| Autonomous validation loops | no | no | **yes** | **yes** |
| Specialized sub-agents | no | no | **yes** | **yes** |
| Artifact production | no | no | **yes** | **yes** |
| Multi-machine execution | no | no | no | **yes** |

## 4. Architectural Decisions

### AD-1: Extend Agent Orchestrator as the Base

**Decision**: Build on Agent Orchestrator, adding new capabilities at the edges.

**Rationale**: AO provides the hardest-to-build components — lifecycle manager with reaction engine, plugin architecture with 8 typed slots, session manager with atomic reservation, notification routing, and a working dashboard. These represent months of edge-case handling. The gaps (webhook ingestion, trigger logic, tracker writeback, PRP integration) are additive and don't require changing AO's core.

**Alternatives considered**:
- *Extend Remote Coding Agent*: Would require rebuilding lifecycle management, parallel sessions, plugin system, and dashboard from scratch. RCA's value (webhook handling, platform adapters) is reference material, not a foundation.
- *New system from scratch*: Clean architecture but duplicates proven infrastructure. Not justified when AO's plugin system is designed for exactly this kind of extension.

### AD-2: PRP Plugin as External Methodology (Option B)

**Decision**: The PRP methodology lives in the PRP Starter plugin, installed in each agent's workspace. The system tells agents "you have PRP commands, use them" rather than baking methodology into system prompts.

**Rationale**: The PRP plugin is 15 commands and 10 sub-agents of battle-tested logic including the Ralph autonomous loop, 6-level validation, artifact generation, and context map integration. Reimplementing this in prompt engineering would be fragile and create a maintenance burden. Keeping PRP external means the methodology evolves independently and agents get the full sub-agent ecosystem for free.

**Implication**: Each workspace must have the PRP plugin available. The spawn flow ensures this.

### AD-3: Webhooks as Primary Trigger Model

**Decision**: Inbound webhooks from trackers, not polling.

**Rationale**: Webhooks are real-time, don't waste API quota, and scale naturally. GitHub, Linear, and Plane all support webhooks. The Remote Coding Agent's GitHub adapter (HMAC-SHA256 verification, event parsing) serves as a reference implementation.

**Fallback**: Polling can be added later for trackers that don't support webhooks, using AO's existing interval-based polling pattern.

### AD-4: Configurable Human Gates

**Decision**: Human approval gates are configurable per project, defaulting to AI-first (no gates).

**Rationale**: The system should be able to run fully autonomously by default, but organizations may want plan approval before implementation begins, or PR approval before merge. This is a per-project configuration in `agent-orchestrator.yaml`:

```yaml
projects:
  my-app:
    gates:
      plan_approval: false    # default: proceed without human approval
      pr_approval: true       # default: wait for human PR review
```

When a gate is enabled, the system pauses at that phase, posts the artifact (plan or PR) to the tracker, notifies the human, and waits for approval before proceeding.

### AD-5: Central Coordinator + Runner Architecture for Multi-Machine

**Decision**: A single coordinator owns all state and decisions. Runners are execution environments that receive commands via API.

**Rationale**: Simpler than peer-based distributed state. The coordinator already exists (AO's session manager + lifecycle manager). Runners are lightweight — they just need git, tmux, Claude Code, and a small API server. The coordinator handles scheduling, monitoring, and reactions centrally.

**Alternatives considered**:
- *Peer runners with shared state (Redis/Postgres)*: More resilient but complex coordination, duplicate webhook processing, distributed dashboard aggregation. Premature for the scale we're targeting.

### AD-6: Incremental Migration Path

**Decision**: Four independent phases, each delivering standalone value.

**Rationale**: Phase 1 (event-driven spawning) and Phase 2 (PRP integration) are independently valuable and can be developed in parallel. Phase 3 (runner abstraction) is a refactor with no new user-facing features. Phase 4 (multi-runner) adds horizontal scaling. This avoids a big-bang rewrite and lets each phase be validated before building the next.

## 5. Target Architecture

### System Overview

```
                         ┌─────────────────────────────┐
                         │      Tracker Webhooks        │
                         │  (GitHub, Linear, Plane)     │
                         └──────────────┬──────────────┘
                                        │ events
                                        ▼
                         ┌─────────────────────────────┐
                         │      Webhook Receiver        │
                         │  (signature verification,    │
                         │   event normalization)       │
                         └──────────────┬──────────────┘
                                        │ normalized events
                                        ▼
                         ┌─────────────────────────────┐
                         │      Trigger Engine          │
                         │  (configurable rules:        │
                         │   labels, status, assignee)  │
                         └──────────────┬──────────────┘
                                        │ spawn decisions
                                        ▼
  ┌──────────────┐      ┌─────────────────────────────┐      ┌───────────────┐
  │   Tracker     │◄────│      Session Manager         │─────►│   Scheduler   │
  │  (writeback:  │     │  (spawn / monitor / kill /   │      │  (runner      │
  │   comments,   │     │   restore / PRP-aware setup) │      │   selection)  │
  │   status)     │     └──────────────┬──────────────┘      └───────┬───────┘
  └──────────────┘                     │                             │
                                       │ lifecycle polling           │
                                       ▼                             ▼
                         ┌─────────────────────────────┐    ┌───────────────┐
                         │    Lifecycle Manager         │    │  Runner(s)    │
                         │  (state machine, reactions,  │    │  (tmux/proc + │
                         │   escalation timers,         │    │   Claude Code │
                         │   gate enforcement)          │    │   + PRP plugin│
                         └──────────────┬──────────────┘    │   + worktree) │
                                        │                    └───────────────┘
                                        │ events
                            ┌───────────┴───────────┐
                            ▼                       ▼
                  ┌──────────────────┐   ┌──────────────────┐
                  │ Notifier Routing │   │    Dashboard      │
                  │ (desktop, slack, │   │  (Next.js + SSE)  │
                  │  webhook)        │   │                   │
                  └──────────────────┘   └──────────────────┘
```

### New Plugin Slots / Interface Extensions

**Webhook Receiver** (new component, not a plugin slot — it's infrastructure):
- Express routes mounted on the existing Next.js/web server
- Per-tracker signature verification (HMAC for GitHub, token for Linear, etc.)
- Event normalization: all tracker events mapped to a common `TrackerEvent` type

**Trigger Engine** (new component):
- Evaluates normalized events against per-project rules
- Rules configurable in YAML: label matches, status transitions, assignee patterns
- Outputs spawn decisions with full context (issue, repo, trigger reason)

**Tracker Interface Extensions** (extending existing `Tracker` plugin slot):
```typescript
// Added to existing Tracker interface
postComment(issue: string, body: string, project: ProjectConfig): Promise<void>;
updateStatus(issue: string, status: string, project: ProjectConfig): Promise<void>;
getWebhookHandler(): WebhookHandler | null;  // returns verification + parsing logic
```

**Runner Interface** (new plugin slot — Phase 3+):
```typescript
interface Runner {
  readonly name: string;
  register(): Promise<RunnerInfo>;
  heartbeat(): Promise<RunnerHealth>;
  createSession(config: RemoteSessionConfig): Promise<RemoteHandle>;
  destroySession(handle: RemoteHandle): Promise<void>;
  sendMessage(handle: RemoteHandle, message: string): Promise<void>;
  getOutput(handle: RemoteHandle, lines?: number): Promise<string>;
  isAlive(handle: RemoteHandle): Promise<boolean>;
}
```

### Session State Machine Extensions

The existing 13-state machine gains PRP-aware states:

```
[existing]
spawning → working → pr_open → review_pending → approved → mergeable → merged

[new PRP states]
spawning → investigating → planning → [plan_gate] → implementing → pr_open → self_reviewing → ...

[gate states]
plan_gate:  waiting for human plan approval (if configured)
```

The lifecycle manager detects PRP phase transitions by reading agent activity (JSONL log parsing) or metadata updates from the PRP plugin's artifacts.

## 6. Implementation Phases

### Phase 1: Event-Driven Agent Spawning

**Goal**: AO spawns agents automatically in response to tracker webhooks instead of requiring `ao spawn` CLI commands.

**Scope**:
- Webhook receiver endpoints (GitHub first, then Linear, Plane)
- Webhook signature verification per tracker
- Event normalization to common `TrackerEvent` type
- Trigger engine with configurable per-project rules in YAML
- Tracker writeback: `postComment()` and `updateStatus()` on Tracker interface
- Session spawned via existing session manager on trigger match
- Comments posted back to issue at spawn and completion

**Does not include**: PRP methodology, runner abstraction, multi-machine.

**Config example**:
```yaml
projects:
  my-app:
    triggers:
      - on: issue.labeled
        label: "agent-work"
        action: spawn
      - on: issue.assigned
        assignee: "ao-bot"
        action: spawn
    webhooks:
      github:
        secret: ${GITHUB_WEBHOOK_SECRET}
```

**Value**: AO becomes event-driven. Label an issue → agent spawns automatically.

### Phase 2: PRP Lifecycle Integration

**Goal**: Spawned agents follow the PRP methodology instead of improvising from a single prompt.

**Scope**:
- PRP-aware spawn flow: ensure PRP plugin is available in workspace, craft system prompt that instructs agent to use PRP commands
- Agent system prompt template: "You have PRP commands. Start with `/prp-issue-investigate #{issue}`, then `/prp-plan`, then `/prp-ralph`."
- Configurable human gates (plan approval, PR approval) with tracker notification
- PRP phase detection via artifact presence (`.claude/PRPs/issues/`, `.claude/PRPs/plans/`, etc.)
- Commit strategy: agent commits at each PRP phase (investigation, plan, implementation steps)
- Branch naming: `{type}/issue-{number}-{slug}` derived from tracker issue
- Tracker writeback at each phase: investigation summary, plan link, implementation progress, PR link

**Does not include**: Webhook ingestion (uses Phase 1), runner abstraction, multi-machine.

**Value**: Agents produce consistent, high-quality results with traceable artifacts.

### Phase 3: Runner Abstraction Layer

**Goal**: Decouple session execution from the coordinator machine so agents can run anywhere.

**Scope**:
- New `Runner` plugin interface (mirrors `Runtime` but over the network)
- `local` runner implementation (wraps existing `Runtime` — current behavior, zero change)
- `http` runner implementation (calls a remote runner API)
- Runner API server (lightweight Express app for runner machines)
- Session manager updated to route through Runner instead of Runtime directly
- Metadata gains `runner` field to track which machine owns each session

**Does not include**: Scheduling, health monitoring, auto-scaling. The coordinator manually targets a runner or defaults to local.

**Value**: Architecture is ready for multi-machine without requiring it. Single-machine setups work identically.

### Phase 4: Multi-Runner Coordination

**Goal**: A coordinator distributes work across multiple runner machines based on capacity and affinity.

**Scope**:
- Runner registry: runners register with coordinator, send heartbeats
- Scheduler interface with pluggable strategies (round-robin, least-loaded, repo affinity)
- Health monitoring: detect dead runners, reassign/restore orphaned sessions
- Dashboard aggregation across runners
- Runner provisioning CLI: `ao runner add/remove/list`
- Capacity-based concurrency limits per runner

**Does not include**: Auto-scaling, cloud provider integrations, container orchestration.

**Value**: Horizontal scaling. Run 5 agents on 5 machines simultaneously.

### Phase Dependencies

```
Phase 1 (Event-Driven Spawning)  ──────────────────►  Phase 3 (Runner Abstraction)
                                                              │
Phase 2 (PRP Integration)  ─── independent ───               ▼
                                                       Phase 4 (Multi-Runner)
```

Phases 1 and 2 are independent — they can be developed in parallel or in either order. Phase 3 depends on Phase 1 (needs sessions to abstract). Phase 4 depends on Phase 3.

## 7. What We're Not Building

- **A new system from scratch** — we're extending Agent Orchestrator
- **A conversational agent interface** — Remote Coding Agent already does this; we're building autonomous execution
- **Our own SDLC methodology** — the PRP plugin provides this; we're integrating it, not reimplementing it
- **A CI/CD system** — we react to CI results, we don't run CI
- **Cloud infrastructure management** — runners are machines you provision; we don't manage VMs/containers
- **A replacement for human code review** — the system self-reviews and handles routine feedback, but human review remains the quality gate

## 8. Success Criteria

The system is successful when:

1. A human can label a GitHub issue "agent-work" and walk away
2. An agent spawns, investigates, plans, implements, validates, and creates a PR — all without human intervention
3. CI failures and review comments are handled automatically with configurable retry/escalation
4. The human receives a notification only when their judgment is needed (plan approval, stuck agent, PR ready for final review)
5. Every step produces a traceable artifact (investigation report, plan, implementation report, self-review)
6. The system scales horizontally by adding runner machines

## 9. References

| Document | Location |
|----------|----------|
| Architecture research: Agent Orchestrator | `.claude/PRPs/research/2026-02-22-architecture-overview.md` |
| Comparison: AO vs Remote Coding Agent | `.claude/PRPs/research/2026-02-23-comparison-vs-remote-coding-agent.md` |
| Initial vision exploration | `.claude/PRPs/research/2026-02-23-prp-driven-task-runner-vision.md` |
| Agent Orchestrator codebase | `d:\Source\Github\agent-orchestrator` |
| Remote Coding Agent codebase | `D:\Source\Dynamous-community\remote-coding-agent` |
| PRP Agentic SDLC Starter | `D:\Source\TrueNorthTeams\PRPs-agentic-sdlc-starter` |
