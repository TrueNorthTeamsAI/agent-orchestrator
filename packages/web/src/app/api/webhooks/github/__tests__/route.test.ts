/**
 * Tests for GitHub webhook route — issue_comment handling.
 *
 * Since the route handler functions are not exported, we test the POST endpoint
 * by mocking getServices and verifySignature.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

// Mock getServices before importing the route
const mockSessionManager = {
  spawn: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  get: vi.fn(),
  send: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  cleanup: vi.fn(),
  restore: vi.fn(),
  spawnOrchestrator: vi.fn(),
};

const mockTracker = {
  name: "mock-tracker",
  getIssue: vi.fn(),
  isCompleted: vi.fn(),
  issueUrl: vi.fn(),
  branchName: vi.fn(),
  generatePrompt: vi.fn(),
  updateIssue: vi.fn().mockResolvedValue(undefined),
  listIssues: vi.fn(),
};

const mockRegistry = {
  register: vi.fn(),
  get: vi.fn().mockImplementation((slot: string) => {
    if (slot === "tracker") return mockTracker;
    return null;
  }),
  list: vi.fn().mockReturnValue([]),
  loadBuiltins: vi.fn(),
  loadFromConfig: vi.fn(),
};

const mockConfig = {
  configPath: "/tmp/config.yaml",
  defaults: { runtime: "tmux", agent: "claude-code", notifiers: ["desktop"] },
  notificationRouting: {},
  projects: {
    "my-app": {
      name: "My App",
      repo: "org/repo",
      path: "/tmp/my-app",
      defaultBranch: "main",
      sessionPrefix: "app",
      tracker: { plugin: "mock-tracker" },
      webhooks: { github: { secret: "test-secret" } },
    },
  },
};

vi.mock("@/lib/services", () => ({
  getServices: vi.fn().mockResolvedValue({
    config: mockConfig,
    sessionManager: mockSessionManager,
    registry: mockRegistry,
  }),
}));

vi.mock("@/lib/webhook-utils", () => ({
  verifySignature: vi.fn().mockReturnValue(true),
}));

vi.mock("@composio/ao-core", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    evaluateTriggers: vi.fn().mockResolvedValue(null),
    getSessionsDir: vi.fn().mockReturnValue("/tmp/sessions"),
    updateMetadata: vi.fn(),
  };
});

// Must import after mocks
const { POST } = await import("../route.js");

function makeRequest(eventType: string, payload: Record<string, unknown>): Request {
  const body = JSON.stringify(payload);
  const sig =
    "sha256=" + createHmac("sha256", "test-secret").update(body).digest("hex");

  return new Request("http://localhost/api/webhooks/github", {
    method: "POST",
    headers: {
      "x-github-event": eventType,
      "x-github-delivery": "delivery-123",
      "x-hub-signature-256": sig,
    },
    body,
  });
}

function makeIssueCommentPayload(commentBody: string) {
  return {
    action: "created",
    issue: {
      number: 42,
      title: "Test issue",
      state: "open",
      html_url: "https://github.com/org/repo/issues/42",
      labels: [],
      assignees: [],
    },
    comment: {
      body: commentBody,
    },
    repository: { full_name: "org/repo" },
    sender: { login: "reviewer" },
  };
}

describe("GitHub webhook — issue_comment handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionManager.list.mockResolvedValue([]);
  });

  it("routes approval comment to gated session", async () => {
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-1",
        projectId: "my-app",
        status: "working",
        issueId: "https://github.com/org/repo/issues/42",
        metadata: { prpPhase: "plan_gate" },
      },
    ]);

    const req = makeRequest("issue_comment", makeIssueCommentPayload("approved"));
    const res = await POST(req as never);
    const json = await res.json();

    expect(json.ok).toBe(true);
    expect(json.action).toContain("resumed");
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "app-1",
      expect.stringContaining("approved"),
    );
  });

  it("ignores non-approval comments", async () => {
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-1",
        projectId: "my-app",
        status: "working",
        issueId: "https://github.com/org/repo/issues/42",
        metadata: { prpPhase: "plan_gate" },
      },
    ]);

    const req = makeRequest("issue_comment", makeIssueCommentPayload("looks interesting"));
    const res = await POST(req as never);
    const json = await res.json();

    expect(json.ok).toBe(true);
    expect(json.skipped).toBe("not an approval comment");
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("ignores comments when no session is in plan_gate", async () => {
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-1",
        projectId: "my-app",
        status: "working",
        issueId: "https://github.com/org/repo/issues/42",
        metadata: { prpPhase: "implementing" },
      },
    ]);

    const req = makeRequest("issue_comment", makeIssueCommentPayload("approved"));
    const res = await POST(req as never);
    const json = await res.json();

    expect(json.ok).toBe(true);
    expect(json.skipped).toBe("no gated session for this issue");
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("handles duplicate approval idempotently", async () => {
    mockSessionManager.list
      .mockResolvedValueOnce([
        {
          id: "app-1",
          projectId: "my-app",
          status: "working",
          issueId: "https://github.com/org/repo/issues/42",
          metadata: { prpPhase: "plan_gate" },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "app-1",
          projectId: "my-app",
          status: "working",
          issueId: "https://github.com/org/repo/issues/42",
          metadata: { prpPhase: "implementing" }, // Already past gate
        },
      ]);

    const req1 = makeRequest("issue_comment", makeIssueCommentPayload("approved"));
    await POST(req1 as never);

    const req2 = makeRequest("issue_comment", makeIssueCommentPayload("lgtm"));
    const res2 = await POST(req2 as never);
    const json2 = await res2.json();

    expect(json2.skipped).toBe("no gated session for this issue");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
  });
});
