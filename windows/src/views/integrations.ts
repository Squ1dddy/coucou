// Integration cards shown in the overview's left card — DOM ports of
// IntegrationCardView and friends from IslandViewContent.swift.
//
// Cal.com is the one simplification: macOS shows a three-level calendar
// (month → day → booking); here it is the list of upcoming bookings.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { State, type AgentTask } from "../core/state";
import { Bridge } from "../core/bridge";

/** Same shape as the Swift `timeAgo` computed properties. */
export function timeAgo(value: unknown): string {
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  const diff = (Date.now() - date.getTime()) / 1000;
  if (!Number.isFinite(diff)) return "";
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function header(color: string, name: string, kind: string, extra?: Node): HTMLElement {
  const row = h("div", { class: "int-head" }, dot(color, 7), h("b", { text: name }), h("span", { text: kind }));
  if (extra) row.append(extra);
  return row;
}

/** Highlighted first row + plain rows, the layout every list card shares. */
function listRow(accent: string, first: boolean, ...children: Node[]): HTMLElement {
  const row = h("div", { class: first ? "int-row first" : "int-row" }, dot(accent, 5), ...children);
  if (first) row.style.background = `${accent}14`;
  return row;
}

function get(id: string): Record<string, unknown> {
  return (State.integrations[id]?.data ?? {}) as Record<string, unknown>;
}

function arr(id: string, key: string): Record<string, unknown>[] {
  const v = get(id)[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

// ── Not configured / idle ─────────────────────────────────────────────────────

const OPEN_URLS: Record<string, string> = {
  integration_vercel: "https://vercel.com/dashboard",
  integration_stripe: "https://dashboard.stripe.com/payments",
  integration_notion: "https://notion.so",
  integration_calcom: "https://app.cal.com/bookings",
};

function idleCard(task: AgentTask, openSettings: () => void): HTMLElement {
  const info = State.integrations[task.id];
  const configured = info?.configured ?? false;
  const error = info?.error ?? null;
  // The Claude Code pill is about hooks, not a key — the macOS wording would be
  // misleading here.
  const missing =
    task.id === "integration_claude"
      ? "Hooks not installed"
      : task.id === "integration_spotify" || task.id === "integration_gcal"
        ? "Not connected"
        : "Key not configured";
  const label = error ?? (configured ? "Connected · loading…" : missing);
  const statusColor = error || !configured ? "#F4505E" : "#22C55E";

  const actions = h("div", { class: "int-actions" });
  if (task.id === "integration_claude") {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}b3`,
        text: "Open Claude",
        onclick: () => void Bridge.openSession(task.sessionCwd ?? null),
      }),
    );
  } else if (task.id === "integration_n8n") {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: "Open n8n",
        onclick: () => void Bridge.openN8n(),
      }),
    );
  } else if (OPEN_URLS[task.id]) {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: `Open ${task.name}`,
        onclick: () => void Bridge.openUrl(OPEN_URLS[task.id]),
      }),
    );
  }
  if (configured) {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: "Refresh",
        onclick: () => void Bridge.refreshIntegration(task.id),
      }),
    );
  } else {
    actions.append(
      h("button", { class: "link-btn", style: "color:#8e939c", text: "Settings…", onclick: openSettings }),
    );
  }

  return h(
    "div",
    { class: "int-card" },
    header(task.color, task.id === "integration_claude" ? "Claude Code" : task.name, "Integration"),
    h("div", { class: "int-status" }, dot(statusColor, 5), h("span", { text: label })),
    actions,
  );
}

// ── Vercel ────────────────────────────────────────────────────────────────────

function vercelCard(onDetail: () => void): HTMLElement {
  const deployments = arr("integration_vercel", "deployments");
  const rows = h("div", { class: "int-rows" });
  deployments.slice(0, 3).forEach((d, i) => {
    const accent = d.state === "READY" ? "#22C55E" : "#F4505E";
    const name = h("span", { class: "int-name", text: String(d.projectName ?? "") });
    const ago = h("span", { class: "int-ago", text: timeAgo(d.createdAt) });
    if (i === 0) {
      const more = h(
        "button",
        { class: "int-more", title: "Details", onclick: onDetail },
        svg(ICONS.ellipsis, 8),
      );
      rows.append(listRow(accent, true, name, ago, more));
    } else {
      rows.append(listRow(accent, false, name, ago));
    }
  });
  return h("div", { class: "int-card" }, header("#7C5CFF", "Vercel", "Deployments"), rows);
}

function vercelDetail(onBack: () => void): HTMLElement {
  const d = arr("integration_vercel", "deployments")[0] ?? {};
  const success = d.state === "READY";
  const accent = success ? "#22C55E" : "#F4505E";
  const status = success ? "Ready" : d.state === "CANCELED" ? "Canceled" : "Error";
  const body = h("div", { class: "int-detail-body" });
  if (d.commitMessage) body.append(h("div", { class: "int-commit", text: String(d.commitMessage) }));
  const meta = h("div", { class: "int-meta" });
  if (d.branch) meta.append(h("span", { text: String(d.branch) }));
  meta.append(h("span", { text: `${timeAgo(d.createdAt)} ago` }));
  body.append(meta);
  if (d.url) {
    body.append(
      h("button", {
        class: "int-link",
        text: String(d.url),
        onclick: () => void Bridge.openUrl(`https://${d.url}`),
      }),
    );
  }
  return h(
    "div",
    { class: "int-card detail" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(accent, 6),
      h("b", { text: String(d.projectName ?? "Deployment") }),
      h("span", { class: "int-badge", style: `color:${accent};background:${accent}24`, text: status }),
    ),
    body,
  );
}

