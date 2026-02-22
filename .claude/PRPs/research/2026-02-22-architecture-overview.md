---
date: 2026-02-22T00:00:00Z
git_commit: ade1322
branch: main
repository: agent-orchestrator
topic: "Architecture, How It Works, and Key Features"
tags: [research, codebase, architecture, plugins, lifecycle, sessions]
status: complete
last_updated: 2026-02-22
---

# Research: Architecture, How It Works, and Key Features

**Date**: 2026-02-22
**Git Commit**: ade1322
**Branch**: main
**Repository**: agent-orchestrator

## Research Question

Can you research this codebase and tell me what the architecture is, how it works, and what its key features are?

## Summary

Agent Orchestrator is a stateless, plugin-based system for spawning and managing parallel AI coding agents. It uses 8 swappable plugin slots (runtime, agent, workspace, tracker, SCM, notifier, terminal, lifecycle), flat-file metadata for session state, a 30-second polling lifecycle manager for automated reactions, and a Next.js dashboard with SSE for real-time visibility. The core design principle is "push, not pull" — agents run autonomously and humans are notified only when intervention is needed.

## Detailed Findings

### 1. Monorepo Structure

The project is a TypeScript ESM monorepo managed by pnpm workspaces with 4 top-level packages:

| Package | npm Name | Purpose |
|---------|----------|---------|
| `packages/core/` | `@composio/ao-core` | Types, config, session manager, lifecycle manager, plugin registry, metadata I/O |
| `packages/cli/` | `@composio/ao-cli` | The `ao` CLI (Commander.js) |
| `packages/web/` | `@composio/ao-web` | Next.js 15 App Router dashboard |
| `packages/plugins/` | `@composio/ao-plugin-*` | 17 plugin implementations across 7 slots |

### 2. Plugin Architecture (8 Slots)

All interfaces are defined in `packages/core/src/types.ts:195-688`. Every plugin exports `{ manifest, create }` satisfying `PluginModule<T>` with inline `satisfies` for compile-time checking.

| Slot | Interface | Implementations | Default |
|------|-----------|----------------|---------|
| Runtime | `Runtime` | tmux, process | tmux |
| Agent | `Agent` | claude-code, codex, aider, opencode | claude-code |
| Workspace | `Workspace` | worktree, clone | worktree |
| Tracker | `Tracker` | github, linear | github |
| SCM | `SCM` | github | github |
| Notifier | `Notifier` | desktop, slack, composio, webhook | desktop |
| Terminal | `Terminal` | iterm2, web | iterm2 |

The plugin registry (`packages/core/src/plugin-registry.ts:1-119`) stores plugins in a `Map<"slot:name", {manifest, instance}>`. Plugins are loaded via dynamic `import()` in CLI context or static imports in the web context (webpack limitation).

### 3. Session Lifecycle

#### State Machine (`packages/core/src/types.ts:26-42`)

```
spawning → working → pr_open → ci_failed ↘
                             ↘ review_pending → changes_requested
                             ↘ approved → mergeable → merged
needs_input ↕ stuck ↕
killed / errored / done / terminated (terminal states)
```

#### Spawn Flow (`packages/core/src/session-manager.ts:315-548`)

1. Validate project config and resolve plugins (`session-manager.ts:321-325`)
2. Validate issue exists via tracker before creating resources (`session-manager.ts:330-345`)
3. Atomically reserve session ID via `O_CREAT | O_EXCL` file creation (`metadata.ts:262`)
4. Create git worktree via workspace plugin (`session-manager.ts:393-428`)
5. Build agent launch command and environment (`session-manager.ts:450-491`)
6. Create runtime (tmux session) with the agent command (`session-manager.ts:450-491`)
7. Write flat-file metadata (`session-manager.ts:510-521`)
8. Run post-launch hooks (e.g., write `.claude/settings.json` for auto-metadata) (`session-manager.ts:522-523`)

### 4. Flat-File Metadata (`packages/core/src/metadata.ts`)

All session state is persisted as `key=value` files at `~/.agent-orchestrator/{hash}-{projectId}/sessions/{sessionId}`. The `{hash}` is the first 12 chars of `sha256(dirname(configPath))` (`packages/core/src/paths.ts:20-25`), namespacing data by config location.

Example file:
```
project=integrator
worktree=/path/to/worktree
branch=feat/INT-1234
status=working
tmuxName=a3b4c5d6e7f8-int-1
pr=https://github.com/org/repo/pull/42
```

Key operations: `reserveSessionId` (atomic via `O_EXCL`), `writeMetadata` (full overwrite), `updateMetadata` (read-merge-write), `deleteMetadata` (archive + unlink) — all at `metadata.ts:84-273`.

### 5. Lifecycle Manager — Polling & Reactions (`packages/core/src/lifecycle-manager.ts`)

A 30-second `setInterval` loop (`lifecycle-manager.ts:563`) polls all active sessions:

1. `pollAll()` at line 504 calls `sessionManager.list()`, then `checkSession()` per session via `Promise.allSettled`
2. `determineStatus()` at line 182 checks: runtime alive → agent activity → PR/CI/review state
3. On state transition, maps to `EventType` and either triggers a **reaction** or **notifies** a human

#### Reaction Engine (`lifecycle-manager.ts:272-396`)

Reactions auto-handle routine events with escalation:

| Reaction | Action | Escalation |
|----------|--------|-----------|
| `ci-failed` | Send fix instructions to agent | After 2 retries |
| `changes-requested` | Send review comments to agent | After 30 minutes |
| `merge-conflicts` | Send rebase instructions to agent | After 15 minutes |
| `agent-stuck` | Notify human | Immediate (urgent) |
| `agent-needs-input` | Notify human | Immediate (urgent) |
| `approved-and-green` | Notify human | Immediate (action) |

