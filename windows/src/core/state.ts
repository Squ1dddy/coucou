// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";

export type AgentSource = "claudeCode" | "n8n" | "agent";
export type AccessoryKind = "headphones" | "calendar";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
  /** Claude Code session this entry is bound to (Claude tasks only). */
  sessionId?: string | null;
  /**
   * What names this session on the stage: its title, else the first prompt.
   * Only valid while `session` equals `sessionId` (main gets rebound).
   */
  label?: { session: string; title: string | null; firstPrompt: string | null; checkedAt: number } | null;
  /** Folder name of the session's cwd, shown under "Claude Code". */
  project?: string | null;
  /** When this session started (ms), so the oldest extra can be promoted. */
  startedAt?: number | null;
  /** Last UserPromptSubmit (ms). */
  promptAt?: number | null;
  /** A long turn finished while this session was off stage: celebrate when it comes on. */
  celebratePending?: boolean;
  /** Last step appended (ms). */
  updatedAt?: number | null;
  /** Last hook event of any kind for this session (ms), for expiring dead sessions. */
  lastEventAt?: number | null;
  /** Subagents running for this session, in start order. */
  subagents?: Subagent[];
  /** Agent tool calls awaiting their SubagentStart (FIFO). */
  pendingAgents?: PendingAgent[];
  /** Brand prop Mochi wears (headphones, calendar page). */
  accessory?: AccessoryKind | null;
}

/** A subagent a Claude session is running right now. Finished ones are removed. */
export interface Subagent {
  agentId: string;
  /** subagent_type, or the agent_type from SubagentStart. */
  type: string;
  /** What the Agent tool call said it was for; the type when that was never seen. */
  description: string;
  /** Display label ("Sonnet", "Same as Claude"), or null to hide the model line. */
  model: string | null;
  startedAt: number;
  /** Plain-English line for its latest tool call. */
  lastActivity: string;
  /** Last hook event of any kind from this subagent (ms). */
  lastEventAt: number;
}

/** An Agent tool call seen on the parent, waiting for its SubagentStart. */
export interface PendingAgent {
  description: string;
  type: string;
  /** Raw `model` from tool_input, if any. */
  model: string | null;
  at: number;
}

/** A pending Agent call that never got its SubagentStart is dropped after this. */
const PENDING_TTL_MS = 5 * 60 * 1000;
/** A subagent silent for this long is assumed gone (its Stop never came). */
export const SUBAGENT_TTL_MS = 30 * 60 * 1000;

/** "inherit" and the general-purpose agent run on the parent's model. */
/** Stage name for a Claude session: title, else first prompt, else null (use the task name). */
export function sessionLabel(t: AgentTask): string | null {
  if (!t.label || t.label.session !== t.sessionId) return null;
  return t.label.title ?? t.label.firstPrompt;
}

export function modelLabel(raw: string | null | undefined, type: string): string | null {
  const m = (raw ?? "").trim();
  if (m === "inherit") return "Same as Claude";
  if (m) return /^[a-z]+$/.test(m) ? m.charAt(0).toUpperCase() + m.slice(1) : m;
  return type === "general-purpose" ? "Same as Claude" : null;
}

/** One plan limit, as Rust reports it (`claude-usage` event). */
export interface ClaudeLimit {
  /** 0-100. */
  pct: number;
  resets_at_ms: number | null;
}

export interface ClaudeUsage {
  five_hour: ClaudeLimit | null;
  seven_day: ClaudeLimit | null;
  updated_ms: number;
  source: "claude" | "hud";
}

/** A Claude session with no hook event for this long, and not mid-turn, is gone. */
export const CLAUDE_SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * Session ids of Claude tasks that count as ended: idle, finished or error with
 * no hook event for `ttlMs`. Working, thinking, approval, question and ratelimit
 * tasks never expire.
 */
export function staleClaudeSessions(
  tasks: readonly AgentTask[], now: number, ttlMs = CLAUDE_SESSION_TTL_MS,
): string[] {
  return tasks
    .filter((t) =>
      t.source === "claudeCode" && !!t.sessionId && t.lastEventAt != null &&
      (t.state === "idle" || t.state === "finished" || t.state === "error") &&
      now - t.lastEventAt >= ttlMs)
    .map((t) => t.sessionId!);
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  command: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
  accessory: AccessoryKind | null = null,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], source, isIntegration: true,
  ...(accessory ? { accessory } : {}),
});

/** AgentTask.integrationAgents — same ids, names and colours as macOS. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  task("integration_claude", "Claude Code", "#D97757", "claudeCode"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
  task("integration_spotify", "Spotify", "#1DB954", "n8n", "headphones"),
  task("integration_gcal", "Google Calendar", "#4285F4", "n8n", "calendar"),
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_n8n", "integration_vercel",
  "integration_notion", "integration_calcom", "integration_stripe",
  "integration_spotify", "integration_gcal",
];

/** Drops connectors this build no longer has (e.g. GitHub, Resend) from saved
 *  settings, so a stale id can't hold one of the four active slots. */
