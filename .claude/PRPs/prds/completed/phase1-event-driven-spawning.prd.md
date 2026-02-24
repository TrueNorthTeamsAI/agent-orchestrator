# Phase 1: Event-Driven Agent Spawning

## Problem Statement

Agent Orchestrator requires a human to run `ao spawn <project> <issue>` or call `POST /api/spawn` for every task assignment. This means a developer must be present at their terminal to trigger agent work — defeating AO's "push, not pull" principle. Teams cannot label an issue and walk away; someone must watch the tracker and manually translate issue events into spawn commands.

The cost: every issue sits idle until a human notices it and types a command. At scale (10+ issues/day across multiple repos), this manual dispatch becomes the bottleneck — not the agents themselves.

## Evidence

- AO's entire spawn flow is imperative: CLI (`ao spawn`) or REST (`POST /api/spawn`) — no inbound event path exists
- The `Tracker` interface has `updateIssue()` implemented by both GitHub and Linear plugins, but **nothing in AO's core ever calls it** — writeback capability exists but is unused
- The SSE endpoint only sends `{ type: "snapshot" }` — no fine-grained event types reach the browser
- The vision document (`.claude/PRPs/prds/vision-prp-task-runner.md`) identifies this as the foundational gap blocking autonomous operation

## Proposed Solution

Add webhook receiver endpoints to the existing Next.js web server, a trigger engine that evaluates incoming events against per-project rules, and tracker writeback so AO posts progress comments back to issues. When a trigger matches (e.g., issue labeled "agent-work"), AO spawns a session using the existing `SessionManager.spawn()` — no changes to the spawn pipeline itself.

GitHub and Plane are the two supported webhook sources in Phase 1. The trigger engine is tracker-agnostic — it evaluates normalized `TrackerEvent` objects, so adding future trackers (Linear, Jira) requires only a new webhook handler and normalizer.

## Key Hypothesis

We believe that **automatic agent spawning from tracker webhooks** will **eliminate manual dispatch overhead** for teams using AI coding agents. We'll know we're right when **a labeled issue results in a spawned agent with zero human commands**, and the issue receives status comments at spawn and completion.

## What We're NOT Building

- **PRP methodology integration** — agents still get a prompt and work; structured SDLC is Phase 2
- **Runner abstraction** — sessions run on the local machine only; Phase 3
- **Multi-machine distribution** — single coordinator; Phase 4
- **Linear webhook support** — Won't for Phase 1 (can be added later using the same `TrackerEvent` normalization)
- **Jira webhook support** — Could for future; documented but not implemented
- **Polling fallback** — webhooks only; polling can be added later using AO's existing interval pattern
- **Authentication/authorization on webhook endpoints** — signature verification is the auth layer; no user auth
- **Dashboard UI for webhook config** — config is YAML-only in Phase 1
- **Webhook delivery retry/queue** — process inline; return 200 fast; rely on tracker retry policies

## Success Metrics

| Metric | Target | How Measured |
|--------|--------|--------------|
| End-to-end latency: issue event → session spawned | < 10 seconds | Timestamp diff between webhook receipt and session metadata `createdAt` |
| Webhook signature verification | 100% of requests verified | Reject count in logs for invalid signatures |
| Tracker writeback | Comment posted on spawn + completion | GitHub/Plane issue comment count |
| Duplicate spawn prevention | 0 duplicate sessions per issue | Session list filtered by issueId |
| False trigger rate | 0 unwanted spawns | Trigger evaluation logs |

## Open Questions