// ── Stripe ────────────────────────────────────────────────────────────────────

function stripeCard(): HTMLElement {
  const d = get("integration_stripe");
  const balance = (Number(d.balance ?? 0) / 100).toFixed(2);
  const currency = String(d.currency ?? "eur").toUpperCase();
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("integration_stripe", "payments")) {
    const success = p.status === "succeeded";
    const accent = success ? "#22C55E" : "#F4505E";
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot(accent, 5),
        h("span", { class: "int-name", text: String(p.description ?? "Payment") }),
        h("span", {
          class: "int-amount",
          style: "color:#22c55e",
          text: `+${(Number(p.amount ?? 0) / 100).toFixed(2)}`,
        }),
        h("span", { class: "int-ago", text: timeAgo(p.createdAt) }),
      ),
    );
  }
  return h(
    "div",
    { class: "int-card" },
    header("#0570DE", "Stripe", "Payments"),
    h("div", { class: "int-balance" }, h("span", { text: balance }), h("i", { text: currency })),
    rows,
  );
}

// ── Notion ────────────────────────────────────────────────────────────────────

function notionCard(): HTMLElement {
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("integration_notion", "pages").slice(0, 3)) {
    rows.append(
      h(
        "button",
        {
          class: "int-page",
          onclick: () => {
            if (typeof p.url === "string") void Bridge.openUrl(p.url);
          },
        },
        p.emoji
          ? h("span", { class: "int-emoji", text: String(p.emoji) })
          : h("i", { class: "int-emoji" }, svg(ICONS.doc, 9)),
        h("span", { class: "int-name", text: String(p.title ?? "Untitled") }),
        h("span", { class: "int-ago", text: timeAgo(p.lastEditedAt) }),
      ),
    );
  }
  return h("div", { class: "int-card" }, header("#E8E8E8", "Notion", "Recent"), rows);
}

// ── Cal.com ───────────────────────────────────────────────────────────────────

