// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { describeActivity } from "../core/activity";
import { Bridge, onEvent } from "../core/bridge";
import { shouldCelebrate } from "../core/celebrate";
import { Sound } from "../core/sound";
import { State, modelLabel, sessionLabel, staleClaudeSessions, type AgentTask, type ClaudeUsage } from "../core/state";
import type { Island } from "./island";
import type { Activity } from "../mochi/engine";
import type { BotStateName } from "../core/layout";

/** Claude Code tool -> the working animation Mochi plays (same tool groups as describeActivity). */
function toolAnimFor(tool: string): Activity {
  switch (tool) {
    case "Read": case "WebFetch": return "reading";
    case "Bash": case "PowerShell": return "bash";
    case "Grep": case "Glob": case "LS": case "WebSearch": return "searching";
    default: return "typing";
  }
}

const CLAUDE_ID = "integration_claude";

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  /** Set by coucou-hook from CLAUDE_CODE_HOST_SESSION_ID (Claude desktop app sessions only). */
  host_session_id?: string;
  /** SessionStart: "startup" | "resume" | "clear" | "compact". */
  source?: string;
  /** SessionEnd: "clear" | "logout" | "prompt_input_exit" | "other" | … */
  reason?: string;
  /** Stop: Claude's final reply for the turn. */
  last_assistant_message?: string;
  /** Set by coucou-hook from CLAUDE_CODE_SESSION_ATTENDED: "0" for a headless run. */
  session_attended?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Set on a subagent's own events (and SubagentStart/Stop). */
  agent_id?: string;
  agent_type?: string;
  /** Session transcript (JSONL), read for the session title. */
  transcript_path?: string;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  coucou_agent?: string;
}

/** Same rule as HookServer.validateAgent on macOS. "claude" is reserved. */
function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24 || raw === "claude") return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

function agentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

const TITLE_EVERY_MS = 15_000;

/** Keeps the session's stage label current: its title (re-read at most every 15s), else its first prompt. */
function refreshLabel(t: AgentTask, sessionId: string, transcript: string | undefined, prompt: string | undefined) {
  if (!sessionId) return;
  if (t.label?.session !== sessionId) t.label = { session: sessionId, title: null, firstPrompt: null, checkedAt: 0 };
  const label = t.label;
  const asked = prompt?.trim().replace(/\s+/g, " ");
  if (asked && !label.firstPrompt) label.firstPrompt = asked.slice(0, 60);
  if (!transcript || Date.now() - label.checkedAt < TITLE_EVERY_MS) return;
  label.checkedAt = Date.now();
  void Bridge.sessionTitle(transcript).then((title) => {
    if (title && t.label === label && title !== label.title) {
      label.title = title;
      State.notify();
    }
  });
}

function upsert(taskId: string, projectName: string, cwd: string, hostSession?: string) {
  const t = State.tasks.find((x) => x.id === taskId);
  if (!t) return;
  if (hostSession) t.hostSessionId = hostSession;
  if (cwd) {
    t.sessionCwd = cwd;
    t.project = projectName;
  }
}

/**
 * Sessions that already sent SessionEnd. A late event from one (a SubagentStop
 * after the end) must not bring its entry back or rebind the main one; a new
 * SessionStart / UserPromptSubmit (a resumed session) lifts the mark.
 */
const endedSessions = new Set<string>();

function markEnded(sessionId: string) {
  endedSessions.add(sessionId);
  if (endedSessions.size > 50) endedSessions.delete(endedSessions.values().next().value as string);
}

/** Ends sessions that went silent without a SessionEnd (closed terminal, crash). */
function expireStaleSessions(except = "") {
  // The session that just spoke is alive again, whatever its age.
  const stale = staleClaudeSessions(State.tasks, Date.now()).filter((sid) => sid !== except);
  // Not added to the ended set: only a real SessionEnd does that, so a session
  // that speaks again later simply binds like a new one.
  for (const sid of stale) State.endClaudeSession(sid);
  return stale.length > 0;
}

