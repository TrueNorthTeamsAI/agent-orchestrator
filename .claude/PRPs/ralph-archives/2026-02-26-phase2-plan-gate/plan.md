# Feature: Plan Gate — Pause/Notify/Resume for PRP Plan Approval

## Summary

When a PRP-enabled project has `gates.plan: true`, the lifecycle manager detects the `planning_complete` phase transition, posts the plan content to the issue tracker, notifies the human, updates metadata to `prpPhase=plan_gate`, and waits. Resumption happens when a human posts an approval comment on the issue (routed via a new `issue_comment` webhook path) or manually via `ao send`. The agent receives a resume message and continues with `/prp-ralph`.

## User Story

As a developer managing AI coding agents
I want auto-spawned agents to pause after creating a plan and wait for my approval
So that I can review the plan before the agent spends time implementing a potentially flawed approach

## Problem Statement

PRP-enabled agents create plans but proceed to implementation immediately. There is no pause point for human review. The `prp.gates.plan` config field exists but is only enforced via agent prompt instructions (no runtime guarantee). If the agent ignores the prompt or context compacts it away, there's no orchestrator-level enforcement.

## Solution Statement

Extend the lifecycle manager's PRP phase detection block to handle a new `planning_complete` phase value. When detected with `gates.plan: true`: post plan to tracker, notify human, set `prpPhase=plan_gate`. Add `issue_comment` webhook handling so approval comments route to `sessionManager.send()` to resume the gated agent. Extend the metadata-updater hook to detect when the agent has finished planning (plan artifacts exist AND implementation hasn't started).

## Metadata

| Field            | Value |
| ---------------- | ----- |
| Type             | NEW_CAPABILITY |
| Complexity       | MEDIUM |
| Systems Affected | lifecycle-manager, metadata-updater hook, webhook route, types, trigger-engine |
| Dependencies     | None (all integration points exist from Phases 1-5) |
| Estimated Tasks  | 8 |

---

## UX Design

### Before State

```
Agent spawns → investigates → creates plan → IMMEDIATELY starts implementing
                                              (no human review point)

Developer sees tracker comments:
  "Started investigating"
  "Creating implementation plan"
  "Implementing the plan"          ← already implementing, too late to review plan
```

### After State

```
Agent spawns → investigates → creates plan → PAUSES
                                              ↓
                              Tracker comment: "Plan created. Review and approve."
                              Notification:    "Review plan for issue #42"
                                              ↓
                              Developer reviews plan on issue
                              Posts: "approved" (or similar)
                                              ↓
                              Webhook → route to session → agent receives resume message
                                              ↓
                              Agent continues → /prp-ralph → implementation
```

### Interaction Changes

| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| Issue tracker | No plan comment | Plan content posted as comment with approval instructions | Can review plan in-context |
| Notifications | No gate notification | "Review plan for issue #N" notification | Knows to review |
| Agent session | Continues automatically | Pauses until resume message | Plan reviewed before implementation |
| Webhook route | Ignores issue comments | Routes approval comments to sessions | Can approve via issue comment |

---

## Mandatory Reading

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `packages/core/src/lifecycle-manager.ts` | 579-602 | PRP phase detection block — insert gate logic here |
| P0 | `packages/core/src/lifecycle-manager.ts` | 274-400 | `executeReaction` and `notifyHuman` — patterns to mirror |
| P0 | `packages/core/src/lifecycle-manager.ts` | 417-484 | `writebackToTracker` and `getPrpWritebackComment` — extend these |
| P1 | `packages/core/src/types.ts` | 698-732 | `EventType` union — add new type |
| P1 | `packages/core/src/types.ts` | 1115-1165 | `TrackerEvent`, `TriggerEventType`, `TriggerRule` — extend for comments |
| P1 | `packages/web/src/app/api/webhooks/github/route.ts` | 18-76 | `normalizeGitHubEvent` — add `issue_comment` handling |
| P1 | `packages/plugins/agent-claude-code/src/index.ts` | 164-198 | Metadata-updater hook — add `planning_complete` detection |
| P2 | `packages/core/src/__tests__/lifecycle-manager.test.ts` | 870-950 | PRP writeback test pattern — mirror for gate tests |
| P2 | `packages/core/src/session-manager.ts` | 904-943 | `send()` — how resume messages reach the agent |

---

## Patterns to Mirror

