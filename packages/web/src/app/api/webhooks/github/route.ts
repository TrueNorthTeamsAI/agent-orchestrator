/**
 * POST /api/webhooks/github — GitHub webhook receiver.
 *
 * Verifies HMAC-SHA256 signature, normalizes payload to TrackerEvent,
 * evaluates triggers, and spawns sessions on match.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  evaluateTriggers,
  updateMetadata,
  getSessionsDir,
  type TrackerEvent,
  type Tracker,
  type ProjectConfig,
  type SessionManager,
  type OrchestratorConfig,
  type PluginRegistry,
} from "@composio/ao-core";
import { getServices } from "@/lib/services";
import { verifySignature } from "@/lib/webhook-utils";

/** Normalize a GitHub webhook payload into a TrackerEvent, or return null if not actionable. */
function normalizeGitHubEvent(
  eventType: string,
  action: string,
  deliveryId: string,
  payload: Record<string, unknown>,
): TrackerEvent | null {
  // Handle issue_comment events
  if (eventType === "issue_comment" && action === "created") {
    const issue = payload.issue as Record<string, unknown>;
    const comment = payload.comment as Record<string, unknown>;
    const repo = payload.repository as Record<string, unknown>;
    const sender = payload.sender as Record<string, unknown>;
    if (!issue || !comment || !repo) return null;

    const labels = (issue.labels as Array<{ name: string }>) ?? [];
    const assignees = (issue.assignees as Array<{ login: string }>) ?? [];

    return {
      provider: "github" as const,
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
      commentBody: (comment.body as string) ?? "",
      raw: payload,
    };
  }

  if (eventType !== "issues") return null;

  const normalizedEvent = (() => {
    switch (action) {
      case "labeled":
        return "issue.labeled" as const;
      case "assigned":
        return "issue.assigned" as const;
      case "opened":
        return "issue.opened" as const;
      case "reopened":
        return "issue.reopened" as const;
      default:
        return null;
    }
  })();

  if (!normalizedEvent) return null;

  const issue = payload.issue as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;
  const sender = payload.sender as Record<string, unknown>;
  const label = payload.label as Record<string, unknown> | undefined;
  const assignee = payload.assignee as Record<string, unknown> | undefined;

  if (!issue || !repo) return null;

  const labels = (issue.labels as Array<{ name: string }>) ?? [];
  const assignees = (issue.assignees as Array<{ login: string }>) ?? [];

  return {
    provider: "github",
    deliveryId,
    event: normalizedEvent,
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
    label: label ? (label.name as string) : undefined,
    assignee: assignee ? (assignee.login as string) : undefined,
    sender: sender ? (sender.login as string) : "unknown",
    timestamp: new Date().toISOString(),
    raw: payload,
  };
}

/** Approval pattern: matches common approval phrases. */
const APPROVAL_PATTERN = /\b(approved?|lgtm|proceed|go ahead)\b/i;

/** Handle an issue_comment event — route approval comments to gated sessions. */
async function handleIssueComment(
  event: TrackerEvent,
  config: OrchestratorConfig,
  sessionManager: SessionManager,
  registry: PluginRegistry,
): Promise<{ ok: boolean; action?: string; skipped?: string }> {
  if (!event.commentBody || !APPROVAL_PATTERN.test(event.commentBody)) {
    return { ok: true, skipped: "not an approval comment" };
  }

  // Find the active session for this issue
  const issueUrl = event.issue.url;
  const sessions = await sessionManager.list();
  const gatedSession = sessions.find((s) => {
    if (!s.issueId) return false;
    // Match by issue URL or issue number
    const matchesUrl = s.issueId === issueUrl || s.issueId.endsWith(`/${event.issue.id}`);
    const isGated = s.metadata?.["prpPhase"] === "plan_gate";
    return matchesUrl && isGated;
  });

  if (!gatedSession) {
    return { ok: true, skipped: "no gated session for this issue" };
  }

  // Resume the gated session
  try {
    await sessionManager.send(
      gatedSession.id,
      "Plan approved by human reviewer. Continue with implementation using /prp-ralph.",
    );

    // Update metadata to implementing
    const project = config.projects[gatedSession.projectId];
    if (project) {
      const sessionsDir = getSessionsDir(config.configPath, project.path);
      updateMetadata(sessionsDir, gatedSession.id, { prpPhase: "implementing" });
    }

    // Post confirmation comment
    if (project?.tracker) {
      const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
      if (tracker?.updateIssue) {
        const issueId = event.issue.id;
        tracker
          .updateIssue(
            issueId,
            {
              comment: `✅ **Agent Orchestrator** plan approved. Session \`${gatedSession.id}\` is resuming.`,
            },
            project,
          )
          .catch(() => {});
      }
    }

    return { ok: true, action: "resumed session " + gatedSession.id };
  } catch (err) {
    console.error("[webhook/github] resume failed:", err);
    return { ok: true, skipped: "resume failed" };
  }
}

/** Find the webhook secret for a GitHub event by matching repo to project config. */
function findSecret(
  repo: string,
  config: { projects: Record<string, ProjectConfig> },
): string | null {
  for (const project of Object.values(config.projects)) {
    if (project.repo === repo) {
      return project.webhooks?.github?.secret ?? null;
    }
  }
  return null;
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  const eventType = request.headers.get("x-github-event") ?? "";
  const deliveryId = request.headers.get("x-github-delivery") ?? "";
  const signature = request.headers.get("x-hub-signature-256");

  // Parse payload to extract repo for secret lookup
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const repo = (payload.repository as Record<string, unknown>)?.full_name as string | undefined;
  if (!repo) {
    return NextResponse.json({ ok: true, skipped: "no repository" });
  }

  const { config, sessionManager, registry } = await getServices();

  // Verify signature
  const secret = findSecret(repo, config);
  if (!secret) {
    return NextResponse.json({ ok: true, skipped: "no project config for repo" });
  }

  if (!verifySignature(body, signature, secret, "sha256=")) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Normalize event
  const trackerEvent = normalizeGitHubEvent(
    eventType,
    payload.action as string,
    deliveryId,
    payload,
  );
  if (!trackerEvent) {
    return NextResponse.json({ ok: true, skipped: "not an actionable event" });
  }

  // Handle issue comments — route approval comments to gated sessions
  if (trackerEvent.event === "issue.comment") {
    const result = await handleIssueComment(trackerEvent, config, sessionManager, registry);
    return NextResponse.json(result);
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
    console.error("[webhook/github] spawn failed:", err);
    return NextResponse.json({ ok: true, error: "spawn failed" });
  }
}
