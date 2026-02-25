/**
 * Lifecycle Manager — state machine + polling loop + reaction engine.
 *
 * Periodically polls all sessions and:
 * 1. Detects state transitions (spawning → working → pr_open → etc.)
 * 2. Emits events on transitions
 * 3. Triggers reactions (auto-handle CI failures, review comments, etc.)
 * 4. Escalates to human notification when auto-handling fails
 *
 * Reference: scripts/claude-session-status, scripts/claude-review-check
 */

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SESSION_STATUS,
  PR_STATE,
  CI_STATUS,
  type LifecycleManager,
  type SessionManager,
  type SessionId,
  type SessionStatus,
  type EventType,
  type OrchestratorEvent,
  type OrchestratorConfig,
  type ReactionConfig,
  type ReactionResult,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type SCM,
  type Notifier,
  type Tracker,
  type Session,
  type EventPriority,
  type ProjectConfig as _ProjectConfig,
} from "./types.js";
import { updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";

/** Parse a duration string like "10m", "30s", "1h" to milliseconds. */
function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(s|m|h)$/);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    default:
      return 0;
  }
}

/** Infer a reasonable priority from event type. */
function inferPriority(type: EventType): EventPriority {
  if (type.includes("stuck") || type.includes("needs_input") || type.includes("errored")) {
    return "urgent";
  }
  if (type.startsWith("summary.")) {
    return "info";
  }
  if (
    type.includes("approved") ||
    type.includes("ready") ||
    type.includes("merged") ||
    type.includes("completed")
  ) {
    return "action";
  }
  if (type.includes("fail") || type.includes("changes_requested") || type.includes("conflicts")) {
    return "warning";
  }
  return "info";
}

/** Create an OrchestratorEvent with defaults filled in. */
function createEvent(
  type: EventType,
  opts: {
    sessionId: SessionId;
    projectId: string;
    message: string;
    priority?: EventPriority;
    data?: Record<string, unknown>;
  },
): OrchestratorEvent {
  return {
    id: randomUUID(),
    type,
    priority: opts.priority ?? inferPriority(type),
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    timestamp: new Date(),
    message: opts.message,
    data: opts.data ?? {},
  };
}

/** Determine which event type corresponds to a status transition. */
function statusToEventType(_from: SessionStatus | undefined, to: SessionStatus): EventType | null {
  switch (to) {
    case "working":
      return "session.working";
    case "pr_open":
      return "pr.created";
    case "ci_failed":
      return "ci.failing";
    case "review_pending":
      return "review.pending";
    case "changes_requested":
      return "review.changes_requested";
    case "approved":
      return "review.approved";
    case "mergeable":
      return "merge.ready";
    case "merged":
      return "merge.completed";
    case "needs_input":
      return "session.needs_input";
    case "stuck":
      return "session.stuck";
    case "errored":
      return "session.errored";
    case "killed":
      return "session.killed";
    default:
      return null;
  }
}

/** Map event type to reaction config key. */
function eventToReactionKey(eventType: EventType): string | null {
  switch (eventType) {
    case "ci.failing":
      return "ci-failed";
    case "review.changes_requested":
      return "changes-requested";
    case "automated_review.found":
      return "bugbot-comments";
    case "merge.conflicts":
      return "merge-conflicts";
    case "merge.ready":
      return "approved-and-green";
    case "session.stuck":
      return "agent-stuck";
    case "session.needs_input":
      return "agent-needs-input";
    case "session.killed":
      return "agent-exited";
    case "summary.all_complete":
      return "all-complete";
    default:
      return null;
  }
}

export interface LifecycleManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
}

/** Track attempt counts for reactions per session. */
interface ReactionTracker {
  attempts: number;
  firstTriggered: Date;
}