**PRP_PHASE_WRITEBACK:**
```typescript
// SOURCE: packages/core/src/lifecycle-manager.ts:468-484
// COPY THIS PATTERN for adding planning_complete case:
function getPrpWritebackComment(
  session: Session,
  newPhase: string,
  _oldPhase: string | undefined,
): string | null {
  switch (newPhase) {
    case "investigating":
      return `🔍 **Agent Orchestrator** session \`${session.id}\` started investigating this issue.`;
    case "planning":
      return `📋 **Agent Orchestrator** session \`${session.id}\` is creating an implementation plan.`;
    case "implementing":
      return `🔨 **Agent Orchestrator** session \`${session.id}\` is implementing the plan.`;
    default:
      return null;
  }
}
```

**WRITEBACK_TO_TRACKER:**
```typescript
// SOURCE: packages/core/src/lifecycle-manager.ts:417-432
// Fire-and-forget pattern — never throw, never block:
function writebackToTracker(session: Session, comment: string): void {
  if (!session.issueId) return;
  const project = config.projects[session.projectId];
  if (!project?.tracker) return;
  const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
  if (!tracker?.updateIssue) return;
  const issueId = session.issueId.match(/\/(\d+)$/)?.[1] ?? session.issueId;
  tracker.updateIssue(issueId, { comment }, project).catch(() => {});
}
```

**NOTIFY_HUMAN:**
```typescript
// SOURCE: packages/core/src/lifecycle-manager.ts:400-415
async function notifyHuman(event: OrchestratorEvent, priority: EventPriority): Promise<void> {
  const eventWithPriority = { ...event, priority };
  const notifierNames = config.notificationRouting[priority] ?? config.defaults.notifiers;
  for (const name of notifierNames) {
    const notifier = registry.get<Notifier>("notifier", name);
    if (notifier) {
      try { await notifier.notify(eventWithPriority); } catch { /* swallow */ }
    }
  }
}
```

**CREATE_EVENT:**
```typescript
// SOURCE: packages/core/src/lifecycle-manager.ts:79-100
function createEvent(type: EventType, opts: {
  sessionId: SessionId; projectId: string; message: string;
  priority?: EventPriority; data?: Record<string, unknown>;
}): OrchestratorEvent { /* ... */ }
```

**WEBHOOK_NORMALIZE:**
```typescript
// SOURCE: packages/web/src/app/api/webhooks/github/route.ts:19-76
// Pattern: check eventType, map action to normalized event, extract fields from payload
function normalizeGitHubEvent(
  eventType: string, action: string, deliveryId: string,
  payload: Record<string, unknown>,
): TrackerEvent | null {
  if (eventType !== "issues") return null;
  // ...
}
```

**TEST_PATTERN:**
```typescript
// SOURCE: packages/core/src/__tests__/lifecycle-manager.test.ts:905-932
it("posts investigation comment when prpPhase transitions to investigating", async () => {
  const { mockTracker, registry } = setupTrackerRegistry();
  config.projects["my-app"]!.prp = makePrpConfig();
  config.projects["my-app"]!.tracker = { plugin: "mock-tracker" };
  const session = makeSession({
    status: "working",
    issueId: "https://github.com/org/repo/issues/1",
    metadata: { prpPhase: "investigating" },
  });
  vi.mocked(mockSessionManager.get).mockResolvedValue(session);
  writeMetadata(sessionsDir, "app-1", { worktree: "/tmp", branch: "main", status: "working", project: "my-app" });
  const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });
  await lm.check("app-1");
  expect(mockTracker.updateIssue).toHaveBeenCalledWith(
    "1", expect.objectContaining({ comment: expect.stringContaining("investigating") }), expect.anything(),
  );
});
```

---

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `packages/plugins/agent-claude-code/src/index.ts` | UPDATE | Add `planning_complete` phase detection to metadata-updater hook |
| `packages/core/src/types.ts` | UPDATE | Add `"prp.plan_gate"` to `EventType`, add `"issue.comment"` to `TriggerEventType` and `TrackerEvent.event`, add `"resume-session"` to `TriggerRule.action` |
| `packages/core/src/lifecycle-manager.ts` | UPDATE | Add plan gate logic in PRP phase detection block, add `planning_complete` to writeback comment switch |
| `packages/web/src/app/api/webhooks/github/route.ts` | UPDATE | Handle `issue_comment` webhook events, route approval comments to sessions |
| `packages/core/src/trigger-engine.ts` | UPDATE | Handle `"issue.comment"` event type with `"resume-session"` action |
| `packages/core/src/config.ts` | UPDATE | Add `"plan-gate"` default reaction |
| `packages/core/src/__tests__/lifecycle-manager.test.ts` | UPDATE | Add plan gate tests |
| `packages/web/src/app/api/webhooks/github/__tests__/route.test.ts` | CREATE or UPDATE | Test issue_comment webhook handling |

---

## NOT Building (Scope Limits)

- **PR gate** — `prp.gates.pr` exists in config but is `Could` priority; implement in a follow-up
- **PRP phase-aware reactions** (stuck in planning timeout) — `Could` priority, separate concern
- **CLAUDE.md injection** — `Could` priority, system prompt is sufficient
- **Dashboard UI for gate status** — explicitly excluded in PRD
- **Auto-merge on approval** — existing `approved-and-green` reaction handles this; out of scope

---

## Step-by-Step Tasks

### Task 1: UPDATE metadata-updater hook — add `planning_complete` phase detection

- **ACTION**: Extend the PRP phase detection in the bash hook script at `packages/plugins/agent-claude-code/src/index.ts:164-198`
- **IMPLEMENT**: Add detection for `planning_complete` — when `.claude/PRPs/plans/` exists AND `.claude/PRPs/reports/` does NOT exist (reports indicate implementation started via ralph), the phase should be `planning_complete` instead of just `planning`. The current code writes `planning` when plans exist; change it to distinguish between "plan just created" and "already implementing".

  Logic change:
  ```bash
  # Check for implementation artifacts (reports/ means ralph has started)
  if [[ -d "$worktree/.claude/PRPs/reports" ]] && \
     [[ -n "$(ls -A "$worktree/.claude/PRPs/reports" 2>/dev/null)" ]]; then
    current_phase="implementing"
  # Check for plan artifacts without implementation
  elif [[ -d "$worktree/.claude/PRPs/plans" ]] && \
       [[ -n "$(ls -A "$worktree/.claude/PRPs/plans" 2>/dev/null)" ]]; then
    current_phase="planning_complete"
  # Check for investigation artifacts only
  elif [[ -d "$worktree/.claude/PRPs/investigations" ]] && \
       [[ -n "$(ls -A "$worktree/.claude/PRPs/investigations" 2>/dev/null)" ]]; then
    current_phase="investigating"
  fi
  ```

  **IMPORTANT**: This changes the existing `planning` value to `planning_complete`. The lifecycle manager's `getPrpWritebackComment` must be updated to handle both. The `planning` comment was "is creating a plan" which fires on investigation→planning transition. Now: investigation→`planning_complete` fires when plan artifact appears. Add `implementing` detection for when reports appear.

- **MIRROR**: Existing artifact detection at `index.ts:179-187`
- **GOTCHA**: The `exit 0` at line 195 means only one metadata update per hook invocation. This is fine — each Bash tool call triggers the hook, and artifact directories only grow monotonically.
- **VALIDATE**: `pnpm build --filter @composio/ao-agent-claude-code`

### Task 2: UPDATE `types.ts` — add event types for plan gate and issue comments

- **ACTION**: Extend type unions in `packages/core/src/types.ts`
- **IMPLEMENT**:
  1. Add `| "prp.plan_gate"` to `EventType` union (after `"reaction.escalated"` at line 732)
  2. Add `| "issue.comment"` to `TrackerEvent.event` union (line 1121)
  3. Add `| "issue.comment"` to `TriggerEventType` union (line 1149-1153)
  4. Extend `TriggerRule.action` from just `"spawn"` to `"spawn" | "resume-session"` (line 1164)
  5. Add optional fields to `TriggerRule`: `commentPattern?: string` (regex to match approval comments), `message?: string` (message to send on resume)
- **MIRROR**: Existing union patterns at same locations
- **VALIDATE**: `pnpm typecheck`

### Task 3: UPDATE `lifecycle-manager.ts` — plan gate logic in PRP phase detection

- **ACTION**: Extend PRP phase detection block at `packages/core/src/lifecycle-manager.ts:579-602`
- **IMPLEMENT**:
  1. Add `planning_complete` to the `phaseEnabled` check (line 590-593):
     ```typescript
     (newPrpPhase === "planning_complete" && wb?.plan !== false) ||
     ```
  2. After the writeback block (line 598), add gate check:
     ```typescript
     // Plan gate: if enabled, notify human and update metadata to gate state
     if (newPrpPhase === "planning_complete" && project.prp.gates?.plan) {
       // Post plan content to tracker
       const planComment = await buildPlanGateComment(session);
       writebackToTracker(session, planComment);

       // Notify human
       const event = createEvent("prp.plan_gate", {
         sessionId: session.id,
         projectId: session.projectId,
         message: `Plan ready for review — session ${session.id}`,
         priority: "action",
       });
       await notifyHuman(event, "action");

       // Update metadata to gate state (lifecycle will see this on next poll)
       const sessionsDir = getSessionsDir(config.configPath, project);
       updateMetadata(sessionsDir, session.id, { prpPhase: "plan_gate" });
     }
     ```
  3. Add `getPrpWritebackComment` case for `"planning_complete"`:
     ```typescript
     case "planning_complete":
       return `📋 **Agent Orchestrator** session \`${session.id}\` has completed the implementation plan.`;
     ```
  4. Add `"plan_gate"` case (no writeback needed — the gate comment is already posted above):
     ```typescript
     case "plan_gate":
       return null; // Gate comment already posted in gate logic
     ```
  5. Add helper `buildPlanGateComment(session)`: reads the plan file from `session.workspacePath + "/.claude/PRPs/plans/"`, finds the first `.plan.md` file, reads it (truncate to ~4000 chars for GitHub comment limits), and wraps it in a comment template with approval instructions.

- **IMPORTS**: Add `readdirSync` from `"node:fs"`, `readFileSync` from `"node:fs"`, `join` from `"node:path"` (check if already imported)
- **MIRROR**: `writebackToTracker` fire-and-forget pattern, `notifyHuman` call pattern from `executeReaction` at line 358-365
- **GOTCHA**: `buildPlanGateComment` must be sync or async — since it reads local files (not network), sync is fine. Wrap in try/catch in case workspace files are missing. `getSessionsDir` helper — check if it exists or use the pattern from existing metadata update calls.
- **GOTCHA**: The `updateMetadata` call writes `prpPhase=plan_gate` to the file. On the next poll, the lifecycle manager will see `plan_gate` as the new phase. Since `plan_gate` is not in `phaseEnabled`, no duplicate writeback/notification will fire. The `prpPhases` map will update to `plan_gate`, preventing re-triggering.
- **VALIDATE**: `pnpm typecheck && pnpm lint`

### Task 4: UPDATE `config.ts` — add `plan-gate` default reaction

- **ACTION**: Add default reaction in `packages/core/src/config.ts` in the `applyDefaultReactions` function
- **IMPLEMENT**: Add to the default reactions object:
  ```typescript
  "plan-gate": {
    auto: true,
    action: "notify",
    priority: "action",
    message: "Plan ready for review",
  },
  ```
  This reaction is informational — the actual gate logic is in the lifecycle manager's PRP phase block, not in `executeReaction`. The reaction config here serves as documentation and allows users to override notification priority.
- **MIRROR**: `approved-and-green` reaction pattern at `config.ts:298-303`
- **VALIDATE**: `pnpm typecheck`

### Task 5: UPDATE webhook route — handle `issue_comment` events

- **ACTION**: Extend `packages/web/src/app/api/webhooks/github/route.ts`
- **IMPLEMENT**:
  1. In `normalizeGitHubEvent`, handle `eventType === "issue_comment"`:
     ```typescript
     if (eventType === "issue_comment" && action === "created") {
       const issue = payload.issue as Record<string, unknown>;
       const comment = payload.comment as Record<string, unknown>;
       const repo = payload.repository as Record<string, unknown>;
       const sender = payload.sender as Record<string, unknown>;
       if (!issue || !comment || !repo) return null;

       const labels = (issue.labels as Array<{ name: string }>) ?? [];
       const assignees = (issue.assignees as Array<{ login: string }>) ?? [];

       return {
         provider: "github",
         deliveryId,
         event: "issue.comment" as const,
         action,
         issue: {
           id: String(issue.number),
           number: issue.number as number,
           title: issue.title as string,
           state: issue.state as string,
           labels: labels.map((l) => l.name),
           assignees: assignees.map((a) => a.login),
           url: issue.html_url as string,
         },
         repo: (repo.full_name as string) ?? "",
         sender: sender ? (sender.login as string) : "unknown",
         timestamp: new Date().toISOString(),
         raw: payload,
         commentBody: (comment.body as string) ?? "",
       };
     }
     ```
  2. Add `commentBody?: string` to `TrackerEvent` interface in `types.ts` (optional field, only present for comment events)
  3. In the main `POST` handler, after `evaluateTriggers` returns null for comment events, add a new path: if `trackerEvent.event === "issue.comment"`, call a new `handleIssueComment(trackerEvent, config, sessionManager)` function that:
     - Finds the active session for this issue (same pattern as trigger-engine.ts:131-135)
     - Checks if the session is in `plan_gate` phase (read metadata)
     - Checks if the comment body matches an approval pattern (e.g., contains "approved", "lgtm", "proceed")
     - If all match: calls `sessionManager.send(sessionId, "Plan approved. Continue with /prp-ralph")` and updates metadata `prpPhase=implementing`
     - Posts a confirmation comment on the issue

- **MIRROR**: `normalizeGitHubEvent` pattern for field extraction, `evaluateTriggers` call pattern
- **GOTCHA**: The webhook secret lookup (`findSecret`) matches on `repo` — this works for comment events too since they have the same `repository` payload. Signature verification is the same.
- **GOTCHA**: Approval pattern matching should be case-insensitive and simple: `/\b(approved?|lgtm|proceed|go ahead)\b/i`. Don't over-engineer — this is a human approval signal.
- **GOTCHA**: Idempotency — if two approval comments arrive, the second should be a no-op (session already past `plan_gate`).
- **VALIDATE**: `pnpm typecheck && pnpm build --filter @composio/ao-web`

### Task 6: UPDATE trigger-engine — support `resume-session` action (OPTIONAL)

- **ACTION**: This task is OPTIONAL. The webhook route can handle comment→resume directly without going through the trigger engine. Only implement if we want the trigger engine to be the single routing point for all webhook events.
- **DECISION**: Skip for now. The webhook route handles comment routing directly in Task 5. The trigger engine is designed for spawn decisions, not routing to existing sessions. Adding `resume-session` to `TriggerRule.action` in types (Task 2) enables future migration.
- **VALIDATE**: N/A

### Task 7: UPDATE lifecycle-manager tests — plan gate behavior

- **ACTION**: Add tests to `packages/core/src/__tests__/lifecycle-manager.test.ts`
- **IMPLEMENT**: Add a new `describe("PRP plan gate")` block after the existing "PRP phase writeback" block:
  1. **"posts plan gate comment and notifies when planning_complete with gates.plan enabled"**:
     - Setup: `makePrpConfig({ gates: { plan: true, pr: false } })`, session with `prpPhase: "planning_complete"` and a `workspacePath` pointing to a temp dir with a mock plan file
     - Assert: `mockTracker.updateIssue` called with comment containing plan content and approval instructions
     - Assert: notification was triggered (mock notifier)
  2. **"does not gate when gates.plan is false"**:
     - Setup: `makePrpConfig({ gates: { plan: false, pr: false } })`, session with `prpPhase: "planning_complete"`
     - Assert: writeback comment posted (normal planning_complete comment), NO gate notification
  3. **"does not re-trigger gate on subsequent polls"**:
     - Setup: Same as test 1, but call `lm.check()` twice
     - Assert: `updateIssue` called only once (prpPhases map prevents re-trigger)
  4. **"handles missing plan file gracefully"**:
     - Setup: Session with `planning_complete` but empty `.claude/PRPs/plans/` directory
     - Assert: Still posts a comment (fallback text), doesn't throw
- **MIRROR**: Existing test pattern at `lifecycle-manager.test.ts:905-932`
- **VALIDATE**: `pnpm test --filter @composio/ao-core`

### Task 8: UPDATE webhook route tests — issue comment handling

- **ACTION**: Add tests for issue_comment webhook handling
- **IMPLEMENT**: Test cases:
  1. **"routes approval comment to gated session"**: Mock session in `plan_gate` phase, send `issue_comment` webhook with "approved" body, assert `sessionManager.send` called
  2. **"ignores non-approval comments"**: Send comment with "looks interesting" body, assert `sessionManager.send` NOT called
  3. **"ignores comments when no session is in plan_gate"**: Send approval comment but session is in `implementing` phase, assert no action
  4. **"handles duplicate approval idempotently"**: Two approval webhooks, second is no-op
- **VALIDATE**: `pnpm test --filter @composio/ao-web`

---

## Testing Strategy

### Unit Tests to Write

| Test File | Test Cases | Validates |
|-----------|------------|-----------|
| `packages/core/src/__tests__/lifecycle-manager.test.ts` | Gate trigger, no-gate pass-through, dedup, missing plan | Plan gate lifecycle logic |
| `packages/web/src/app/api/webhooks/github/__tests__/` | Approval routing, non-approval ignore, idempotency | Comment webhook handling |

### Edge Cases Checklist

- [ ] Plan file missing or empty when gate triggers
- [ ] Plan file exceeds GitHub comment character limit (~65536 chars)
- [ ] Multiple approval comments in rapid succession
- [ ] Approval comment on issue with no active session
- [ ] Session already past `plan_gate` when approval arrives
- [ ] `prp.gates.plan` is false — normal flow, no pause
- [ ] Lifecycle manager restarts while session is in `plan_gate`
- [ ] Agent ignores prompt and continues past gate (metadata stays `planning_complete`)

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
pnpm lint && pnpm typecheck
```