/**
 * Chats that may have just run /clear (old session id → timer that ends the
 * entry). The entry waits here for the SessionStart that carries the chat's new
 * session id. The terminal says `reason: "clear"`; the desktop app ends with
 * "other" and starts with "startup", so there any end of a chat waits briefly
 * for a new start under the same desktop session id.
 */
const clearing = new Map<string, number>();
const CLEAR_GRACE_MS = 30_000;
/** Desktop chat end without a stated reason: a /clear restarts within about a second. */
const HOST_END_GRACE_MS = 8_000;
/** A SessionStart that beat its own SessionEnd (separate hook processes) is this fresh. */
const CLEAR_RACE_MS = 5_000;

/** Same chat: same desktop session id, else (terminal, no id) same folder. */
function sameChat(t: AgentTask, host: string | undefined, cwd: string) {
  if (t.unattended) return false;
  return host ? t.hostSessionId === host : !t.hostSessionId && !!cwd && t.sessionCwd === cwd;
}

/** The chat's entry moves to its new session id. */
function rebind(from: string, to: string) {
  const timer = clearing.get(from);
  if (timer !== undefined) window.clearTimeout(timer);
  clearing.delete(from);
  State.rebindClaudeSession(from, to);
  for (const [child, parent] of workers) if (parent === from) workers.set(child, to);
  void Bridge.log(`rebind ${from.slice(0, 8)} -> ${to.slice(0, 8)}`);
}

/**
 * SessionEnd from /clear: keep the entry for the chat's next session id. Returns
 * false when there is no such entry to keep.
 */
function holdForClear(payload: HookPayload, sessionId: string, graceMs: number): boolean {
  const task = State.tasks.find((t) => t.sessionId === sessionId);
  if (!task || task.unattended) return false;
  // The new session's SessionStart may already be here, as an entry of its own.
  const fresh = State.tasks.find((t) =>
    t !== task && t.sessionId && sameChat(t, payload.host_session_id, payload.cwd ?? "")
    && t.steps.length === 0 && Date.now() - (t.startedAt ?? 0) < CLEAR_RACE_MS);
  if (fresh?.sessionId) {
    const to = fresh.sessionId;
    State.endClaudeSession(to);
    rebind(sessionId, to);
    return true;
  }
  clearing.set(sessionId, window.setTimeout(() => {
    clearing.delete(sessionId);
    State.endClaudeSession(sessionId);
  }, graceMs));
  return true;
}

/** SessionStart after /clear (or a compact under a new id): the held entry takes the new id. */
function resumeCleared(payload: HookPayload, sessionId: string) {
  if (State.tasks.some((t) => t.sessionId === sessionId)) return;
  const host = payload.host_session_id;
  const cwd = payload.cwd ?? "";
  const held = State.tasks.find((t) =>
    t.sessionId && (clearing.has(t.sessionId) || (payload.source === "compact" && !!host))
    && sameChat(t, host, cwd));
  // Fallback: exactly one held chat in this folder (in case the desktop id changed too).
  const inFolder = held ? [] : State.tasks.filter((t) =>
    t.sessionId && clearing.has(t.sessionId) && !t.unattended && !!cwd && t.sessionCwd === cwd);
  const match = held ?? (inFolder.length === 1 ? inFolder[0] : undefined);
  if (match?.sessionId) rebind(match.sessionId, sessionId);
}

let islandRef: Island | null = null;
/** A subagent this quiet when its parent stops again is treated as gone. */
const SILENT_SUB_MS = 10 * 60 * 1000;
const LIFECYCLE = new Set(["SessionStart", "SessionEnd", "Stop", "SubagentStart", "SubagentStop"]);
const SUBS_DONE_GRACE_MS = 4000;

