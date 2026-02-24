/**
 * Trigger Engine — evaluates normalized TrackerEvents against project trigger rules.
 *
 * Pure business logic, no HTTP. Takes a TrackerEvent + config, returns SpawnDecision | null.
 */

import type {
  TrackerEvent,
  TriggerRule,
  SpawnDecision,
  OrchestratorConfig,
  SessionManager,
} from "./types.js";

// ---------------------------------------------------------------------------
// Delivery dedup (in-memory, TTL-based)
// ---------------------------------------------------------------------------

const DELIVERY_TTL_MS = 600_000; // 10 minutes
const seenDeliveries = new Map<string, number>();

/** Prune expired delivery IDs. */
function pruneDeliveries(): void {
  const now = Date.now();
  for (const [id, ts] of seenDeliveries) {
    if (now - ts > DELIVERY_TTL_MS) {
      seenDeliveries.delete(id);
    }
  }
}

/** Check if a delivery ID has already been processed. Returns true if duplicate. */
function isDuplicate(deliveryId: string): boolean {
  pruneDeliveries();
  if (seenDeliveries.has(deliveryId)) {
    return true;
  }
  seenDeliveries.set(deliveryId, Date.now());
  return false;
}

// ---------------------------------------------------------------------------
// Project matching
// ---------------------------------------------------------------------------

/**
 * Find which project config key matches a webhook event.
 * GitHub: match by repo field. Plane: match by workspaceId.
 */
function findProject(
  event: TrackerEvent,
  config: OrchestratorConfig,
): { projectId: string } | null {
  for (const [projectId, project] of Object.entries(config.projects)) {
    if (event.provider === "github") {
      if (project.repo === event.repo) {
        return { projectId };
      }
    } else if (event.provider === "plane") {
      const planeConfig = project.webhooks?.plane;
      if (planeConfig?.workspaceId && event.repo.includes(planeConfig.workspaceId)) {
        return { projectId };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

/** Check if a single trigger rule matches a TrackerEvent. */
function ruleMatches(rule: TriggerRule, event: TrackerEvent): boolean {
  if (rule.on !== event.event) return false;

  if (rule.on === "issue.labeled" && rule.label) {
    return event.label === rule.label;
  }

  if (rule.on === "issue.assigned" && rule.assignee) {
    return event.assignee === rule.assignee;
  }

  // For issue.opened, issue.reopened, or rules without filters: match on event type alone
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TriggerEngineDeps {
  config: OrchestratorConfig;
  sessionManager: SessionManager;
}

/**
 * Evaluate a TrackerEvent against all project trigger rules.
 * Returns a SpawnDecision if a trigger matches, or null if no action needed.
 */
export async function evaluateTriggers(
  event: TrackerEvent,
  deps: TriggerEngineDeps,
): Promise<SpawnDecision | null> {
  const { config, sessionManager } = deps;

  // 1. Idempotency check
  if (isDuplicate(event.deliveryId)) {
    return null;
  }

  // 2. Find matching project
  const match = findProject(event, config);
  if (!match) {
    return null;
  }

  const project = config.projects[match.projectId];
  if (!project) return null;

  // 3. Check trigger rules
  const triggers = project.triggers ?? [];
  const matchedRule = triggers.find((rule) => ruleMatches(rule, event));
  if (!matchedRule) {
    return null;
  }

  // 4. Duplicate spawn prevention — check for active sessions with same issue
  const issueId = String(event.issue.number);
  const sessions = await sessionManager.list(match.projectId);
  const hasActiveSession = sessions.some(
    (s) =>
      s.issueId?.includes(issueId) &&
      !["killed", "terminated", "done", "cleanup", "errored", "merged"].includes(s.status),
  );

  if (hasActiveSession) {
    return null;
  }

  return {
    projectId: match.projectId,
    issueId,
    event,
    matchedRule,
  };
}

/** Reset delivery dedup state (for testing). */
export function _resetDeliveries(): void {
  seenDeliveries.clear();
}