function calcomCard(): HTMLElement {
  const bookings = arr("integration_calcom", "bookings")
    .slice()
    .sort((a, b) => new Date(String(a.start)).getTime() - new Date(String(b.start)).getTime());
  const rows = h("div", { class: "int-rows tight" });
  if (bookings.length === 0) {
    rows.append(h("div", { class: "int-empty", text: "No calls scheduled" }));
  }
  for (const b of bookings.slice(0, 3)) {
    const when = new Date(String(b.start));
    const day = when.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" });
    const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot("#C9956A", 4),
        h("span", { class: "int-time", text: `${day} ${time}` }),
        h("span", { class: "int-name", text: String(b.title ?? "Meeting") }),
      ),
    );
  }
  return h("div", { class: "int-card" }, header("#C9956A", "Cal.com", "Schedule"), rows);
}

// ── Live updates ──────────────────────────────────────────────────────────────
// The Spotify progress and the calendar's "in 20 min" badge move between polls.
// One light timer, on only while a live card is on screen and the island is
// showing the overview, so a hidden island stays at 0% CPU.

let liveTick: (() => void) | null = null;
let liveTimer: number | null = null;

function liveVisible(): boolean {
  return State.mode !== "hidden" && State.view === "overview";
}

function stopLive() {
  if (liveTimer != null) window.clearInterval(liveTimer);
  liveTimer = null;
}

/** Starts or stops the timer to match the current card and visibility. */
export function syncLiveTimer() {
  if (liveTick && liveVisible()) {
    if (liveTimer == null) {
      liveTimer = window.setInterval(() => {
        if (!liveTick || !liveVisible()) return stopLive();
        liveTick();
      }, 250);
    }
  } else {
    stopLive();
  }
}

/** Registers what the timer does; ends itself once its card has left the DOM. */
function setLive(anchor: HTMLElement | null, tick: (() => void) | null) {
  liveTick =
    anchor && tick
      ? () => {
          if (!anchor.isConnected) {
            liveTick = null;
            return stopLive();
          }
          tick();
        }
      : null;
}

/**
 * Part of the overview's re-render key for cards that depend on the clock.
 * Calendar: which event is "next".
 */
export function integrationCardSalt(id: string): string {
  return id === "integration_gcal" ? (nextEventId(calendarEntries()) ?? "") : "";
}

/** True while the user drags the volume slider: a poll must not rebuild it. */
export function integrationCardHeld(): boolean {
  return volumeDragging;
}

// ── Spotify ───────────────────────────────────────────────────────────────────

/** Last control failure ("Open Spotify on a device"); cleared by the next click or poll. */
let spotifyNote: string | null = null;

function spotifyControl(action: "play" | "pause" | "next" | "previous") {
  spotifyNote = null;
  Bridge.spotifyControl(action).catch((err) => {
    spotifyNote = String(err).replace(/^Error:\s*/, "");
    State.notify();
  });
}

/** The volume the user just set; shown instead of the polled one while Spotify catches up. */
let volumePending: { pct: number; at: number } | null = null;
let volumeDragging = false;
let volumeDebounce: number | null = null;
const VOLUME_HOLD_MS = 6000;

function setVolume(pct: number) {
  volumePending = { pct, at: Date.now() };
  if (volumeDebounce != null) window.clearTimeout(volumeDebounce);
  volumeDebounce = window.setTimeout(() => {
    volumeDebounce = null;
    spotifyNote = null;
    Bridge.spotifyVolume(pct).catch((err) => {
      volumePending = null;
      spotifyNote = String(err).replace(/^Error:\s*/, "");
      State.notify();
    });
  }, 200);
}

/** `m:ss` (or `h:mm:ss`) from milliseconds. */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The album art; the same <img> is reused across re-renders so a poll does not flash it. */
let artCache: { url: string; el: HTMLImageElement } | null = null;

function artTile(url: string, color: string): HTMLElement {
  const placeholder = () =>
    h("div", { class: "sp-art-empty", style: `background:${color}2e;color:${color}` }, svg(ICONS.musicNote, 34));
  const tile = h("div", { class: "sp-art" });
  if (!url) {
    tile.append(placeholder());
    return tile;
  }
  if (!artCache || artCache.url !== url) {
    const img = h("img", { src: url, alt: "", draggable: "false" });
    const entry = { url, el: img };
    img.addEventListener("error", () => {
      if (artCache === entry) artCache = null;
      img.replaceWith(placeholder());
    });
    artCache = entry;
  }
  tile.append(artCache.el);
  return tile;
}