**EXPECT**: Exit 0, no errors

### Level 2: UNIT_TESTS

```bash
pnpm test --filter @composio/ao-core
pnpm test --filter @composio/ao-web
```

**EXPECT**: All tests pass

### Level 3: FULL_SUITE

```bash
pnpm test && pnpm build
```

**EXPECT**: All tests pass, build succeeds

---

## Acceptance Criteria

- [ ] When `prpPhase` transitions to `planning_complete` and `gates.plan: true`, plan content is posted to tracker
- [ ] Human receives notification about plan review
- [ ] Metadata updates to `prpPhase=plan_gate`
- [ ] Approval comment on issue triggers resume message to agent
- [ ] Session resumes and metadata updates to `implementing`
- [ ] When `gates.plan: false`, `planning_complete` triggers writeback but no gate
- [ ] Duplicate approvals are idempotent
- [ ] Missing plan file doesn't crash the lifecycle manager
- [ ] All existing tests continue to pass

---

## Completion Checklist

- [ ] All tasks completed in dependency order
- [ ] Level 1: Static analysis passes
- [ ] Level 2: Unit tests pass
- [ ] Level 3: Full suite + build succeeds
- [ ] All acceptance criteria met

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Agent ignores prompt and continues past gate | MED | MED | System prompt uses `--append-system-prompt` which survives compaction; gate comment on tracker provides audit trail even if agent continues |
| Approval comment pattern too broad (false positives) | LOW | LOW | Pattern requires word boundary match; worst case agent resumes early which is recoverable |
| Plan file too large for tracker comment | LOW | LOW | Truncate to ~4000 chars with "see full plan in workspace" link |
| Race: approval arrives before gate metadata is written | LOW | MED | Webhook handler checks `prpPhase=plan_gate`; if not set yet, comment is ignored (human can re-approve) |
| Lifecycle manager restart loses `prpPhases` map | LOW | LOW | On restart, `plan_gate` is already in metadata; gate won't re-fire (prpPhases map sees it as first occurrence of `plan_gate`, which has no action) |

---

## Notes

- The `planning` → `planning_complete` rename in the metadata-updater hook is a breaking change for the writeback comment. The lifecycle manager must handle both `planning` (old sessions) and `planning_complete` (new sessions). In practice, since Phases 4/5 just landed, there are no long-lived sessions with `planning` phase.
- The `implementing` phase detection (via `.claude/PRPs/reports/`) is a bonus from Task 1 that enables proper `implementing` writeback (previously this phase value was in the switch but never produced by the hook).
- Future: PR gate (`prp.gates.pr`) follows the exact same pattern — detect `pr_created` phase, post PR link to tracker, notify, set `prpPhase=pr_gate`. Can be a small follow-up task.
- The trigger engine is intentionally NOT extended for comment routing. Comments are a different concern (routing to existing sessions) vs triggers (spawning new sessions). If this becomes a pattern (more webhook events routing to sessions), refactor into a shared router.