/**
 * A session waiting on background subagents lost its last one. Claude usually
 * resumes the turn on its own (the result comes back as a prompt) and finishes
 * then; if it stays quiet for a moment, finish it here with a replayed Stop.
 */
function checkSubsDone(taskId: string) {
  const t = State.tasks.find((x) => x.id === taskId);
  if (!t?.waitingOnSubs || (t.subagents?.length ?? 0) > 0) return;
  const at = t.lastEventAt;
  window.setTimeout(() => {
    const now = State.tasks.find((x) => x.id === taskId);
    if (!now?.waitingOnSubs || (now.subagents?.length ?? 0) > 0 || now.lastEventAt !== at) return;
    now.waitingOnSubs = false;
    if (islandRef && now.sessionId) {
      handleHook(islandRef, {
        hook_event_name: "Stop", session_id: now.sessionId,
        cwd: now.sessionCwd ?? undefined, host_session_id: now.hostSessionId ?? undefined,
      });
    }
  }, SUBS_DONE_GRACE_MS);
}

export function registerHookHandlers(island: Island) {
  islandRef = island;
  window.setInterval(() => {
    // Nothing to expire or redraw while the island is hidden; the next event re-checks.
    if (State.mode !== "hidden") {
      expireStaleSessions();
      if (State.expireSubagents(Date.now())) State.tasks.forEach((t) => checkSubsDone(t.id));
    }
  }, 60_000);

  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));

  // Dev only: window.__coucouCelebrate() runs the focused celebration without a 5-minute wait.
  if (import.meta.env.DEV) {
    // Dev only: window.__coucouAnim("working", "bash") forces the stage Mochi's state and
    // activity for a visual check; window.__coucouAnim() clears it.
    (window as unknown as { __coucouFidget?: () => void }).__coucouFidget = () => island.triggerFidget();
    (window as unknown as { __coucouAnim?: (s?: BotStateName, a?: Activity | null) => void }).__coucouAnim = (s, a) => {
      State.stateOverride = s ?? null;
      State.activityOverride = a ?? null;
      if (s && State.mode === "hidden") island.reveal();
      State.notify();
      island.ensureRunning();
    };
    (window as unknown as { __coucouCelebrate?: () => void }).__coucouCelebrate = () => {
      if (State.mode === "hidden") island.reveal();
      window.setTimeout(() => island.celebrate(), 350);
    };
  }
  // Plan limits from Rust (Claude's get_usage, or the claude-hud file).
  void onEvent<ClaudeUsage>("claude-usage", (usage) => {
    State.claudeUsage = usage;
    State.notify();
  });
}

/**
 * No model on the Agent call: read the agent definition's frontmatter. Built-ins,
 * plugin agents and anything not found stay null, so the model line is hidden.
 */
async function resolveSubagentModel(
  taskId: string, agentId: string, type: string, current: string | null, cwd: string,
) {
  if (current || !type) return;
  let raw: string | null = null;
  try {
    raw = await Bridge.agentModel(cwd || null, type);
  } catch {
    return;
  }
  const label = modelLabel(raw, type);
  const sub = State.tasks.find((t) => t.id === taskId)?.subagents?.find((s) => s.agentId === agentId);
  if (!sub || !label || sub.model === label) return;
  sub.model = label;
  State.notify();
}

/** Background runs (child session id → the session id of the chat they show up in). */
const workers = new Map<string, string>();
const workerSubId = (sessionId: string) => `w_${sessionId}`;

/**
 * The first sentence of Claude's final reply, without markdown, for the finished
 * card; null when the reply opens with code or is empty.
 */
