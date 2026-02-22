---
date: 2026-02-23T00:00:00Z
git_commit: ade1322
branch: main
repository: agent-orchestrator
topic: "Vision: PRP-Driven Task Runner System"
tags: [research, vision, prp, task-runner, architecture]
status: complete
last_updated: 2026-02-23
---

# Vision: PRP-Driven Task Runner System

## What You're Describing

A system that:

1. **Connects to task trackers** (GitHub Issues, Linear, Plane) and watches for actionable work items
2. **Automatically picks them up** based on configurable triggers (labels, status changes, assignments)
3. **Executes the PRP lifecycle** to do the work: investigate → plan → implement → validate → PR → review
4. **Manages the full CI/review loop** autonomously, escalating to humans only when judgment is needed

This doesn't exist yet as a single system. But the three codebases you've been looking at each contribute a major piece:

## What Each System Brings

### Agent Orchestrator — The Autonomous Lifecycle Engine
- Parallel session spawning and management (tmux/process runtimes)
- 30-second polling lifecycle manager with state machine (13 states)
- Reaction engine: auto-handles CI failures, review comments, merge conflicts with retry/escalation
- Push notification routing by priority (desktop, Slack, webhook, Composio)
- Plugin architecture (8 typed slots, 17 implementations)
- Worktree-per-session isolation
- Dashboard with SSE real-time updates
- **Gap**: Agents receive a single prompt at spawn — no structured methodology for how the work gets done

### Remote Coding Agent — The Platform Bridge
- Adapters for Telegram, Discord, GitHub webhooks, Jira webhooks
- Webhook verification (HMAC-SHA256 for GitHub)
- Conversation lock manager (sequential per conversation, global concurrency cap)
- AI client factory (Claude SDK, Codex SDK) with session resume
- Stream vs batch output modes per platform
- Per-platform user whitelists
- Worktree-per-issue with PR↔issue sharing
- **Gap**: Conversational, not autonomous — human must direct every step

### PRP Agentic SDLC Starter — The Methodology
- Complete lifecycle: PRD → Plan → Implement → Validate → Commit → PR → Review
- Ralph loop: autonomous iteration with Stop hook mechanism until all validations pass
- 6-level validation (lint → types → tests → build → e2e → manual)
- 10 specialized sub-agents (explorer, analyst, reviewer, simplifier, etc.)
- Artifact system: plans, reports, investigations archived with git metadata
- Context map system for pulling in external knowledge
- Plane integration for work item tracking
- **Gap**: It's a Claude Code plugin — requires a human to invoke `/prp-plan`, `/prp-implement`, etc.

## The Missing System

What you need is a **PRP Task Runner** that combines:

| Capability | Source |
|-----------|--------|
| Watch trackers for new work | New (tracker polling/webhooks like AO + RCA) |
| Decide what to work on | New (priority rules, label triggers, assignment detection) |
| Spawn an agent per work item | Agent Orchestrator's session manager |
| Execute PRP lifecycle in that agent | PRP starter's commands as the agent's instructions |
| Monitor progress and auto-handle failures | Agent Orchestrator's lifecycle manager + reactions |
| Report back to the tracker | Remote Coding Agent's platform adapters |
| Escalate to humans when stuck | Agent Orchestrator's notification routing |

### The Core Loop

```
WATCH: Poll trackers for actionable items
  ↓
CLAIM: Assign the item to the bot, mark as in-progress
  ↓
SPAWN: Create worktree + runtime + agent session
  ↓
INVESTIGATE: Agent runs PRP investigate on the issue
  ↓
PLAN: Agent runs PRP plan (or loads attached PRD)
  ↓
IMPLEMENT: Agent runs PRP Ralph loop (autonomous until validations pass)
  ↓
PR: Agent creates PR, links to issue
  ↓
MONITOR: Lifecycle manager watches CI/reviews
  ↓
REACT: Auto-fix CI failures, address review comments
  ↓
COMPLETE: PR merged → mark issue done → archive artifacts
  ↓
NOTIFY: Push summary to human (Slack/desktop/webhook)
```

### What Makes This Different From Just Using Agent Orchestrator

Agent Orchestrator gives agents a single prompt like "Fix issue #123". The agent figures out *how* on its own, which works for simple tasks but produces inconsistent results on complex ones.

The PRP-driven version would:

1. **Structure the work** — investigation → plan → implement is enforced, not optional
2. **Validate continuously** — Ralph loop ensures lint/types/tests/build pass before moving on
3. **Produce artifacts** — every step generates a traceable document (plan, report, review)
4. **Use specialized agents** — explorer + analyst for research, reviewer for self-review, not just a single general-purpose agent
5. **Feed context** — context maps pull in relevant docs, patterns, and domain knowledge automatically

### Key Design Decisions to Make

1. **Trigger model**: Polling trackers on interval vs. receiving webhooks? (AO uses polling, RCA uses webhooks — both valid)
2. **Work item selection**: What criteria determine "actionable"? Labels? Assignment? Status column? Priority?
3. **Single agent per item or pipeline of agents?** One long-lived agent doing investigate→plan→implement, or separate agents for each phase?
4. **Where does PRP logic live?** Baked into the system prompt? Injected as Claude Code plugin? As slash commands the agent self-invokes?
5. **Tracker writeback**: How much should the system report back? Comment per phase? Only on completion? On failure?
6. **Human gates**: Which phases require human approval before proceeding? (Plan approval? PR review?)