function spotifyCard(task: AgentTask): HTMLElement {
  const d = get("integration_spotify");
  const title = typeof d.title === "string" ? d.title : "";
  const playing = d.playing === true;
  const trackUrl = typeof d.trackUrl === "string" ? d.trackUrl : "";
  const artUrl = typeof d.artUrl === "string" ? d.artUrl : "";
  const color = task.color;

  const control = (icon: string, label: string, action: "play" | "pause" | "next" | "previous", big = false) =>
    h(
      "button",
      { class: big ? "sp-btn big" : "sp-btn", title: label, "aria-label": label, onclick: () => spotifyControl(action) },
      svg(icon, big ? 16 : 12),
    );
  const buttons = h(
    "div",
    { class: "sp-controls" },
    control(ICONS.skipBack, "Previous", "previous"),
    playing
      ? control(ICONS.pause, "Pause", "pause", true)
      : control(ICONS.play, "Play", "play", true),
    control(ICONS.skipForward, "Next", "next"),
  );

  // Volume: hidden when Spotify says the device cannot be set (phones, some speakers).
  const controlsRow = h("div", { class: "sp-row" }, buttons);
  if (title && d.supportsVolume !== false) {
    const held = volumePending && Date.now() - volumePending.at < VOLUME_HOLD_MS ? volumePending.pct : null;
    const start = Math.round(held ?? (typeof d.volume === "number" ? d.volume : 50));
    const slider = h("input", {
      class: "sp-vol",
      type: "range",
      min: 0,
      max: 100,
      step: 1,
      value: start,
      "aria-label": "Volume",
      style: `--p:${start}%;--c:${color}`,
    });
    slider.addEventListener("input", () => {
      const pct = Number(slider.value);
      slider.style.setProperty("--p", `${pct}%`);
      setVolume(pct);
    });
    slider.addEventListener("pointerdown", () => {
      volumeDragging = true;
      window.addEventListener(
        "pointerup",
        () => {
          volumeDragging = false;
          State.notify();
        },
        { once: true },
      );
    });
    controlsRow.append(h("div", { class: "sp-volume" }, svg(ICONS.speakerOn, 12), slider));
  }

  const info = h("div", { class: "sp-info" });
  info.append(h("div", { class: "int-kind", text: title ? (playing ? "Now playing" : "Paused") : "Spotify" }));
  if (!title) {
    info.append(h("div", { class: "int-empty sp-none", text: spotifyNote ?? "Nothing playing" }), controlsRow);
    setLive(null, null);
  } else {
    info.append(
      h("button", {
        class: "sp-title",
        title: trackUrl ? "Open in Spotify" : "",
        text: title,
        onclick: () => {
          if (trackUrl) void Bridge.openUrl(trackUrl);
        },
      }),
      h("div", { class: "sp-artist", text: spotifyNote ?? String(d.artist ?? "") }),
    );

    const base = Number(d.progressMs ?? 0);
    const duration = Number(d.durationMs ?? 0);
    const at = Date.now();
    const elapsedEl = h("span", { class: "sp-time" });
    const fill = h("i", { style: `background:${color}` });
    const paint = (ms: number) => {
      const text = clock(ms);
      if (elapsedEl.textContent !== text) elapsedEl.textContent = text;
      const pct = duration > 0 ? Math.max(0, Math.min(1, ms / duration)) * 100 : 0;
      fill.style.width = `${pct.toFixed(2)}%`;
    };
    const now = () => (playing ? Math.min(duration || Infinity, base + Date.now() - at) : base);
    paint(now());
    info.append(
      h(
        "div",
        { class: "sp-progress" },
        elapsedEl,
        h("div", { class: "sp-bar" }, fill),
        h("span", { class: "sp-time", text: duration > 0 ? clock(duration) : "" }),
      ),
      controlsRow,
    );
    setLive(playing ? elapsedEl : null, playing ? () => paint(now()) : null);
  }

  return h("div", { class: "int-card sp" }, artTile(artUrl, color), info);
}