- [ ] Should webhook endpoints require an additional shared secret beyond tracker signature verification (defense in depth)?
- [ ] What is the Plane issue payload schema for `data` field? (Official docs don't publish full field names — need to inspect a live payload)
- [ ] Should the trigger engine support `issue.opened` as a trigger type, or only `labeled`/`assigned`?
- [ ] How should the system handle webhook events for projects not configured in `agent-orchestrator.yaml`?
- [ ] Should duplicate spawn prevention use in-memory state or check existing sessions via `sessionManager.list()`?

---

## Users & Context

**Primary User**
- **Who**: Developer or team lead who manages AI coding agents across multiple repositories
- **Current behavior**: Watches issue tracker, identifies work items, runs `ao spawn my-app 42` manually for each one
- **Trigger**: A new issue is triaged and ready for agent work (labeled, assigned, or status-changed)
- **Success state**: Label the issue → walk away → agent spawns, works, posts comments, creates PR

**Job to Be Done**
When an issue is triaged and ready for agent work, I want the system to automatically spawn an agent for it, so I can focus on higher-judgment work instead of dispatching agents manually.

**Non-Users**
- End users of the software being built (they interact with the tracker, not with AO)
- CI/CD systems (AO reacts to CI results via lifecycle manager, not via webhooks)
- Agents themselves (they don't know about webhooks; they just receive a prompt)

---

## Solution Detail

### Core Capabilities (MoSCoW)

| Priority | Capability | Rationale |
|----------|------------|-----------|
| Must | GitHub webhook receiver with HMAC-SHA256 verification | Primary tracker; most users are on GitHub |
| Must | Plane webhook receiver with HMAC-SHA256 verification | Required per user; second tracker for Phase 1 |
| Must | Event normalization to common `TrackerEvent` type | Trigger engine must be tracker-agnostic |
| Must | Trigger engine with configurable per-project rules | Core value: decide WHEN to spawn |
| Must | Duplicate spawn prevention | Prevent spawning two agents for the same issue |
| Must | Tracker writeback: comment on spawn | User sees "AO is working on this" on the issue |
| Must | Tracker writeback: comment on completion | User sees "AO finished — PR #N created" on the issue |
| Should | Delivery ID-based idempotency (dedup retried webhooks) | GitHub and Plane both retry on timeout |
| Should | Trigger rule: `issue.labeled` with label match | Most common trigger pattern |
| Should | Trigger rule: `issue.assigned` with assignee match | Second most common pattern |
| Should | Event logging (delivery ID, event type, trigger result) | Debugging and audit trail |
| Could | Trigger rule: `issue.opened` (spawn on creation) | Useful for fully automated repos |
| Could | Trigger rule: `issue.reopened` | Re-spawn on reopened issues |
| Could | Jira webhook support documentation | Document the extension point for future |
| Won't | Linear webhook support | Deferred; can reuse TrackerEvent normalization later |
| Won't | Dashboard UI for webhook management | YAML config is sufficient for Phase 1 |
| Won't | Webhook delivery queue/retry | Process inline; trackers handle retry |

### MVP Scope

The minimum to validate the hypothesis:
1. GitHub webhook endpoint with signature verification
2. Plane webhook endpoint with signature verification
3. Trigger engine that matches `issue.labeled` events against a configured label
4. Auto-spawn via `sessionManager.spawn()` on trigger match
5. Comment posted to issue on spawn ("Agent session started")

### User Flow

```
[Developer]                    [GitHub/Plane]                [AO Web Server]              [AO Core]
     |                              |                              |                          |
     |-- Labels issue "agent-work" →|                              |                          |
     |                              |-- POST /api/webhooks/github →|                          |
     |                              |                              |-- Verify signature        |
     |                              |                              |-- Normalize to TrackerEvent|
     |                              |                              |-- Evaluate trigger rules   |
     |                              |                              |-- Match! →                |
     |                              |                              |          spawn(project, issue)
     |                              |                              |                          |
     |                              |                              |←── session created ───────|
     |                              |                              |-- Post comment to issue    |
     |                              |←── "AO spawned session X" ──|                          |
     |                              |                              |                          |
     |←── (sees comment on issue) ──|                              |                          |
     |                              |                              |                          |
     |   ... agent works ...        |                              |    lifecycle manager      |
     |                              |                              |    monitors session       |
     |                              |                              |                          |
     |                              |                              |←── session complete ──────|
     |                              |                              |-- Post comment to issue    |
     |                              |←── "PR #N created" ─────────|                          |
     |←── (sees completion comment)─|                              |                          |
```

---

## Technical Approach

**Feasibility**: HIGH

The existing codebase provides everything needed:
- `SessionManager.spawn()` already handles the full spawn pipeline (validate → reserve ID → worktree → launch agent → write metadata)
- `Tracker.updateIssue()` with `comment` field is already implemented in GitHub and Linear plugins — just never called by core
- Next.js App Router supports raw body access via `request.text()` — no middleware changes needed
- Config system uses Zod with `.passthrough()` on tracker config — new fields can be added without breaking existing configs
- Plugin registry already resolves tracker per project — webhook handler can look up the right tracker

**Key technical decisions:**

1. **Webhook routes live in the web package** (`packages/web/src/app/api/webhooks/[provider]/route.ts`) — they're HTTP endpoints, not core logic
2. **Trigger engine lives in core** (`packages/core/src/trigger-engine.ts`) — it's business logic independent of HTTP
3. **`TrackerEvent` is a new core type** — normalized event representation that all webhook providers map to
4. **No new plugin slot** — webhook handling is infrastructure, not a swappable abstraction
5. **Writeback uses existing `Tracker.updateIssue()`** — no new interface methods needed; just need to call `updateIssue({ comment: "..." })` from the trigger engine

**Architecture notes:**
- Webhook route → normalize → trigger engine → `sessionManager.spawn()` → `tracker.updateIssue({ comment })`
- The trigger engine receives a `TrackerEvent` + the full `OrchestratorConfig` and returns a `SpawnDecision | null`
- Duplicate detection: check `sessionManager.list()` for active sessions with the same `issueId` + `projectId`

**Technical Risks**

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Plane webhook payload schema undocumented | HIGH | Log first live payload; build normalizer from actual data; use permissive Zod schema with `.passthrough()` |
| Webhook endpoint exposed without auth beyond signature | MED | Signature verification IS the auth; optionally add IP allowlisting later |
| Race condition: two webhooks for same issue arrive simultaneously | MED | Check for existing session before spawning; accept that a narrow race window exists (atomic session ID reservation prevents true duplicates) |
| `gh` CLI rate limits on writeback | LOW | Writeback is fire-and-forget; failure to comment doesn't block the spawn |
| Next.js 15 params Promise change breaks dynamic routes | LOW | Use `await params` pattern per Next.js 15 docs |

---

## Config Schema

### New Config Sections

```yaml
# Top-level: webhook server config
webhooks:
  # Optional: path prefix for webhook routes (default: /api/webhooks)
  basePath: /api/webhooks

# Per-project: triggers and webhook secrets
projects:
  my-app:
    repo: "org/my-app"
    path: "~/code/my-app"

    # NEW: webhook secrets per tracker provider
    webhooks:
      github:
        secret: ${GITHUB_WEBHOOK_SECRET}    # HMAC-SHA256 secret
      plane:
        secret: ${PLANE_WEBHOOK_SECRET}     # HMAC-SHA256 secret
        workspaceId: "c467e125-..."          # Plane workspace UUID

    # NEW: trigger rules — when to auto-spawn
    triggers:
      - on: issue.labeled         # event type
        label: "agent-work"       # filter: which label triggers
        action: spawn             # what to do

      - on: issue.assigned        # event type
        assignee: "ao-bot"        # filter: which assignee triggers
        action: spawn

      - on: issue.opened          # event type
        action: spawn             # spawn on any new issue (no filter)
```

### Trigger Rule Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `on` | enum | yes | Event type: `issue.labeled`, `issue.assigned`, `issue.opened`, `issue.reopened` |
| `label` | string | no | Label name to match (only for `issue.labeled`) |
| `assignee` | string | no | Assignee login to match (only for `issue.assigned`) |
| `action` | enum | yes | What to do: `spawn` (only action in Phase 1) |

### TrackerEvent Type (normalized)

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `"github" \| "plane"` | Source tracker |
| `deliveryId` | string | Unique delivery ID for idempotency |
| `event` | string | Normalized event type (e.g., `issue.labeled`) |
| `action` | string | Raw action from provider |
| `issue` | object | `{ id, number, title, state, labels, assignees, url }` |
| `repo` | string | `"owner/repo"` format (GitHub) or workspace+project (Plane) |
| `label?` | string | Label that was added (for `labeled` events) |
| `assignee?` | string | Assignee login (for `assigned` events) |
| `sender` | string | Who triggered the event |
| `timestamp` | string | ISO 8601 timestamp |
| `raw` | unknown | Original payload for debugging |

### Webhook Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/webhooks/github` | GitHub webhook receiver |
| `POST` | `/api/webhooks/plane` | Plane webhook receiver |

Both endpoints:
1. Read raw body via `request.text()`
2. Verify HMAC-SHA256 signature (GitHub: `X-Hub-Signature-256` with `sha256=` prefix; Plane: `X-Plane-Signature` bare hex)
3. Normalize payload to `TrackerEvent`
4. Pass to trigger engine
5. Return 200 immediately (even if spawn fails — log the error)

### Project-to-Webhook Matching

When a webhook arrives, the system must determine which project config it belongs to:
- **GitHub**: Match `payload.repository.full_name` against `project.repo` in config
- **Plane**: Match `payload.workspace_id` against `project.webhooks.plane.workspaceId` in config

If no project matches, log and discard (200 response to prevent retries).

---

## Tracker Writeback

### Comment Templates

**On spawn:**
```
🤖 **Agent Orchestrator** spawned session `{sessionId}` for this issue.

Branch: `{branch}`
Agent: {agentName}
```

**On completion (PR created):**
```
🤖 **Agent Orchestrator** completed work on this issue.

Pull Request: {prUrl}
Session: `{sessionId}`
```

**On failure/stuck:**
```
🤖 **Agent Orchestrator** session `{sessionId}` needs attention.

Status: {status}
```

### Writeback Triggers

| Event | Comment | Method |
|-------|---------|--------|
| Session spawned | "Agent spawned" | `tracker.updateIssue(id, { comment }, project)` |
| PR created | "PR created: {url}" | `tracker.updateIssue(id, { comment }, project)` |
| Session stuck/errored | "Needs attention" | `tracker.updateIssue(id, { comment }, project)` |

The lifecycle manager already detects these state transitions. Writeback hooks into the existing `executeReaction()` pipeline or adds a new reaction type.

---

## Implementation Phases

| # | Phase | Description | Status | Parallel | Depends | PRP Plan |
|---|-------|-------------|--------|----------|---------|----------|
| 1 | Core Types & Config | `TrackerEvent` type, trigger rule Zod schema, config schema extensions | complete | with 2 | - | `.claude/PRPs/plans/completed/phase1-event-driven-spawning.plan.md` |
| 2 | Webhook Receivers | GitHub + Plane route handlers with signature verification | complete | with 1 | - | `.claude/PRPs/plans/completed/phase1-event-driven-spawning.plan.md` |
| 3 | Trigger Engine | Rule evaluation, project matching, duplicate detection, spawn dispatch | complete | - | 1, 2 | `.claude/PRPs/plans/completed/phase1-event-driven-spawning.plan.md` |
| 4 | Tracker Writeback | Call `updateIssue({ comment })` on spawn/completion/error; add Plane tracker plugin | complete | - | 3 | `.claude/PRPs/plans/completed/phase1-event-driven-spawning.plan.md` |
| 5 | Integration Testing | End-to-end: webhook → trigger → spawn → writeback | complete | - | 4 | `.claude/PRPs/plans/completed/phase1-event-driven-spawning.plan.md` |

### Phase Details

**Phase 1: Core Types & Config**
- **Goal**: Define the data model and config schema that all other phases depend on
- **Scope**: `TrackerEvent` interface, `TriggerRule` type, `WebhookConfig` type, Zod schemas for config validation, extend `ProjectConfigSchema`
- **Success signal**: `pnpm typecheck` passes with new types; existing config still validates

**Phase 2: Webhook Receivers**
- **Goal**: Accept and verify webhook deliveries from GitHub and Plane
- **Scope**: Two Next.js route handlers (`/api/webhooks/github`, `/api/webhooks/plane`), HMAC-SHA256 verification, payload normalization to `TrackerEvent`
- **Success signal**: Can `curl` a signed payload and get 200; unsigned payload gets 401

**Phase 3: Trigger Engine**
- **Goal**: Evaluate normalized events against project trigger rules and spawn sessions
- **Scope**: `evaluateTriggers(event, config)` → `SpawnDecision | null`, project-to-webhook matching, duplicate detection via `sessionManager.list()`, call `sessionManager.spawn()`
- **Success signal**: Unit tests pass for all trigger rule types; integration test spawns a session from a mock webhook

**Phase 4: Tracker Writeback**
- **Goal**: Post comments to issues at key lifecycle moments; create Plane tracker plugin
- **Scope**: New `tracker-plane` plugin implementing `Tracker` interface (at minimum `getIssue`, `updateIssue`, `branchName`, `generatePrompt`), writeback hooks in trigger engine (on spawn) and lifecycle manager (on completion/error)
- **Success signal**: Issue receives comments at spawn and PR creation; Plane issues get comments too

**Phase 5: Integration Testing**
- **Goal**: Validate the full pipeline works end-to-end
- **Scope**: Test fixtures for GitHub and Plane webhook payloads, integration tests covering the full flow, manual testing with real webhooks
- **Success signal**: `pnpm test` passes; manual test with a real GitHub webhook spawns a session and posts a comment

### Parallelism Notes

Phases 1 and 2 can run in parallel in separate worktrees — Phase 1 defines types, Phase 2 writes route handlers. They merge at Phase 3 which needs both. Phase 4 (Plane tracker plugin + writeback) is a significant piece that depends on the trigger engine being functional.

---

## Decisions Log

| Decision | Choice | Alternatives | Rationale |
|----------|--------|--------------|-----------|
| Webhook receiver location | Next.js API routes | Separate Express server; Next.js middleware | API routes follow existing pattern (POST /api/spawn); no custom server needed |
| Trigger engine location | `packages/core/` | `packages/web/` | Business logic belongs in core; testable without HTTP |
| Tracker writeback method | Existing `updateIssue({ comment })` | New `postComment()` method | `updateIssue` already exists and is implemented; avoid interface churn |
| Project matching | `repo` field for GitHub; `workspaceId` for Plane | URL-based matching | Direct field match is unambiguous; repo is already required in config |
| Duplicate prevention | Check `sessionManager.list()` | In-memory Set; Redis | No new infrastructure; session list is the source of truth; accept narrow race window |
| Plane tracker plugin | New plugin in Phase 1 | Defer to later phase | Plane is Must-have per requirements; need `updateIssue` for writeback |

---

## Research Summary

**Market Context**
- GitHub webhooks are mature: HMAC-SHA256 via `X-Hub-Signature-256`, `issues` event with `labeled`/`assigned`/`opened` actions, well-documented payload schema
- Plane webhooks exist but are less mature: HMAC-SHA256 via `X-Plane-Signature` (bare hex, no prefix), `issue` event with `create`/`update`/`delete` actions, **payload `data` field schema is not publicly documented** — requires live payload inspection
- Both provide delivery IDs for idempotency (`X-GitHub-Delivery`, `X-Plane-Delivery`)
- Neither provides timestamp headers — replay prevention relies on idempotency, not time windows

**Technical Context**
- Next.js 15 App Router: `request.text()` gives raw body for signature verification; no `bodyParser` config needed
- Next.js 15 breaking change: `context.params` is now a Promise — must `await params`
- Existing `Tracker.updateIssue()` is implemented by GitHub and Linear plugins but **never called by core** — ready to use for writeback
- `SessionManager.spawn()` has atomic session ID reservation (retry loop up to 10) — prevents true duplicate sessions even under race conditions
- No Plane code exists anywhere in the codebase — `tracker-plane` plugin must be created from scratch, following the `tracker-github` pattern

---

*Generated: 2026-02-23*
*Status: COMPLETE*
*Parent: `.claude/PRPs/prds/vision-prp-task-runner.md` (Phase 1)*
