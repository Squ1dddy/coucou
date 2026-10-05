// Integration events → island state. Port of the `handle…` methods in the Swift
// pollers: a genuinely new item flips the pill to finished/error, badges it when
// the pill isn't focused, plays a sound, and clears itself after 60 s.

import { onEvent, Bridge, type IntegrationUpdate } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Island } from "./island";
import { parseCalendarEvents, planHeadsUp, type CalendarEvent } from "./headsup";

/** Which Credential Manager key backs each pill. */
const KEY_FOR: Record<string, string> = {
  integration_stripe: "stripe-api-key",
  integration_vercel: "vercel-token",
  integration_n8n: "n8n-api-key",
  integration_notion: "notion-api-key",
  integration_calcom: "calcom-api-key",
};

/** Pills that sign in with OAuth: configured means connected. */
const OAUTH_FOR: Record<string, string> = {
  integration_spotify: "spotify",
  integration_gcal: "google",
};

const clearTimers = new Map<string, number>();

/** Calendar event ids that already had their heads-up (this session). */
const headsUpFired = new Set<string>();
/** Pending heads-up timers, replaced wholesale on every poll so they never stack. */
let headsUpTimers: number[] = [];

function cancelHeadsUps() {
  for (const t of headsUpTimers) window.clearTimeout(t);
  headsUpTimers = [];
}

export function registerIntegrationHandlers(island: Island) {
  void onEvent<IntegrationUpdate>("integration", (update) => handle(island, update));
  void onEvent<string>("oauth-changed", () => void refreshConfigured());
  void refreshConfigured();
}

/** Asks Rust which keys exist so the idle cards can say so. */
export async function refreshConfigured() {
  for (const [id, key] of Object.entries(KEY_FOR)) {
    const present = (await Bridge.secretPresent(key)) ?? false;
    const info = State.integrations[id] ?? { data: {}, error: null, loaded: false, configured: false };
    State.integrations[id] = { ...info, configured: present };
  }
  for (const [id, provider] of Object.entries(OAUTH_FOR)) {
    const connected = (await Bridge.oauthStatus(provider)) ?? false;
    const info = State.integrations[id] ?? { data: {}, error: null, loaded: false, configured: false };
    // Signing in or out drops what the last poll said, so the card starts clean.
    State.integrations[id] =
      connected === info.configured
        ? info
        : { data: {}, error: null, loaded: false, configured: connected };
    if (!connected) {
      const task = State.tasks.find((t) => t.id === id);
      if (task) task.state = "idle";
      if (id === "integration_gcal") cancelHeadsUps();
    } else if (!info.configured) {
      // Just signed in: fetch now instead of waiting for the next slow poll.
      void Bridge.refreshIntegration(id);
    }
  }
  const hooks = State.settings.hooksInstalled;
  const claude = State.integrations.integration_claude ?? {
    data: {}, error: null, loaded: false, configured: false,
  };
  State.integrations.integration_claude = { ...claude, configured: hooks };
  State.notify();
}

function handle(island: Island, update: IntegrationUpdate) {
  if (State.paused) return;

  const previous = State.integrations[update.id];
  State.integrations[update.id] = {
    data: update.error ? (previous?.data ?? {}) : update.data,
    error: update.error,
    loaded: update.error ? (previous?.loaded ?? false) : true,
    configured: previous?.configured ?? true,
  };

  // Music has no events: the bot just bobs while something plays.
  if (update.id === "integration_spotify" && !update.error) {
    const task = State.tasks.find((t) => t.id === update.id);
    if (task) task.state = update.data.playing === true ? "working" : "idle";
  }

  // Calendar: the bot stays idle; each poll re-plans the 10-minute heads-ups.
  if (update.id === "integration_gcal" && !update.error) {
    syncHeadsUps(island, parseCalendarEvents(update.data.events));
  }

  if (update.event) raise(island, update.id, update.event);

  State.notify();
}

/** Badge, sound, compact reveal and a 60 s auto-clear for one integration event. */
function raise(island: Island, id: string, event: NonNullable<IntegrationUpdate["event"]>) {
  const task = State.tasks.find((t) => t.id === id);
  if (!task) return;
  task.state = event.success ? "finished" : "error";
  task.steps = event.detail ? [event.label, event.detail] : [event.label];
  task.stepIndex = task.steps.length - 1;
  if (State.focusId !== id) {
    task.pillBadge = event.success ? "finished" : "error";
  }
  Sound.play(event.success ? "finish" : "error");
  // Same as the Swift pollers: show the compact island so the badge is seen,
  // but never steal the screen for a successful deploy.
  island.reveal();

  const existing = clearTimers.get(id);
  if (existing != null) window.clearTimeout(existing);
  clearTimers.set(
    id,
    window.setTimeout(() => {
      clearTimers.delete(id);
      const t = State.tasks.find((x) => x.id === id);
      if (!t || (t.state !== "finished" && t.state !== "error")) return;
      t.state = "idle";
      t.steps = [];
      t.stepIndex = 0;
      t.pillBadge = null;
      State.notify();
    }, 60_000),
  );
}

function headsUp(island: Island, event: CalendarEvent) {
  if (headsUpFired.has(event.id)) return;
  headsUpFired.add(event.id);
  if (State.paused) return;
  raise(island, "integration_gcal", { success: true, label: "In 10 min", detail: event.title || null });
  State.notify();
}

/** Replaces every pending timer with the plan for the latest poll. */
function syncHeadsUps(island: Island, events: CalendarEvent[]) {
  cancelHeadsUps();
  const plan = planHeadsUp(events, Date.now(), headsUpFired);
  for (const event of plan.now) headsUp(island, event);
  for (const { event, delayMs } of plan.later) {
    headsUpTimers.push(window.setTimeout(() => headsUp(island, event), delayMs));
  }
}