// ── Google Calendar ───────────────────────────────────────────────────────────

interface CalEntry {
  raw: Record<string, unknown>;
  allDay: boolean;
  start: Date;
  end: Date | null;
  /** Local midnight of the day the event is listed under (never before today). */
  day: number;
}

const DAY_MS = 86_400_000;

function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** RFC 3339 date-time, or a bare `YYYY-MM-DD` read as a local date. */
function parseWhen(value: unknown, allDay: boolean): Date | null {
  const text = String(value ?? "");
  const m = allDay ? /^(\d{4})-(\d{2})-(\d{2})/.exec(text) : null;
  const date = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Events in reading order: by day, all-day first, then by start. */
function calendarEntries(): CalEntry[] {
  const today = localMidnight(new Date());
  const out: CalEntry[] = [];
  for (const raw of arr("integration_gcal", "events")) {
    const allDay = raw.allDay === true;
    const start = parseWhen(raw.start, allDay);
    if (!start) continue;
    out.push({
      raw,
      allDay,
      start,
      end: raw.end ? parseWhen(raw.end, allDay) : null,
      day: Math.max(localMidnight(start), today),
    });
  }
  return out.sort(
    (a, b) => a.day - b.day || Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime(),
  );
}

/** The next timed event that has not ended: in progress, or the soonest upcoming. */
function nextEntry(entries: CalEntry[], nowMs = Date.now()): CalEntry | null {
  return entries.find((e) => !e.allDay && (e.end ?? e.start).getTime() > nowMs) ?? null;
}

function nextEventId(entries: CalEntry[]): string | null {
  const next = nextEntry(entries);
  return next ? String(next.raw.id ?? next.start.getTime()) : null;
}

/** "now", "in 20 min", "in 2 h", "in 3 d". */
function relativeBadge(start: Date, nowMs = Date.now()): string {
  const mins = Math.ceil((start.getTime() - nowMs) / 60_000);
  if (mins <= 0) return "now";
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `in ${hours} h` : `in ${Math.round(hours / 24)} d`;
}

function dayHeading(day: number): string {
  const diff = Math.round((day - localMidnight(new Date())) / DAY_MS);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return new Date(day).toLocaleDateString(undefined, { weekday: "long" });
}

function gcalCard(task: AgentTask): HTMLElement {
  const color = task.color;
  const entries = calendarEntries();
  const list = h("div", { class: "cal-list" });
  if (entries.length === 0) {
    list.append(h("div", { class: "int-empty", text: "Nothing in the next 3 days" }));
  }
  const next = nextEntry(entries);
  let badge: HTMLElement | null = null;
  let day = -1;
  for (const entry of entries) {
    if (entry.day !== day) {
      day = entry.day;
      list.append(h("div", { class: "cal-day", text: dayHeading(day) }));
    }
    const e = entry.raw;
    const link = typeof e.htmlLink === "string" ? e.htmlLink : "";
    const location = typeof e.location === "string" ? e.location : "";
    const isNext = entry === next;
    const row = h(
      "button",
      {
        class: isNext ? "cal-row next" : "cal-row",
        title: link ? "Open in Google Calendar" : "",
        style: isNext ? `--accent:${color};background:${color}14` : undefined,
        onclick: () => {
          if (link) void Bridge.openUrl(link);
        },
      },
      h("span", { class: "cal-time", text: entry.allDay ? "All day" : localClock(e.start) }),
      h("span", { class: "cal-title", text: String(e.title ?? "(No title)") }),
      location ? h("span", { class: "cal-loc", text: location }) : null,
    );
    if (isNext) {
      badge = h("span", {
        class: "cal-badge",
        style: `color:${color};background:${color}24`,
        text: relativeBadge(entry.start),
      });
      row.append(badge);
    }
    list.append(row);
  }

  if (badge && next) {
    const el: HTMLElement = badge;
    const renderedId = nextEventId(entries);
    setLive(el, () => {
      // The next event changed (one started or ended): rebuild the list.
      if (nextEventId(calendarEntries()) !== renderedId) return State.notify();
      const text = relativeBadge(next.start);
      if (el.textContent !== text) el.textContent = text;
    });
  } else {
    setLive(null, null);
  }

  return h("div", { class: "int-card cal" }, h("div", { class: "int-kind", text: "Upcoming" }), list);
}

/** "14:30" in the user's time zone from an RFC 3339 date-time. */
function localClock(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}


// ── n8n ───────────────────────────────────────────────────────────────────────

function n8nCard(task: AgentTask, onDetail: () => void, openSettings: () => void): HTMLElement {
  const hasActivity = task.steps.length > 0 && (task.state === "finished" || task.state === "error");
  if (!hasActivity) return idleCard(task, openSettings);
  const success = task.state === "finished";
  const accent = success ? "#22C55E" : "#F4505E";
  return h(
    "div",
    { class: "int-card" },
    header("#F29B38", "n8n", "Workflow"),
    h(
      "div",
      { class: "int-actions" },
      h(
        "button",
        {
          class: "int-pill",
          style: `background:${accent}1a;border-color:${accent}38`,
          onclick: onDetail,
        },
        dot(accent, 5),
        h("span", { class: "int-name", text: task.steps[0] ?? "Workflow" }),
        svg(ICONS.ellipsis, 8),
      ),
    ),
  );
}

function n8nDetail(task: AgentTask, onBack: () => void): HTMLElement {
  const success = task.state === "finished";
  const accent = success ? "#22C55E" : "#F4505E";
  const detail = task.steps[1];
  return h(
    "div",
    { class: "int-card detail" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(accent, 6),
      h("b", { text: task.steps[0] ?? "Workflow" }),
      h("span", {
        class: "int-badge",
        style: `color:${accent};background:${accent}24`,
        text: success ? "Success" : "Failed",
      }),
    ),
    detail
      ? h("pre", { class: "int-detail-text", text: detail })
      : h("div", {
          class: "int-status",
          text: success ? "Completed successfully." : "No error details available.",
        }),
  );
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export interface IntegrationCardHooks {
  detailOpen: boolean;
  openDetail(): void;
  closeDetail(): void;
  openSettings(): void;
}

/** True when this integration has data worth showing instead of the idle card. */
export function hasIntegrationData(id: string): boolean {
  const info = State.integrations[id];
  if (!info || info.error) return false;
  switch (id) {
    case "integration_vercel":
      return arr(id, "deployments").length > 0;
    case "integration_stripe":
      return info.loaded;
    case "integration_notion":
      return arr(id, "pages").length > 0;
    case "integration_calcom":
      return info.loaded;
    case "integration_spotify":
    case "integration_gcal":
      return info.loaded;
    default:
      return false;
  }
}

export function renderIntegrationCard(task: AgentTask, hooks: IntegrationCardHooks): HTMLElement {
  setLive(null, null); // only the Spotify and calendar cards register a timer below
  if (task.id === "integration_n8n") {
    const hasActivity = task.steps.length > 0 && (task.state === "finished" || task.state === "error");
    return hooks.detailOpen && hasActivity
      ? n8nDetail(task, hooks.closeDetail)
      : n8nCard(task, hooks.openDetail, hooks.openSettings);
  }
  if (task.id === "integration_vercel" && hasIntegrationData(task.id)) {
    return hooks.detailOpen ? vercelDetail(hooks.closeDetail) : vercelCard(hooks.openDetail);
  }
  if (!hasIntegrationData(task.id)) return idleCard(task, hooks.openSettings);

  switch (task.id) {
    case "integration_stripe":
      return stripeCard();
    case "integration_notion":
      return notionCard();
    case "integration_calcom":
      return calcomCard();
    case "integration_spotify":
      return spotifyCard(task);
    case "integration_gcal":
      return gcalCard(task);
    default:
      return idleCard(task, hooks.openSettings);
  }
}

export { clear };
