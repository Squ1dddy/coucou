// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { describeActivity } from "../core/activity";
import { Bridge, onEvent } from "../core/bridge";
import { Friendly } from "../core/friendly";
import { Sound } from "../core/sound";
import { State, modelLabel, staleClaudeSessions, type ClaudeUsage } from "../core/state";
import type { Island } from "./island";

const CLAUDE_ID = "integration_claude";

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Set on a subagent's own events (and SubagentStart/Stop). */
  agent_id?: string;
  agent_type?: string;
  /** Path of the session's JSONL transcript. */
  transcript_path?: string;
  /** Stop: what Claude said last. */
  last_assistant_message?: string;
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

function upsert(taskId: string, projectName: string, cwd: string) {
  const t = State.tasks.find((x) => x.id === taskId);
  if (!t) return;
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

export function registerHookHandlers(island: Island) {
  window.setInterval(() => {
    // Nothing to expire or redraw while the island is hidden; the next event re-checks.
    if (State.mode !== "hidden") {
      expireStaleSessions();
      State.expireSubagents(Date.now());
    }
  }, 60_000);

  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
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

function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
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
  // A new session may only take main once the old, silent one has been expired.
  if (!isExternalAgent && sessionId) expireStaleSessions(sessionId);
  const agentId = validAgent
    ? `agent_${validAgent}`
    : (State.bindClaudeSession(sessionId)?.id ?? CLAUDE_ID);
  if (!isExternalAgent) {
    const t = State.tasks.find((x) => x.id === agentId);
    if (t) t.lastEventAt = Date.now();
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
      upsert(agentId, projectName, cwd);
    }
  };

  switch (name) {
    case "SessionStart":
      if (!isExternalAgent) Friendly.warm();
      ensurePill();
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      ensurePill();
      State.updateTask(agentId, "thinking");
      {
        const t = State.tasks.find((x) => x.id === agentId);
        if (t && !isExternalAgent) {
          t.promptAt = Date.now();
          // A new turn: nothing from the last one may show.
          t.friendly = null;
          t.friendlyFor = null;
          t.friendlyIdle = null;
        }
      }
      if (!isExternalAgent) Friendly.warm();
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(agentId, asked.slice(0, 60));
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
        const plain = describeActivity(payload.tool_name ?? "Tool", payload.tool_input ?? {});
        State.touchSubagent(agentId, payload.agent_id, plain);
        Friendly.subagent(agentId, payload.agent_id, plain);
        break;
      }
      ensurePill();
      State.updateTask(agentId, "working");
      const tool = payload.tool_name ?? "Tool";
      const plain = describeActivity(tool, payload.tool_input ?? {});
      State.appendStep(agentId, plain);
      if (!isExternalAgent) Friendly.main(agentId, plain, payload.transcript_path);
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

    case "Stop":
      State.updateTask(agentId, "finished");
      if (payload.message) State.appendStep(agentId, payload.message.slice(0, 60));
      if (!isExternalAgent && payload.last_assistant_message) Friendly.finished(agentId, payload.last_assistant_message);
      Sound.play("finish");
      if (focused) surface("finished", true);
      else State.setPillBadge(agentId, "finished");
      window.setTimeout(() => {
        if (isExternalAgent) {
          State.removeTask(agentId);
        } else {
          State.updateTask(agentId, "idle");
          State.setPillBadge(agentId, null);
        }
      }, 5200);
      break;

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
      if (!isExternalAgent && payload.agent_id) State.stopSubagent(agentId, payload.agent_id);
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
        upsert(agentId, projectName, cwd);
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
      upsert(agentId, projectName, cwd);
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