Each reaction tracks `{attempts, firstTriggered}` per session. When retries or time thresholds are exceeded, the reaction escalates to human notification with `"urgent"` priority.

### 6. Notification Routing (`lifecycle-manager.ts:399-413`)

`notifyHuman()` routes events by priority to configured notifier plugins:

```yaml
urgent:  [desktop, composio]
action:  [desktop, composio]
warning: [composio]
info:    [composio]
```

Routing is configurable via `notificationRouting` in YAML config (`config.ts:99-104`).

### 7. Agent Activity Detection

The Claude Code agent plugin (`packages/plugins/agent-claude-code/src/index.ts:646-703`) reads Claude's JSONL session log at `~/.claude/projects/{encoded-path}/*.jsonl` to determine activity state:

- `user`/`tool_use`/`progress` → `active` or `idle` (if past threshold)
- `assistant`/`summary`/`result` → `ready` or `idle`
- `permission_request` → `waiting_input`
- `error` → `blocked`

### 8. Auto-Metadata via Workspace Hooks

The Claude Code plugin writes a bash hook to `.claude/settings.json` in every workspace (`agent-claude-code/src/index.ts:31-167`). This PostToolUse hook intercepts `gh pr create`, `git checkout -b`, and `gh pr merge` commands from within the agent and atomically updates the flat-file metadata. This is how the dashboard sees PRs without polling GitHub.

### 9. Configuration System (`packages/core/src/config.ts`)

- YAML config discovered by walking up from `cwd` (like git), or via `AO_CONFIG_PATH` env var (`config.ts:289-349`)
- Validated with Zod schemas with sensible defaults (`config.ts:84-106`)
- Path expansion (`~/`), project defaults derivation, session prefix generation, and reaction defaults all applied at load time (`config.ts:361-414`)
- Uniqueness validation prevents duplicate project paths or session prefixes (`config.ts:158-212`)

### 10. Web Dashboard (`packages/web/`)

- Next.js 15 App Router with SSR session list and client-side Kanban dashboard
- SSE endpoint (`app/api/events/route.ts`) polls `sessionManager.list()` every 5 seconds, emits snapshots
- REST APIs for spawn, kill, send, restore, merge (`app/api/`)
- WebSocket bridges for tmux terminal access (`server/terminal-websocket.ts`)
- Services singleton cached on `globalThis` to survive HMR (`lib/services.ts:1-83`)

### 11. CLI Commands (`packages/cli/src/commands/`)

| Command | Purpose |
|---------|---------|
| `ao init` | Initialize config file |
| `ao start` | Start dashboard + orchestrator agent |
| `ao spawn` | Spawn a session for an issue |
| `ao batch-spawn` | Spawn multiple sessions |
| `ao status` | Show session statuses |
| `ao session` | Session management |
| `ao send` | Send message to a session |
| `ao review-check` | Check PR review state |
| `ao dashboard` | Open dashboard |
| `ao open` | Open session in terminal |

## Code References

| File | Lines | Description |
|------|-------|-------------|
| `packages/core/src/types.ts` | 1-1084 | All interfaces and type definitions |
| `packages/core/src/config.ts` | 25-422 | YAML loading, Zod validation, defaults |
| `packages/core/src/session-manager.ts` | 165-1096 | Session CRUD, spawn, kill, restore |
| `packages/core/src/lifecycle-manager.ts` | 172-587 | Polling loop, state machine, reactions |
| `packages/core/src/plugin-registry.ts` | 1-119 | Plugin discovery and registration |
| `packages/core/src/metadata.ts` | 1-273 | Flat-file key=value I/O |
| `packages/core/src/paths.ts` | 1-194 | Hash-based directory structure |
| `packages/core/src/prompt-builder.ts` | — | Agent prompt construction |
| `packages/plugins/agent-claude-code/src/index.ts` | 31-703 | Claude Code agent + workspace hooks |
| `packages/plugins/runtime-tmux/src/index.ts` | 19-184 | tmux runtime implementation |
| `packages/web/src/app/api/events/route.ts` | 1-103 | SSE real-time endpoint |
| `packages/web/src/lib/services.ts` | 1-83 | Next.js service singleton |
| `packages/cli/src/index.ts` | — | CLI entry point |

## Architecture Documentation

### Design Decisions

1. **Stateless orchestrator** — no database; flat metadata files + JSONL event log
2. **Plugin-per-slot** — every abstraction (runtime, agent, workspace, tracker, SCM, notifier, terminal) is swappable via a typed interface
3. **Push notifications** — the Notifier is the primary human interface; dashboard is secondary
4. **Two-tier event handling** — reactions auto-handle routine issues (CI failures, review comments); escalate to human notification after retries/timeout
5. **Atomic session reservation** — `O_EXCL` file creation prevents concurrent ID collisions
6. **Hash-namespaced storage** — multiple independent orchestrator configs can coexist
7. **Agent hook injection** — workspace hooks auto-update metadata from within the agent process, avoiding polling

### Key Conventions

- All imports use `.js` extensions (ESM requirement)
- Node builtins use `node:` prefix
- All subprocess calls use `execFile` with timeouts (never `exec`)
- Plugin exports use inline `satisfies PluginModule<T>`
- JSON.parse always wrapped in try/catch
- Session IDs validated with `/^[a-zA-Z0-9_-]+$/` before file path construction

## Open Questions

- No open questions — the architecture, workflow, and feature set are well-documented by the codebase itself.