/** Create a LifecycleManager instance. */
export function createLifecycleManager(deps: LifecycleManagerDeps): LifecycleManager {
  const { config, registry, sessionManager } = deps;

  const states = new Map<SessionId, SessionStatus>();
  const prpPhases = new Map<string, string>(); // sessionId → last-seen prpPhase
  const reactionTrackers = new Map<string, ReactionTracker>(); // "sessionId:reactionKey"
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false; // re-entrancy guard
  let allCompleteEmitted = false; // guard against repeated all_complete

  /** Determine current status for a session by polling plugins. */
  async function determineStatus(session: Session): Promise<SessionStatus> {
    const project = config.projects[session.projectId];
    if (!project) return session.status;

    const agent = registry.get<Agent>("agent", project.agent ?? config.defaults.agent);
    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;

    // 1. Check if runtime is alive
    if (session.runtimeHandle) {
      const runtime = registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
      if (runtime) {
        const alive = await runtime.isAlive(session.runtimeHandle).catch(() => true);
        if (!alive) return "killed";
      }
    }

    // 2. Check agent activity via terminal output + process liveness
    if (agent && session.runtimeHandle) {
      try {
        const runtime = registry.get<Runtime>(
          "runtime",
          project.runtime ?? config.defaults.runtime,
        );
        const terminalOutput = runtime ? await runtime.getOutput(session.runtimeHandle, 10) : "";
        // Only trust detectActivity when we actually have terminal output;
        // empty output means the runtime probe failed, not that the agent exited.
        if (terminalOutput) {
          const activity = agent.detectActivity(terminalOutput);
          if (activity === "waiting_input") return "needs_input";

          // Check whether the agent process is still alive. Some agents
          // (codex, aider, opencode) return "active" for any non-empty
          // terminal output, including the shell prompt visible after exit.
          // Checking isProcessRunning for both "idle" and "active" ensures
          // exit detection works regardless of the agent's classifier.
          const processAlive = await agent.isProcessRunning(session.runtimeHandle);
          if (!processAlive) return "killed";
        }
      } catch {
        // On probe failure, preserve current stuck/needs_input state rather
        // than letting the fallback at the bottom coerce them to "working"
        if (
          session.status === SESSION_STATUS.STUCK ||
          session.status === SESSION_STATUS.NEEDS_INPUT
        ) {
          return session.status;
        }
      }
    }

    // 3. Check PR state if PR exists
    if (session.pr && scm) {
      try {
        const prState = await scm.getPRState(session.pr);
        if (prState === PR_STATE.MERGED) return "merged";
        if (prState === PR_STATE.CLOSED) return "killed";

        // Check CI
        const ciStatus = await scm.getCISummary(session.pr);
        if (ciStatus === CI_STATUS.FAILING) return "ci_failed";

        // Check reviews
        const reviewDecision = await scm.getReviewDecision(session.pr);
        if (reviewDecision === "changes_requested") return "changes_requested";
        if (reviewDecision === "approved") {
          // Check merge readiness
          const mergeReady = await scm.getMergeability(session.pr);
          if (mergeReady.mergeable) return "mergeable";
          return "approved";
        }
        if (reviewDecision === "pending") return "review_pending";

        return "pr_open";
      } catch {
        // SCM check failed — keep current status
      }
    }

    // 4. Default: if agent is active, it's working
    if (
      session.status === "spawning" ||
      session.status === SESSION_STATUS.STUCK ||
      session.status === SESSION_STATUS.NEEDS_INPUT
    ) {
      return "working";
    }
    return session.status;
  }

  /** Execute a reaction for a session. */
  async function executeReaction(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
  ): Promise<ReactionResult> {
    const trackerKey = `${sessionId}:${reactionKey}`;
    let tracker = reactionTrackers.get(trackerKey);

    if (!tracker) {
      tracker = { attempts: 0, firstTriggered: new Date() };
      reactionTrackers.set(trackerKey, tracker);
    }

    // Increment attempts before checking escalation
    tracker.attempts++;

    // Check if we should escalate
    const maxRetries = reactionConfig.retries ?? Infinity;
    const escalateAfter = reactionConfig.escalateAfter;
    let shouldEscalate = false;

    if (tracker.attempts > maxRetries) {
      shouldEscalate = true;
    }

    if (typeof escalateAfter === "string") {
      const durationMs = parseDuration(escalateAfter);
      if (durationMs > 0 && Date.now() - tracker.firstTriggered.getTime() > durationMs) {
        shouldEscalate = true;
      }
    }

    if (typeof escalateAfter === "number" && tracker.attempts > escalateAfter) {
      shouldEscalate = true;
    }

    if (shouldEscalate) {
      // Escalate to human
      const event = createEvent("reaction.escalated", {
        sessionId,
        projectId,
        message: `Reaction '${reactionKey}' escalated after ${tracker.attempts} attempts`,
        data: { reactionKey, attempts: tracker.attempts },
      });
      await notifyHuman(event, reactionConfig.priority ?? "urgent");
      return {
        reactionType: reactionKey,
        success: true,
        action: "escalated",
        escalated: true,
      };
    }

    // Execute the reaction action
    const action = reactionConfig.action ?? "notify";

    switch (action) {
      case "send-to-agent": {
        if (reactionConfig.message) {
          try {
            await sessionManager.send(sessionId, reactionConfig.message);

            return {
              reactionType: reactionKey,
              success: true,
              action: "send-to-agent",
              message: reactionConfig.message,
              escalated: false,
            };
          } catch {
            // Send failed — allow retry on next poll cycle (don't escalate immediately)
            return {
              reactionType: reactionKey,
              success: false,
              action: "send-to-agent",
              escalated: false,
            };
          }
        }
        break;
      }

      case "notify": {
        const event = createEvent("reaction.triggered", {
          sessionId,
          projectId,
          message: `Reaction '${reactionKey}' triggered notification`,
          data: { reactionKey },
        });
        await notifyHuman(event, reactionConfig.priority ?? "info");
        return {
          reactionType: reactionKey,
          success: true,
          action: "notify",
          escalated: false,
        };
      }

      case "auto-merge": {
        // Auto-merge is handled by the SCM plugin
        // For now, just notify
        const event = createEvent("reaction.triggered", {
          sessionId,
          projectId,
          message: `Reaction '${reactionKey}' triggered auto-merge`,
          data: { reactionKey },
        });
        await notifyHuman(event, "action");
        return {
          reactionType: reactionKey,
          success: true,
          action: "auto-merge",
          escalated: false,
        };
      }
    }

    return {
      reactionType: reactionKey,
      success: false,
      action,
      escalated: false,
    };
  }

  /** Send a notification to all configured notifiers. */
  async function notifyHuman(event: OrchestratorEvent, priority: EventPriority): Promise<void> {
    const eventWithPriority = { ...event, priority };
    const notifierNames = config.notificationRouting[priority] ?? config.defaults.notifiers;

    for (const name of notifierNames) {
      const notifier = registry.get<Notifier>("notifier", name);
      if (notifier) {
        try {
          await notifier.notify(eventWithPriority);
        } catch {
          // Notifier failed — not much we can do
        }
      }
    }
  }

  /** Post a writeback comment to the issue tracker (fire-and-forget). */
  function writebackToTracker(session: Session, comment: string): void {
    if (!session.issueId) return;
    const project = config.projects[session.projectId];
    if (!project?.tracker) return;

    const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
    if (!tracker?.updateIssue) return;

    // Extract issue number from URL if issueId is a full URL
    const issueId = session.issueId.match(/\/(\d+)$/)?.[1] ?? session.issueId;

    tracker.updateIssue(issueId, { comment }, project).catch(() => {
      // Writeback is fire-and-forget — failure must not block lifecycle
    });
  }

  /** Build a tracker writeback comment for a state transition. */
  function getWritebackComment(
    session: Session,
    newStatus: SessionStatus,
    project?: _ProjectConfig,
  ): string | null {
    switch (newStatus) {
      case "pr_open":
        if (project?.prp?.enabled && project.prp.writeback?.pr === false) return null;
        return [
          `🤖 **Agent Orchestrator** completed work on this issue.`,
          "",
          session.pr ? `Pull Request: ${session.pr.url}` : "",
          `Session: \`${session.id}\``,
        ]
          .filter(Boolean)
          .join("\n");
      case "stuck":
        return [
          `🤖 **Agent Orchestrator** session \`${session.id}\` needs attention.`,
          "",
          `Status: stuck`,
        ].join("\n");
      case "errored":
        return [
          `🤖 **Agent Orchestrator** session \`${session.id}\` needs attention.`,
          "",
          `Status: errored`,
        ].join("\n");
      default:
        return null;
    }
  }

  /** Build a tracker writeback comment for a PRP phase transition. */
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
      case "planning_complete":
        return `📋 **Agent Orchestrator** session \`${session.id}\` has completed the implementation plan.`;
      case "implementing":
        return `🔨 **Agent Orchestrator** session \`${session.id}\` is implementing the plan.`;
      case "plan_gate":
        return null; // Gate comment already posted in gate logic
      default:
        return null;
    }
  }

  /** Build a tracker comment for plan gate — includes plan content and approval instructions. */
  function buildPlanGateComment(session: Session): string {
    const MAX_PLAN_LENGTH = 4000;
    let planContent = "(No plan file found)";

    try {
      const workspacePath = session.workspacePath ?? "";
      if (workspacePath) {
        const plansDir = join(workspacePath, ".claude", "PRPs", "plans");
        const files = readdirSync(plansDir).filter((f) => f.endsWith(".plan.md"));
        if (files.length > 0) {
          const raw = readFileSync(join(plansDir, files[0]), "utf-8");
          planContent =
            raw.length > MAX_PLAN_LENGTH
              ? raw.slice(0, MAX_PLAN_LENGTH) + "\n\n... (truncated — see full plan in workspace)"
              : raw;
        }
      }
    } catch {
      // Workspace files missing — use fallback text
    }

    return [
      `📋 **Agent Orchestrator** session \`${session.id}\` has created a plan and is waiting for approval.`,
      "",
      "<details>",
      "<summary>View Plan</summary>",
      "",
      planContent,
      "",
      "</details>",
      "",
      '> **To approve**: comment "approved", "lgtm", or "proceed" on this issue.',
      "> The agent will resume automatically.",
    ].join("\n");
  }

  /** Poll a single session and handle state transitions. */
  async function checkSession(session: Session): Promise<void> {
    // Use tracked state if available; otherwise use the persisted metadata status
    // (not session.status, which list() may have already overwritten for dead runtimes).
    // This ensures transitions are detected after a lifecycle manager restart.
    const tracked = states.get(session.id);
    const oldStatus =
      tracked ?? ((session.metadata?.["status"] as SessionStatus | undefined) || session.status);
    const newStatus = await determineStatus(session);

    if (newStatus !== oldStatus) {
      // State transition detected
      states.set(session.id, newStatus);

      // Update metadata — session.projectId is the config key (e.g., "my-app")
      const project = config.projects[session.projectId];
      if (project) {
        const sessionsDir = getSessionsDir(config.configPath, project.path);
        updateMetadata(sessionsDir, session.id, { status: newStatus });
      }

      // Tracker writeback for key transitions
      const writebackComment = getWritebackComment(session, newStatus, project);
      if (writebackComment) {
        writebackToTracker(session, writebackComment);
      }

      // Reset allCompleteEmitted when any session becomes active again
      if (newStatus !== "merged" && newStatus !== "killed") {
        allCompleteEmitted = false;
      }

      // Clear reaction trackers for the old status so retries reset on state changes
      const oldEventType = statusToEventType(undefined, oldStatus);
      if (oldEventType) {
        const oldReactionKey = eventToReactionKey(oldEventType);
        if (oldReactionKey) {
          reactionTrackers.delete(`${session.id}:${oldReactionKey}`);
        }
      }

      // Handle transition: notify humans and/or trigger reactions
      const eventType = statusToEventType(oldStatus, newStatus);
      if (eventType) {
        let reactionHandledNotify = false;
        const reactionKey = eventToReactionKey(eventType);

        if (reactionKey) {
          // Merge project-specific overrides with global defaults
          const project = config.projects[session.projectId];
          const globalReaction = config.reactions[reactionKey];
          const projectReaction = project?.reactions?.[reactionKey];
          const reactionConfig = projectReaction
            ? { ...globalReaction, ...projectReaction }
            : globalReaction;

          if (reactionConfig && reactionConfig.action) {
            // auto: false skips automated agent actions but still allows notifications
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              await executeReaction(
                session.id,
                session.projectId,
                reactionKey,
                reactionConfig as ReactionConfig,
              );
              // Reaction is handling this event — suppress immediate human notification.
              // "send-to-agent" retries + escalates on its own; "notify"/"auto-merge"
              // already call notifyHuman internally. Notifying here would bypass the
              // delayed escalation behaviour configured via retries/escalateAfter.
              reactionHandledNotify = true;
            }
          }
        }

        // For significant transitions not already notified by a reaction, notify humans
        if (!reactionHandledNotify) {
          const priority = inferPriority(eventType);
          if (priority !== "info") {
            const event = createEvent(eventType, {
              sessionId: session.id,
              projectId: session.projectId,
              message: `${session.id}: ${oldStatus} → ${newStatus}`,
              data: { oldStatus, newStatus },
            });
            await notifyHuman(event, priority);
          }
        }
      }
    } else {
      // No transition but track current state
      states.set(session.id, newStatus);
    }

    // PRP phase change detection — runs on every poll, independent of status transitions
    const newPrpPhase = session.metadata?.["prpPhase"] as string | undefined;
    if (newPrpPhase) {
      const oldPrpPhase = prpPhases.get(session.id);
      if (newPrpPhase !== oldPrpPhase) {
        prpPhases.set(session.id, newPrpPhase);

        const project = config.projects[session.projectId];
        if (project?.prp?.enabled) {
          // Map phase name to writeback config key
          const wb = project.prp.writeback;
          const phaseEnabled =
            (newPrpPhase === "investigating" && wb?.investigation !== false) ||
            (newPrpPhase === "planning" && wb?.plan !== false) ||
            (newPrpPhase === "planning_complete" && wb?.plan !== false) ||
            (newPrpPhase === "implementing" && wb?.implementation !== false);
          if (phaseEnabled) {
            const comment = getPrpWritebackComment(session, newPrpPhase, oldPrpPhase);
            if (comment) {
              writebackToTracker(session, comment);
            }
          }

          // Plan gate: if enabled, notify human and update metadata to gate state
          if (newPrpPhase === "planning_complete" && project.prp.gates?.plan) {
            const planComment = buildPlanGateComment(session);
            writebackToTracker(session, planComment);

            const event = createEvent("prp.plan_gate", {
              sessionId: session.id,
              projectId: session.projectId,
              message: `Plan ready for review — session ${session.id}`,
              priority: "action",
            });
            await notifyHuman(event, "action");

            const sessionsDir = getSessionsDir(config.configPath, project.path);
            updateMetadata(sessionsDir, session.id, { prpPhase: "plan_gate" });
          }
        }
      }
    }
  }

  /** Run one polling cycle across all sessions. */
  async function pollAll(): Promise<void> {
    // Re-entrancy guard: skip if previous poll is still running
    if (polling) return;
    polling = true;

    try {
      const sessions = await sessionManager.list();

      // Include sessions that are active OR whose status changed from what we last saw
      // (e.g., list() detected a dead runtime and marked it "killed" — we need to
      // process that transition even though the new status is terminal)
      const sessionsToCheck = sessions.filter((s) => {
        if (s.status !== "merged" && s.status !== "killed") return true;
        const tracked = states.get(s.id);
        return tracked !== undefined && tracked !== s.status;
      });

      // Poll all sessions concurrently
      await Promise.allSettled(sessionsToCheck.map((s) => checkSession(s)));

      // Prune stale entries from states and reactionTrackers for sessions
      // that no longer appear in the session list (e.g., after kill/cleanup)
      const currentSessionIds = new Set(sessions.map((s) => s.id));
      for (const trackedId of states.keys()) {
        if (!currentSessionIds.has(trackedId)) {
          states.delete(trackedId);
        }
      }
      for (const trackedId of prpPhases.keys()) {
        if (!currentSessionIds.has(trackedId)) {
          prpPhases.delete(trackedId);
        }
      }
      for (const trackerKey of reactionTrackers.keys()) {
        const sessionId = trackerKey.split(":")[0];
        if (sessionId && !currentSessionIds.has(sessionId)) {
          reactionTrackers.delete(trackerKey);
        }
      }

      // Check if all sessions are complete (trigger reaction only once)
      const activeSessions = sessions.filter((s) => s.status !== "merged" && s.status !== "killed");
      if (sessions.length > 0 && activeSessions.length === 0 && !allCompleteEmitted) {
        allCompleteEmitted = true;

        // Execute all-complete reaction if configured
        const reactionKey = eventToReactionKey("summary.all_complete");
        if (reactionKey) {
          const reactionConfig = config.reactions[reactionKey];
          if (reactionConfig && reactionConfig.action) {
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              await executeReaction("system", "all", reactionKey, reactionConfig as ReactionConfig);
            }
          }
        }
      }
    } catch {
      // Poll cycle failed — will retry next interval
    } finally {
      polling = false;
    }
  }

  return {
    start(intervalMs = 30_000): void {
      if (pollTimer) return; // Already running
      pollTimer = setInterval(() => void pollAll(), intervalMs);
      // Run immediately on start
      void pollAll();
    },

    stop(): void {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },

    getStates(): Map<SessionId, SessionStatus> {
      return new Map(states);
    },

    async check(sessionId: SessionId): Promise<void> {
      const session = await sessionManager.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      await checkSession(session);
    },
  };
}
