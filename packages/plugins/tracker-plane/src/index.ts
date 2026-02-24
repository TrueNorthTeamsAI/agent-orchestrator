/**
 * tracker-plane plugin — Plane Issues as an issue tracker.
 *
 * Uses the Plane REST API for issue interactions.
 * Requires `baseUrl`, `apiToken`, and `workspaceSlug` in tracker config.
 *
 * Config example:
 *   tracker:
 *     plugin: plane
 *     baseUrl: https://app.plane.so
 *     apiToken: ${PLANE_API_TOKEN}
 *     workspaceSlug: my-workspace
 *     projectId: "c467e125-..."
 */

import type { PluginModule, Tracker, Issue, IssueUpdate, ProjectConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PlaneConfig {
  baseUrl: string;
  apiToken: string;
  workspaceSlug: string;
  projectId: string;
}

function getPlaneConfig(project: ProjectConfig): PlaneConfig {
  const t = project.tracker;
  if (!t) throw new Error("Plane tracker: no tracker config on project");

  const baseUrl = (t.baseUrl as string) ?? "https://app.plane.so";
  const apiToken = t.apiToken as string;
  const workspaceSlug = t.workspaceSlug as string;
  const projectId = t.projectId as string;

  if (!apiToken) throw new Error("Plane tracker: apiToken is required");
  if (!workspaceSlug) throw new Error("Plane tracker: workspaceSlug is required");
  if (!projectId) throw new Error("Plane tracker: projectId is required");

  return { baseUrl: baseUrl.replace(/\/$/, ""), apiToken, workspaceSlug, projectId };
}

async function planeApi(
  cfg: PlaneConfig,
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<unknown> {
  const url = `${cfg.baseUrl}/api/v1/workspaces/${cfg.workspaceSlug}/projects/${cfg.projectId}${path}`;
  const res = await fetch(url, {
    method: options?.method ?? "GET",
    headers: {
      "X-API-Key": cfg.apiToken,
      "Content-Type": "application/json",
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Plane API ${options?.method ?? "GET"} ${path} failed (${res.status}): ${text}`,
    );
  }

  return res.json();
}

function mapState(state: string): Issue["state"] {
  const s = state.toLowerCase();
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "done" || s === "completed") return "closed";
  if (s === "in_progress" || s === "started") return "in_progress";
  return "open";
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createPlaneTracker(): Tracker {
  return {
    name: "plane",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const cfg = getPlaneConfig(project);
      const data = (await planeApi(cfg, `/issues/${identifier}`)) as Record<string, unknown>;

      return {
        id: (data.id as string) ?? identifier,
        title: (data.name as string) ?? "",
        description: (data.description_html as string) ?? (data.description as string) ?? "",
        url: `${cfg.baseUrl}/${cfg.workspaceSlug}/projects/${cfg.projectId}/issues/${data.id as string}`,
        state: mapState(((data.state_detail as Record<string, unknown>)?.name as string) ?? "open"),
        labels: ((data.label_detail as Array<{ name: string }>) ?? []).map((l) => l.name),
        assignee: ((data.assignee_detail as Array<{ display_name: string }>) ?? [])[0]
          ?.display_name,
      };
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const issue = await this.getIssue(identifier, project);
      return issue.state === "closed";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const cfg = getPlaneConfig(project);
      return `${cfg.baseUrl}/${cfg.workspaceSlug}/projects/${cfg.projectId}/issues/${identifier}`;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      // Use a short prefix + identifier
      return `feat/plane-${identifier.slice(0, 8)}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on Plane issue: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this issue. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      const cfg = getPlaneConfig(project);

      // Handle comment — Plane uses the issue activities/comments endpoint
      if (update.comment) {
        await planeApi(cfg, `/issues/${identifier}/comments/`, {
          method: "POST",
          body: { comment_html: update.comment },
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "plane",
  slot: "tracker" as const,
  description: "Tracker plugin: Plane Issues",
  version: "0.1.0",
};

export function create(): Tracker {
  return createPlaneTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
