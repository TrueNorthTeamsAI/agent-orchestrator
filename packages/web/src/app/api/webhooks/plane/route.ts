/**
 * POST /api/webhooks/plane — Plane webhook receiver.
 *
 * Verifies HMAC-SHA256 signature (X-Plane-Signature, bare hex),
 * normalizes payload to TrackerEvent, evaluates triggers, spawns sessions.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  evaluateTriggers,
  type TrackerEvent,
  type Tracker,
  type ProjectConfig,
} from "@composio/ao-core";
import { getServices } from "@/lib/services";
import { verifySignature } from "@/lib/webhook-utils";

/** Normalize a Plane webhook payload into a TrackerEvent, or return null. */
function normalizePlaneEvent(
  deliveryId: string,
  payload: Record<string, unknown>,
): TrackerEvent | null {
  const event = payload.event as string | undefined;
  const action = payload.action as string | undefined;
  const data = payload.data as Record<string, unknown> | undefined;
  const workspaceId = payload.workspace_id as string | undefined;

  if (!event || !data) return null;

  // Plane uses "issue" event with "create"/"update" actions
  if (event !== "issue") return null;

  // Determine normalized event type from action + data changes
  const normalizedEvent = (() => {
    if (action === "create") return "issue.opened" as const;
    if (action === "update") {
      // Check if labels were changed
      const updates = payload.updates as Record<string, unknown> | undefined;
      if (updates?.labels) return "issue.labeled" as const;
      if (updates?.assignees) return "issue.assigned" as const;
      if (updates?.state === "reopened") return "issue.reopened" as const;
    }
    return null;
  })();

  if (!normalizedEvent) return null;

  const labels = (data.labels as string[]) ?? [];
  const assignees = (data.assignees as string[]) ?? [];

  return {
    provider: "plane",
    deliveryId,
    event: normalizedEvent,
    action: action ?? "unknown",
    issue: {
      id: (data.id as string) ?? "",
      number: (data.sequence_id as number) ?? 0,
      title: (data.name as string) ?? "",
      state: (data.state as string) ?? "open",
      labels,
      assignees,
      url: (data.url as string) ?? "",
    },
    repo: workspaceId ?? "",
    label: normalizedEvent === "issue.labeled" ? labels[labels.length - 1] : undefined,
    assignee: normalizedEvent === "issue.assigned" ? assignees[assignees.length - 1] : undefined,
    sender: (payload.triggered_by as string) ?? "unknown",
    timestamp: new Date().toISOString(),
    raw: payload,
  };
}

/** Find the webhook secret for a Plane event by matching workspaceId. */
function findSecret(
  workspaceId: string | undefined,
  config: { projects: Record<string, ProjectConfig> },
): string | null {
  if (!workspaceId) return null;
  for (const project of Object.values(config.projects)) {
    const planeConfig = project.webhooks?.plane;
    if (planeConfig?.workspaceId === workspaceId) {
      return planeConfig.secret ?? null;
    }
  }
  return null;
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  const deliveryId = request.headers.get("x-plane-delivery") ?? crypto.randomUUID();
  const signature = request.headers.get("x-plane-signature");

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const workspaceId = payload.workspace_id as string | undefined;

  const { config, sessionManager, registry } = await getServices();

  // Verify signature
  const secret = findSecret(workspaceId, config);
  if (!secret) {
    return NextResponse.json({ ok: true, skipped: "no project config for workspace" });
  }

  // Plane uses bare hex signature (no prefix)
  if (!verifySignature(body, signature, secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Normalize event
  const trackerEvent = normalizePlaneEvent(deliveryId, payload);
  if (!trackerEvent) {
    return NextResponse.json({ ok: true, skipped: "not an actionable event" });
  }

  // Evaluate triggers
  const decision = await evaluateTriggers(trackerEvent, { config, sessionManager });
  if (!decision) {
    return NextResponse.json({ ok: true, skipped: "no trigger matched" });
  }

  // Spawn session
  try {
    const session = await sessionManager.spawn({
      projectId: decision.projectId,
      issueId: decision.issueId,
    });

    // Fire-and-forget: post "Agent spawned" comment
    const project = config.projects[decision.projectId];
    if (project?.tracker) {
      const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
      if (tracker?.updateIssue) {
        const comment = [
          `🤖 **Agent Orchestrator** spawned session \`${session.id}\` for this issue.`,
          "",
          `Branch: \`${session.branch ?? "unknown"}\``,
        ].join("\n");

        tracker.updateIssue(decision.issueId, { comment }, project).catch(() => {
          // Writeback is fire-and-forget
        });
      }
    }

    return NextResponse.json({ ok: true, sessionId: session.id });
  } catch (err) {
    console.error("[webhook/plane] spawn failed:", err);
    return NextResponse.json({ ok: true, error: "spawn failed" });
  }
}
