// Claude detail panel: what the session is doing, the plan limits, Open Claude.
// Shown for every Claude Code entry (the main one and each extra session).

import { h, dot } from "./dom";
import { State, type AgentTask, type ClaudeLimit } from "../core/state";
import { Bridge } from "../core/bridge";

/** Amber from this percentage, red from the next. */
export const WARN_PCT = 70;
export const CRIT_PCT = 90;
/** Usage older than this shows "updated N min ago". */
const STALE_MS = 5 * 60 * 1000;

const AMBER = "#F5A524";
const RED = "#F4505E";

/** The session is mid-turn (as opposed to idle or just finished). */
export function claudeActive(task: AgentTask): boolean {
  return task.state !== "idle" && task.state !== "finished";
}

/** The big line. T3 swaps in a friendly rewrite here; keep it the one place. */
export function claudeHeadline(task: AgentTask): string {
  // Before the first tool, the last step is the user's own prompt.
  if (task.state === "thinking") return "Thinking…";
  return task.steps.at(-1) ?? "Working…";
}

function minutesSince(ms: number, now: number): number {
  return Math.floor(Math.max(0, now - ms) / 60_000);
}

function span(m: number): string {
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h`;
}

/** "just now" under a minute, then "N min" / "N h". */
export function elapsedText(ms: number, now: number): string {
  const m = minutesSince(ms, now);
  return m < 1 ? "just now" : span(m);
}

/** Colour of a limit bar: the task colour, amber at 70 %, red at 90 %. */
export function barColor(pct: number, base: string): string {
  return pct >= CRIT_PCT ? RED : pct >= WARN_PCT ? AMBER : base;
}

/** "resets 22:50", or "resets Fri 09:00" when more than a day away. */
export function resetText(resetsAtMs: number | null, now: number): string {
  if (resetsAtMs == null || resetsAtMs <= now) return "";
  const d = new Date(resetsAtMs);
  const clock = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (resetsAtMs - now > 24 * 3_600_000) {
    return `resets ${d.toLocaleDateString([], { weekday: "short" })} ${clock}`;
  }
  return `resets ${clock}`;
}

function bar(label: string, limit: ClaudeLimit | null, base: string, now: number): HTMLElement | null {
  if (!limit) return null;
  const pct = Math.max(0, Math.min(100, limit.pct));
  const fill = h("i");
  fill.style.width = `${pct}%`;
  fill.style.background = barColor(pct, base);
  return h(
    "div",
    { class: "cl-limit" },
    h("span", { class: "cl-limit-name", text: label }),
    h("div", { class: "cl-bar" }, fill),
    h("span", { class: "cl-limit-pct", text: `${Math.round(pct)}%` }),
    h("span", { class: "cl-limit-reset", text: resetText(limit.resets_at_ms, now) }),
  );
}

/** Both limit bars plus the stale note; null when no source ever answered. */
function limits(base: string, now: number): HTMLElement | null {
  const usage = State.claudeUsage;
  if (!usage) return null;
  const rows = [bar("5h", usage.five_hour, base, now), bar("Week", usage.seven_day, base, now)].filter(
    (r): r is HTMLElement => r !== null,
  );
  if (rows.length === 0) return null;
  const box = h("div", { class: "cl-limits" }, ...rows);
  if (now - usage.updated_ms > STALE_MS) {
    box.append(h("div", { class: "cl-stale", text: `updated ${span(minutesSince(usage.updated_ms, now))} ago` }));
  }
  return box;
}

export function renderClaudePanel(task: AgentTask): HTMLElement {
  const now = Date.now();
  const top = h("div", { class: "cl-top" });

  if (claudeActive(task)) {
    const headline = claudeHeadline(task);
    top.append(h("div", { class: "cl-head", text: headline }));
    const fact = task.promptAt ? `${headline} · ${elapsedText(task.promptAt, now)}` : headline;
    top.append(h("div", { class: "cl-fact", text: fact }));
  } else if (task.steps.length > 0) {
    let ago = "";
    if (task.updatedAt) {
      ago = minutesSince(task.updatedAt, now) < 1 ? " · just now" : ` · ${elapsedText(task.updatedAt, now)} ago`;
    }
    top.append(h("div", { class: "cl-fact idle", text: `Last: ${task.steps.at(-1)}${ago}` }));
  } else if (!State.integrations.integration_claude?.configured) {
    top.append(h("div", { class: "int-status" }, dot("#F4505E", 5), h("span", { text: "Hooks not installed" })));
  } else {
    top.append(h("div", { class: "cl-fact idle", text: "No session running" }));
  }

  // Top line up top, limits + Open Claude pinned to the bottom, so nothing jumps
  // when a session starts.
  const bottom = h("div", { class: "cl-bottom" });
  const card = h("div", { class: "int-card cl" }, top, bottom);
  const bars = limits(task.color, now);
  if (bars) bottom.append(bars);
  bottom.append(
    h(
      "div",
      { class: "int-actions" },
      h("button", {
        class: "link-btn",
        style: `color:${task.color}b3`,
        text: "Open Claude",
        onclick: () => void Bridge.openSession(task.sessionCwd ?? null),
      }),
    ),
  );
  return card;
}