function replyHeadline(reply: string | undefined): string | null {
  if (!reply) return null;
  const line = reply.split(/\r?\n/).map((x) => x.trim()).find((x) => x.length > 0);
  if (!line || line.startsWith("```") || line.startsWith("|")) return null;
  const plain = line
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .replace(/^#+\s*|^[-*>]\s+|^\d+\.\s+/, "")
    .replace(/[*_`~]/g, "")
    .trim();
  const sentence = plain.split(/(?<=[.!?])\s/)[0] ?? plain;
  if (!sentence) return null;
  return sentence.length > 90 ? `${sentence.slice(0, 87).trimEnd()}…` : sentence;
}

/** Adds a background run to its parent chat as a helper. */
function adoptWorker(parent: AgentTask, sessionId: string, description: string) {
  // Keyed by session, not entry id: ending another entry can move this chat into main.
  workers.set(sessionId, parent.sessionId!);
  const subId = workerSubId(sessionId);
  if (parent.subagents?.some((x) => x.agentId === subId)) return;
  const now = Date.now();
  (parent.subagents ??= []).push({
    agentId: subId, type: "background", description: description || "Background session",
    model: null, startedAt: now, lastActivity: "Starting…", lastEventAt: now,
  });
  State.notify();
}

/** The chat (someone is in it) that owns this desktop session id, if it has spoken yet. */
const attendedParent = (host: string) =>
  State.tasks.find((x) => x.hostSessionId === host && !x.unattended && !!x.sessionId);

/**
 * A chat spoke: headless runs that showed up before it (as entries of their own,
 * e.g. after a restart) move into it as helpers.
 */
function adoptOrphans(parent: AgentTask) {
  const host = parent.hostSessionId;
  if (!host) return;
  for (const t of State.tasks.filter((x) => x.unattended && x.hostSessionId === host && x.sessionId)) {
    adoptWorker(parent, t.sessionId!, sessionLabel(t) ?? t.steps[0] ?? "");
    State.endClaudeSession(t.sessionId!);
  }
}

/**
 * A child `claude -p` inherits its parent's CLAUDE_CODE_HOST_SESSION_ID but runs
 * unattended (CLAUDE_CODE_SESSION_ATTENDED=0), so it is that chat's helper rather
 * than a session of its own. Returns true when the event was a helper's and is handled.
 */
function routeWorker(payload: HookPayload, name: string, sessionId: string): boolean {
  const host = payload.host_session_id;
  const parentSid = workers.get(sessionId);
  let parent = parentSid ? State.tasks.find((x) => x.sessionId === parentSid) : undefined;
  if (parentSid && !parent) workers.delete(sessionId);
  if (!parent) {
    if (!host || payload.session_attended !== "0") return false;
    parent = attendedParent(host);
    // No parent yet: it gets an entry of its own until the parent speaks.
    if (!parent) return false;
    const own = State.tasks.find((x) => x.sessionId === sessionId);
    adoptWorker(parent, sessionId, own ? (sessionLabel(own) ?? own.steps[0] ?? "") : "");
    if (own) State.endClaudeSession(sessionId);
  }
  // A question needs an answer, so it goes through the normal path and its own entry.
  if (payload.request_id) {
    workers.delete(sessionId);
    State.stopSubagent(parent.id, workerSubId(sessionId));
    return false;
  }
  const subId = workerSubId(sessionId);
  if (name === "SessionEnd") {
    workers.delete(sessionId);
    State.stopSubagent(parent.id, subId);
    checkSubsDone(parent.id);
    return true;
  }
  if (name === "UserPromptSubmit" && payload.prompt) {
    const sub = parent.subagents?.find((x) => x.agentId === subId);
    if (sub && sub.description === "Background session") sub.description = payload.prompt.trim().slice(0, 80);
  }
  const activity = name === "PreToolUse"
    ? describeActivity(payload.tool_name ?? "Tool", payload.tool_input ?? {})
    : undefined;
  State.touchSubagent(parent.id, subId, activity);
  return true;
}

function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  // Lifecycle only (no tool calls, no text): enough to trace a stuck "+1" later.
  if (LIFECYCLE.has(name)) {
    void Bridge.log(`hook ${name} sess=${(payload.session_id ?? "").slice(0, 8)} agent=${(payload.agent_id ?? "-").slice(0, 8)} attended=${payload.session_attended ?? "-"} why=${payload.reason ?? payload.source ?? "-"} host=${(payload.host_session_id || "-").slice(0, 14)}`);
  }
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");

  // Route to the right pill. Valid coucou_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved; absent or invalid → Claude Code pill unchanged.
  const validAgent = validateAgent(payload.coucou_agent);
  const isExternalAgent = validAgent !== null;
  const sessionId = payload.session_id ?? "";

  // Claude Code events go to the entry bound to their session: the main one for
  // the first live session, `claude_<session_id>` for each further one.
  if (!isExternalAgent) {
    if (name === "SessionEnd") {
      if (sessionId) markEnded(sessionId);
      // A helper's end drops it from its chat; it has no entry of its own to end.
      if (sessionId && routeWorker(payload, name, sessionId)) return;
      // /clear: same chat, new session id next. Its entry and name carry over.
      if (sessionId && payload.session_attended !== "0") {
        const grace = payload.reason === "clear" ? CLEAR_GRACE_MS
          : payload.host_session_id ? HOST_END_GRACE_MS : 0;
        if (grace && holdForClear(payload, sessionId, grace)) return;
      }
      State.endClaudeSession(sessionId);
      State.notify();
      return;
    }
    if (name === "SessionStart" || name === "UserPromptSubmit") {
      endedSessions.delete(sessionId);
    } else if (sessionId && endedSessions.has(sessionId)) {
      if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
      return;
    }
  }
  // A background `claude` run started from inside a session (auto-run workers and
  // the like) lives in that session as a helper, not as a session of its own.
  if (!isExternalAgent && sessionId && routeWorker(payload, name, sessionId)) return;
  if (!isExternalAgent && sessionId && name === "SessionStart" && payload.session_attended !== "0") {
    resumeCleared(payload, sessionId);
  }
  // A new session may only take main once the old, silent one has been expired.
  if (!isExternalAgent && sessionId) expireStaleSessions(sessionId);
  const agentId = validAgent
    ? `agent_${validAgent}`
    : (State.bindClaudeSession(sessionId)?.id ?? CLAUDE_ID);
  /** This turn picks up after background work: its clock keeps the original prompt's time. */
  let resumed = false;
  if (!isExternalAgent) {
    const t = State.tasks.find((x) => x.id === agentId);
    if (t) {
      t.lastEventAt = Date.now();
      // Every event carries it, so even a session that only finishes can be opened.
      if (payload.host_session_id) t.hostSessionId = payload.host_session_id;
      t.unattended = payload.session_attended === "0";
      // After this event is handled: adopting can merge entries and move this one.
      if (!t.unattended && sessionId) {
        queueMicrotask(() => {
          const chat = State.tasks.find((x) => x.sessionId === sessionId);
          if (chat && !chat.unattended) adoptOrphans(chat);
        });
      }
      // Claude picked the turn back up (often a background result arriving).
      if (!payload.agent_id && (name === "UserPromptSubmit" || name === "PreToolUse")) {
        resumed = !!t.waitingOnSubs;
        t.waitingOnSubs = false;
      }
      refreshLabel(t, sessionId, payload.transcript_path, name === "UserPromptSubmit" ? payload.prompt : undefined);
    }
  }

  const focused = State.focusId === agentId;

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  /** Ensure the agent pill exists (no-op for Claude Code). */
  const ensurePill = () => {
    if (isExternalAgent) {
      State.upsertExternalAgent(agentId, validAgent!, agentColor(validAgent!));
    } else {
      upsert(agentId, projectName, cwd, payload.host_session_id);
    }
  };

  switch (name) {
    case "SessionStart":
      ensurePill();
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      ensurePill();
      State.updateTask(agentId, "thinking");
      {
        const t = State.tasks.find((x) => x.id === agentId);
        if (t) t.toolAnim = null;
        // A background result handed back to Claude is the same job carrying on, so
        // the celebration clock (5 min) runs from the prompt that started it.
        const notice = (payload.prompt ?? "").trimStart().startsWith("<task-notification");
        if (t && !isExternalAgent && !resumed && !notice) {
          t.promptAt = Date.now();
          t.celebratePending = false;
        }
        resumed ||= notice;
      }
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked && !resumed) State.appendStep(agentId, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      // A parent (or subagent) spawning an agent: its description and model are
      // only known here, SubagentStart carries neither.
      if (!isExternalAgent && (payload.tool_name === "Agent" || payload.tool_name === "Task")) {
        const input = payload.tool_input ?? {};
        const text = (k: string) => (typeof input[k] === "string" ? (input[k] as string).trim() : "");
        State.queueAgent(agentId, {
          description: text("description").slice(0, 80) || text("subagent_type"),
          type: text("subagent_type"),
          model: text("model") || null,
        });
      }
      // A subagent's own tool call: it updates that subagent, never the parent.
      if (!isExternalAgent && payload.agent_id) {
        State.touchSubagent(
          agentId, payload.agent_id, describeActivity(payload.tool_name ?? "Tool", payload.tool_input ?? {}),
        );
        break;
      }
      ensurePill();
      State.updateTask(agentId, "working");
      const tool = payload.tool_name ?? "Tool";
      if (!isExternalAgent) {
        const t = State.tasks.find((x) => x.id === agentId);
        if (t) t.toolAnim = toolAnimFor(tool);
      }
      State.appendStep(agentId, describeActivity(tool, payload.tool_input ?? {}));
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      if (!isExternalAgent && payload.agent_id) {
        State.touchSubagent(agentId, payload.agent_id);
        break;
      }
      State.updateTask(agentId, "working");
      break;

    case "PostToolUseFailure":
      if (!isExternalAgent && payload.agent_id) {
        State.touchSubagent(agentId, payload.agent_id);
        break;
      }
      State.updateTask(agentId, "working");
      State.appendStep(agentId, "⚠ failed");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(agentId, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        State.updateTask(agentId, "question");
        State.appendStep(agentId, message);
      }
      break;
    }

    case "Stop": {
      // Only Claude's own clean Stop after a long turn; subagent stops are SubagentStop.
      const stopTask = State.tasks.find((x) => x.id === agentId);
      // A subagent silent this long most likely ended without a word (a lost
      // SubagentStop / SessionEnd, e.g. while Coucou restarted); it must not hold
      // the session busy for the full 30-minute expiry.
      if (!isExternalAgent && stopTask?.subagents?.length) {
        const now = Date.now();
        const live = stopTask.subagents.filter((x) => now - x.lastEventAt < SILENT_SUB_MS);
        if (live.length !== stopTask.subagents.length) {
          void Bridge.log(`stop: dropped ${stopTask.subagents.length - live.length} silent subagent(s)`);
          stopTask.subagents = live;
        }
      }
      // Background subagents still at work: the session is not done, keep it busy.
      if (!isExternalAgent && stopTask && (stopTask.subagents?.length ?? 0) > 0) {
        stopTask.waitingOnSubs = true;
        stopTask.toolAnim = null;
        State.updateTask(agentId, "thinking");
        break;
      }
      if (stopTask) {
        stopTask.waitingOnSubs = false;
        stopTask.doneText = isExternalAgent ? null : replyHeadline(payload.last_assistant_message);
      }
      const celebrate = !isExternalAgent && !payload.agent_id && !!stopTask &&
        shouldCelebrate(stopTask.promptAt, Date.now());
      // A finished agent off stage takes the stage, unless the user has the island open.
      const takeStage = !focused && !!stopTask && State.mode !== "expanded";
      if (takeStage) State.setFocus(agentId);
      const onStage = focused || takeStage;
      // Still off stage: the finish chime and badge as before, the party waits for the focus.
      if (celebrate && !onStage && stopTask) stopTask.celebratePending = true;
      if (stopTask) stopTask.toolAnim = null;
      State.updateTask(agentId, "finished");
      if (payload.message) State.appendStep(agentId, payload.message.slice(0, 60));
      if (!(celebrate && onStage)) Sound.play("finish");
      if (onStage) surface("finished", true);
      else State.setPillBadge(agentId, "finished");
      // Once the finished view has had a moment to open; plays "proud" instead of "finish".
      if (celebrate && onStage) window.setTimeout(() => island.celebrate(), 350);
      window.setTimeout(() => {
        if (isExternalAgent) {
          State.removeTask(agentId);
        } else {
          State.updateTask(agentId, "idle");
          State.setPillBadge(agentId, null);
        }
      }, 5200);
      break;
    }

    case "StopFailure":
      State.updateTask(agentId, "error");
      Sound.play("error");
      if (focused) surface("error", true);
      else State.setPillBadge(agentId, "error");
      break;

    case "SessionEnd":
      // Claude Code's own SessionEnd is handled above; only external agents land here.
      State.removeTask(agentId);
      break;

    case "SubagentStart": {
      if (isExternalAgent || !payload.agent_id) break;
      const sub = State.startSubagent(agentId, payload.agent_id, payload.agent_type ?? "");
      if (sub) void resolveSubagentModel(agentId, sub.agentId, sub.type, sub.model, cwd);
      break;
    }

    case "SubagentStop":
      if (!isExternalAgent && payload.agent_id) {
        State.stopSubagent(agentId, payload.agent_id);
        checkSubsDone(agentId);
      }
      break;

    case "PermissionRequest": {
      // External agents do not get an approval card — showing one would look like
      // a Claude Code request. Decline immediately so the agent re-asks in its
      // terminal. Approval support for other agents will come with Codex support.
      if (isExternalAgent) {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        break;
      }

      // AskUserQuestion is not a yes/no permission: Allow would only let the
      // question through and Deny would block Claude from asking. Hand it straight
      // back so Claude Code shows its own picker, and just say questions are waiting.
      if (payload.tool_name === "AskUserQuestion") {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        upsert(agentId, projectName, cwd, payload.host_session_id);
        const questions = (payload.tool_input as { questions?: unknown[] } | undefined)?.questions;
        const count = Array.isArray(questions) ? questions.length : 1;
        State.updateTask(agentId, "question");
        State.appendStep(agentId, count > 1 ? `Claude has ${count} questions for you` : "Claude has a question for you");
        Sound.play("question");
        // No pills to click any more: the question takes the carousel over.
        State.setFocus(agentId);
        island.alert("question");
        break;
      }

      const requestId = payload.request_id ?? "";
      // One card, one request. A second one must never quietly replace the first
      // — that would leave a human staring at request B while request A waits for
      // a decision nobody can give. Hand it straight back to the terminal.
      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      upsert(agentId, projectName, cwd, payload.host_session_id);
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      State.pendingApproval = {
        requestId,
        sessionId,
        tool,
        command: approvalTarget(tool, input),
      };
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      State.updateTask(agentId, "approval");
      State.isPinned = true;
      Sound.play("approval");
      // No pills to click any more: the card takes the carousel over, and Claude
      // stays focused once the view returns to the overview.
      State.setFocus(agentId);
      island.alert("approval");
      // Coucou answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        if (!State.pendingApproval) return;
        State.pendingApproval = null;
        State.isPinned = false;
        island.dropPin();
        const owner = State.claudeTaskFor(sessionId)?.id ?? CLAUDE_ID;
        State.updateTask(owner, "working");
        State.setPillBadge(owner, null);
        if (State.view === "approval") island.setView(State.defaultView());
        State.notify();
      }, 110_000);
      break;
    }

    default:
      break;
  }
  State.notify();
}
