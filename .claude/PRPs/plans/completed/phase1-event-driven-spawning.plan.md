# Plan: Phase 1 — Event-Driven Agent Spawning

**PRD**: `.claude/PRPs/prds/phase1-event-driven-spawning.prd.md`
**Created**: 2026-02-25

---

## Validation Commands

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Tasks

### Task 1: Core Types & Config Schema
**Files**: `packages/core/src/types.ts`, `packages/core/src/config.ts`

- [x] 1.1 Add `TrackerEvent` interface to `types.ts`
- [x] 1.2 Add `TriggerRule` interface to `types.ts`
- [x] 1.3 Add `SpawnDecision` interface to `types.ts`
- [x] 1.4 Add `WebhookProviderConfig` type to `types.ts`
- [x] 1.5 Extend `ProjectConfig` with optional `webhooks` and `triggers` fields
- [x] 1.6 Extend `OrchestratorConfig` with optional `webhooks` top-level field
- [x] 1.7 Add Zod schemas in `config.ts`: `TriggerRuleSchema`, `WebhookProviderConfigSchema`, extend `ProjectConfigSchema` and `OrchestratorConfigSchema`

### Task 2: Webhook Receivers
**Files**: `packages/web/src/app/api/webhooks/github/route.ts`, `packages/web/src/app/api/webhooks/plane/route.ts`

- [x] 2.1 Create shared webhook utils (`packages/web/src/lib/webhook-utils.ts`): HMAC verification, logging helpers
- [x] 2.2 Create GitHub webhook route handler with HMAC-SHA256 verification (`X-Hub-Signature-256` with `sha256=` prefix)
- [x] 2.3 Create GitHub payload normalizer to `TrackerEvent`
- [x] 2.4 Create Plane webhook route handler with HMAC-SHA256 verification (`X-Plane-Signature` bare hex)
- [x] 2.5 Create Plane payload normalizer to `TrackerEvent`

### Task 3: Trigger Engine
**Files**: `packages/core/src/trigger-engine.ts`, `packages/core/src/index.ts`

- [x] 3.1 Create `evaluateTriggers(event: TrackerEvent, config: OrchestratorConfig): SpawnDecision | null`
- [x] 3.2 Implement project-to-webhook matching (GitHub: `repo` field; Plane: `workspaceId`)
- [x] 3.3 Implement trigger rule evaluation (`issue.labeled`, `issue.assigned`, `issue.opened`, `issue.reopened`)
- [x] 3.4 Implement duplicate spawn detection via session list
- [x] 3.5 Implement delivery ID-based idempotency (in-memory set with TTL)
- [x] 3.6 Export from `packages/core/src/index.ts`

### Task 4: Wire Webhook Routes to Trigger Engine
**Files**: `packages/web/src/app/api/webhooks/github/route.ts`, `packages/web/src/app/api/webhooks/plane/route.ts`, `packages/web/src/lib/services.ts`

- [x] 4.1 Wire GitHub route: normalize → `evaluateTriggers()` → `sessionManager.spawn()` → return 200
- [x] 4.2 Wire Plane route: normalize → `evaluateTriggers()` → `sessionManager.spawn()` → return 200

### Task 5: Tracker Writeback
**Files**: `packages/core/src/trigger-engine.ts`, `packages/core/src/lifecycle-manager.ts`, `packages/web/src/lib/services.ts`

- [x] 5.1 Post "Agent spawned" comment to issue after successful spawn (in webhook handler, using tracker.updateIssue)
- [x] 5.2 Add writeback on `pr.created` event in lifecycle manager
- [x] 5.3 Add writeback on `session.stuck`/`session.errored` in lifecycle manager

### Task 6: Plane Tracker Plugin
**Files**: `packages/plugins/tracker-plane/` (new package)

- [x] 6.1 Create `packages/plugins/tracker-plane/package.json`
- [x] 6.2 Create `packages/plugins/tracker-plane/tsconfig.json`
- [x] 6.3 Implement Plane tracker: `getIssue`, `updateIssue` (with comment), `branchName`, `generatePrompt`, `issueUrl`
- [x] 6.4 Register in `packages/web/src/lib/services.ts`

### Task 7: Tests
**Files**: `packages/core/src/__tests__/trigger-engine.test.ts`, etc.

- [x] 7.1 Unit tests for trigger engine (all rule types, project matching, duplicate detection)
- [x] 7.2 Unit tests for webhook signature verification
- [x] 7.3 Unit tests for GitHub/Plane payload normalization
- [x] 7.4 Integration test: webhook → trigger → spawn decision

### Task 8: Config Example Update
**Files**: `agent-orchestrator.yaml.example`

- [x] 8.1 Add webhook + trigger config examples to `agent-orchestrator.yaml.example`

---

## Acceptance Criteria

1. `pnpm typecheck` passes
2. `pnpm lint` passes (0 errors)
3. `pnpm test` passes (all tests including new ones)
4. `pnpm build` succeeds
5. GitHub webhook with valid HMAC → 200 response, trigger evaluation logged
6. Invalid HMAC → 401 response
7. Trigger match on `issue.labeled` → `SpawnDecision` returned
8. Duplicate issue → no spawn
9. `TrackerEvent` normalized correctly from both GitHub and Plane payloads

## MIRROR References

- Plugin pattern: `packages/plugins/tracker-github/src/index.ts`
- API route pattern: `packages/web/src/app/api/spawn/route.ts`
- Config schema: `packages/core/src/config.ts`
- Types: `packages/core/src/types.ts`
- Services: `packages/web/src/lib/services.ts`