export function withKnownIntegrations<T extends { activeIntegrations: string[] }>(s: T): T {
  return {
    ...s,
    activeIntegrations: s.activeIntegrations.filter((id) => TOGGLEABLE_INTEGRATION_IDS.includes(id)),
  };
}

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "secondary" | "cursor";
  autostart: boolean;
  hooksInstalled: boolean;
  /** Claude model used by the chat. */
  model: string;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  activeIntegrations: ["integration_n8n", "integration_vercel"],
  screen: "secondary",
  autostart: false,
  hooksInstalled: false,
  model: "claude-opus-5",
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;
  /** Direction of the last focus change, for the carousel slide (+1 = next agent). */
  focusDir: 1 | -1 = 1;

  /** Subagent the island is drilled into (Claude panel), or null. */
  drillAgentId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
  pendingApproval: ApprovalInfo | null = null;

  integrations: Record<string, IntegrationInfo> = {};

  /** Latest plan limits, or null until one source answered. */
  claudeUsage: ClaudeUsage | null = null;

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    // Which way the carousel slides: toward a later agent is "down" (+1).
    const from = this.tasks.findIndex((x) => x.id === this.focusTask?.id);
    this.focusDir = this.tasks.indexOf(t) >= from ? 1 : -1;
    // Moving to another entry leaves the subagent view at once.
    if (id !== this.focusId) this.drillAgentId = null;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  // ── Subagents ──────────────────────────────────────────────────────────────

  /** An Agent/Task tool call on the parent: remember it until SubagentStart. */
  queueAgent(taskId: string, p: { description: string; type: string; model: string | null }) {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return;
    const now = Date.now();
    const q = (t.pendingAgents ??= []).filter((x) => now - x.at < PENDING_TTL_MS);
    q.push({ ...p, at: now });
    t.pendingAgents = q.slice(-20);
  }

  /**
   * SubagentStart: claim the first pending call of the same type (else the first
   * pending one, else fall back to the type as the description). Returns the new
   * subagent so the caller can resolve its model.
   */
  startSubagent(taskId: string, agentId: string, type: string): Subagent | null {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t || !agentId) return null;
    const subs = (t.subagents ??= []);
    const known = subs.find((x) => x.agentId === agentId);
    if (known) return known;
    const now = Date.now();
    const q = (t.pendingAgents ??= []).filter((x) => now - x.at < PENDING_TTL_MS);
    let at = q.findIndex((x) => x.type === type);
    if (at < 0) at = q.length > 0 ? 0 : -1;
    const pending = at >= 0 ? q.splice(at, 1)[0] : null;
    t.pendingAgents = q;
    const kind = type || pending?.type || "agent";
    const sub: Subagent = {
      agentId, type: kind,
      description: pending?.description || kind,
      model: modelLabel(pending?.model, kind),
      startedAt: now, lastActivity: "Starting…", lastEventAt: now,
    };
    subs.push(sub);
    this.notify();
    return sub;
  }

  /** A tool event from a subagent: it never touches the parent's own line. */
  touchSubagent(taskId: string, agentId: string, activity?: string) {
    const sub = this.tasks.find((x) => x.id === taskId)?.subagents?.find((x) => x.agentId === agentId);
    if (!sub) return;
    sub.lastEventAt = Date.now();
    if (activity) sub.lastActivity = activity;
    this.notify();
  }

  stopSubagent(taskId: string, agentId: string) {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t?.subagents) return;
    const n = t.subagents.length;
    t.subagents = t.subagents.filter((x) => x.agentId !== agentId);
    if (t.subagents.length !== n) this.notify();
  }

  /** Drops subagents silent for `ttlMs`; true when any were dropped. */
  expireSubagents(now: number, ttlMs = SUBAGENT_TTL_MS): boolean {
    let any = false;
    for (const t of this.tasks) {
      if (!t.subagents?.length) continue;
      const keep = t.subagents.filter((x) => now - x.lastEventAt < ttlMs);
      if (keep.length !== t.subagents.length) {
        t.subagents = keep;
        any = true;
      }
    }
    if (any) this.notify();
    return any;
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    t.updatedAt = Date.now();
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** loadIntegrationTasks() — Claude Code always on, the rest opt-in (max 4). */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad =
        proto.id === "integration_claude" || this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Order: integration_claude, its extra sessions (claude_*), agent_* pills
    // (visible in slice(0,4)), then other integrations in declaration order.
    // The sort is stable, so extras and agents keep their insertion order.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    const rank = (id: string) =>
      id === "integration_claude" ? 0 : id.startsWith("claude_") ? 1 : id.startsWith("agent_") ? 2 : 3;
    this.tasks.sort((a, b) => {
      const ra = rank(a.id);
      const rb = rank(b.id);
      if (ra !== rb) return ra - rb;
      if (ra === 3) return order.indexOf(a.id) - order.indexOf(b.id);
      return 0;
    });
    if (!this.focusId) this.focusId = "integration_claude";
    this.notify();
  }

  removeTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.tasks.splice(idx, 1);
    if (this.focusId === id) this.drillAgentId = null;
    if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? "integration_claude";
    this.notify();
  }

  /** Creates a dynamic agent_ pill on first event; no-ops if it already exists.
   *  Inserted right after integration_claude so it appears in the visible slice(0,4). */
  upsertExternalAgent(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    // After integration_claude and any extra Claude sessions.
    let at = this.tasks.findIndex((t) => t.id === "integration_claude") + 1;
    while (this.tasks[at]?.id.startsWith("claude_")) at++;
    this.tasks.splice(at, 0, {
      id, name, color,
      state: "idle", stepIndex: 0, steps: [],
      source: "agent", isIntegration: false,
    });
    if (!this.focusId) this.focusId = id;
    this.notify();
  }

  /** The task a Claude Code session reports to: its own, else the main entry. */
  claudeTaskFor(sessionId: string | null | undefined): AgentTask | null {
    const main = this.tasks.find((t) => t.id === "integration_claude") ?? null;
    if (!sessionId) return main;
    return this.tasks.find((t) => t.sessionId === sessionId) ?? main;
  }

  /**
   * One carousel entry per live Claude Code session. The first session binds to
   * integration_claude (that id never changes); each further concurrent session
   * gets `claude_<session_id>`, kept in creation order right after the main one.
   */
  bindClaudeSession(sessionId: string): AgentTask | null {
    const main = this.tasks.find((t) => t.id === "integration_claude");
    if (!main) return null;
    if (!sessionId) return main;
    const known = this.tasks.find((t) => t.sessionId === sessionId);
    if (known) return known;
    const now = Date.now();
    if (!main.sessionId) {
      main.sessionId = sessionId;
      main.startedAt = now;
      main.lastEventAt = now;
      return main;
    }
    const extra: AgentTask = {
      id: `claude_${sessionId}`, name: "Claude Code", color: main.color,
      state: "idle", stepIndex: 0, steps: [],
      source: "claudeCode", isIntegration: false,
      sessionId, startedAt: now, lastEventAt: now,
    };
    let at = this.tasks.indexOf(main) + 1;
    while (this.tasks[at]?.id.startsWith("claude_")) at++;
    this.tasks.splice(at, 0, extra);
    this.notify();
    return extra;
  }

  /**
   * A Claude Code session ended. Extras are removed; when the main session ends
   * while extras are live, the oldest extra is promoted into integration_claude
   * so the main entry never disappears. Otherwise the main entry just goes calm.
   */
  endClaudeSession(sessionId: string) {
    const task = sessionId
      ? this.tasks.find((t) => t.sessionId === sessionId)
      : this.tasks.find((t) => t.id === "integration_claude");
    if (!task) return;
    const main = this.tasks.find((t) => t.id === "integration_claude")!;
    if (task !== main) {
      this.removeTask(task.id);
      return;
    }
    const extras = this.tasks
      .filter((t) => t.id.startsWith("claude_"))
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const next = extras[0];
    if (next) {
      main.state = next.state;
      main.steps = next.steps;
      main.stepIndex = next.stepIndex;
      main.sessionCwd = next.sessionCwd;
      main.project = next.project;
      main.label = next.label;
      main.sessionId = next.sessionId;
      main.startedAt = next.startedAt;
      main.promptAt = next.promptAt;
      main.celebratePending = next.celebratePending;
      main.updatedAt = next.updatedAt;
      main.lastEventAt = next.lastEventAt;
      main.pillBadge = next.pillBadge;
      main.subagents = next.subagents;
      main.pendingAgents = next.pendingAgents;
      const hadFocus = this.focusId === next.id;
      this.removeTask(next.id);
      if (hadFocus) this.focusId = main.id;
    } else {
      main.state = "idle";
      main.steps = [];
      main.stepIndex = 0;
      main.pillBadge = null;
      main.subagents = [];
      main.pendingAgents = [];
      main.sessionId = null;
      main.sessionCwd = null;
      main.project = null;
      main.label = null;
      main.startedAt = null;
      main.promptAt = null;
      main.celebratePending = false;
      main.updatedAt = null;
      main.lastEventAt = null;
    }
    this.notify();
  }

  toggleIntegration(id: string) {
    if (id === "integration_claude") return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = "integration_claude";
    } else {
      if (active.length >= 4) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
