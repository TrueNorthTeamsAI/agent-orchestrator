import { describe, it, expect, beforeEach } from "vitest";
import { evaluateTriggers, _resetDeliveries } from "../trigger-engine.js";
import type { TrackerEvent, OrchestratorConfig, SessionManager, Session } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<TrackerEvent> = {}): TrackerEvent {
  return {
    provider: "github",
    deliveryId: `delivery-${Math.random()}`,
    event: "issue.labeled",
    action: "labeled",
    issue: {
      id: "42",
      number: 42,
      title: "Test issue",
      state: "open",
      labels: ["agent-work"],
      assignees: ["developer"],
      url: "https://github.com/org/my-app/issues/42",
    },
    repo: "org/my-app",
    label: "agent-work",
    sender: "developer",
    timestamp: new Date().toISOString(),
    raw: {},
    ...overrides,
  };
}

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    configPath: "/tmp/test.yaml",
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: "/tmp/my-app",
        defaultBranch: "main",
        sessionPrefix: "app",
        webhooks: {
          github: { secret: "test-secret" },
        },
        triggers: [{ on: "issue.labeled", label: "agent-work", action: "spawn" }],
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
    ...overrides,
  };
}

function makeSessionManager(sessions: Session[] = []): SessionManager {
  return {
    async spawn() {
      throw new Error("not implemented in test");
    },
    async spawnOrchestrator() {
      throw new Error("not implemented in test");
    },
    async restore() {
      throw new Error("not implemented in test");
    },
    async list() {
      return sessions;
    },
    async get() {
      return null;
    },
    async kill() {},
    async cleanup() {
      return { killed: [], skipped: [], errors: [] };
    },
    async send() {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("evaluateTriggers", () => {
  beforeEach(() => {
    _resetDeliveries();
  });

  it("returns SpawnDecision when trigger matches", async () => {
    const event = makeEvent();
    const config = makeConfig();
    const sm = makeSessionManager();

    const decision = await evaluateTriggers(event, { config, sessionManager: sm });

    expect(decision).not.toBeNull();
    expect(decision!.projectId).toBe("my-app");
    expect(decision!.issueId).toBe("42");
  });

  it("returns null when no project matches the repo", async () => {
    const event = makeEvent({ repo: "other/repo" });
    const config = makeConfig();
    const sm = makeSessionManager();

    const decision = await evaluateTriggers(event, { config, sessionManager: sm });
    expect(decision).toBeNull();
  });

  it("returns null when event type doesn't match trigger rule", async () => {
    const event = makeEvent({ event: "issue.opened" });
    const config = makeConfig();
    const sm = makeSessionManager();

    const decision = await evaluateTriggers(event, { config, sessionManager: sm });
    expect(decision).toBeNull();
  });

  it("returns null when label doesn't match", async () => {
    const event = makeEvent({ label: "bug" });
    const config = makeConfig();
    const sm = makeSessionManager();

    const decision = await evaluateTriggers(event, { config, sessionManager: sm });
    expect(decision).toBeNull();
  });

  it("deduplicates by delivery ID", async () => {
    const event = makeEvent({ deliveryId: "fixed-id" });
    const config = makeConfig();
    const sm = makeSessionManager();

    const first = await evaluateTriggers(event, { config, sessionManager: sm });
    const second = await evaluateTriggers(event, { config, sessionManager: sm });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("prevents duplicate spawns for same issue", async () => {
    const event = makeEvent();
    const config = makeConfig();

    const existingSession = {
      id: "app-1",
      projectId: "my-app",
      status: "working" as const,
      activity: null,
      branch: "feat/issue-42",
      issueId: "https://github.com/org/my-app/issues/42",
      pr: null,
      workspacePath: null,
      runtimeHandle: null,
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    };

    const sm = makeSessionManager([existingSession]);
    const decision = await evaluateTriggers(event, { config, sessionManager: sm });
    expect(decision).toBeNull();
  });

  it("matches issue.assigned trigger rule", async () => {
    const event = makeEvent({
      event: "issue.assigned",
      action: "assigned",
      assignee: "ao-bot",
    });
    const config = makeConfig({
      projects: {
        "my-app": {
          name: "My App",
          repo: "org/my-app",
          path: "/tmp/my-app",
          defaultBranch: "main",
          sessionPrefix: "app",
          webhooks: { github: { secret: "s" } },
          triggers: [{ on: "issue.assigned", assignee: "ao-bot", action: "spawn" }],
        },
      },
    });
    const sm = makeSessionManager();

    const decision = await evaluateTriggers(event, { config, sessionManager: sm });
    expect(decision).not.toBeNull();
    expect(decision!.projectId).toBe("my-app");
  });

  it("matches issue.opened trigger rule without filter", async () => {
    const event = makeEvent({ event: "issue.opened", action: "opened" });
    const config = makeConfig({
      projects: {
        "my-app": {
          name: "My App",
          repo: "org/my-app",
          path: "/tmp/my-app",
          defaultBranch: "main",
          sessionPrefix: "app",
          webhooks: { github: { secret: "s" } },
          triggers: [{ on: "issue.opened", action: "spawn" }],
        },
      },
    });
    const sm = makeSessionManager();

    const decision = await evaluateTriggers(event, { config, sessionManager: sm });
    expect(decision).not.toBeNull();
  });

  it("returns null when no triggers configured", async () => {
    const event = makeEvent();
    const config = makeConfig({
      projects: {
        "my-app": {
          name: "My App",
          repo: "org/my-app",
          path: "/tmp/my-app",
          defaultBranch: "main",
          sessionPrefix: "app",
        },
      },
    });
    const sm = makeSessionManager();

    const decision = await evaluateTriggers(event, { config, sessionManager: sm });
    expect(decision).toBeNull();
  });
});
