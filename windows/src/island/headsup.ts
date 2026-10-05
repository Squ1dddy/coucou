// Google Calendar heads-up planning. Pure: no timers, no State, so the rules
// can be read (and tested) on their own. `integrations.ts` owns the timers.

/** How long before a timed event starts the bot gets attention. */
export const HEADS_UP_MS = 10 * 60_000;

export interface CalendarEvent {
  id: string;
  title: string;
  /** RFC 3339 date-time for timed events, `YYYY-MM-DD` for all-day ones. */
  start: string;
  allDay: boolean;
}

export interface HeadsUpPlan {
  /** Within 10 minutes of starting but not started yet: raise these now. */
  now: CalendarEvent[];
  /** Further out: raise each after `delayMs`. */
  later: { event: CalendarEvent; delayMs: number }[];
}

/**
 * What to do with the latest events.
 *
 * - All-day events, events without a readable start, and events that have
 *   already started never get a heads-up.
 * - An event whose id is in `fired` never gets a second one, across polls.
 * - Otherwise the heads-up is due at `start - 10 min`. If that moment has
 *   passed (first seen less than 10 min out) it is due immediately, once.
 *
 * The caller adds an id to `fired` when it raises the heads-up, and replaces
 * every pending timer with `later` on each poll, so timers never stack and a
 * moved event is picked up at its new time.
 */
export function planHeadsUp(events: CalendarEvent[], nowMs: number, fired: ReadonlySet<string>): HeadsUpPlan {
  const plan: HeadsUpPlan = { now: [], later: [] };
  const seen = new Set<string>();
  for (const event of events) {
    if (event.allDay || !event.id || fired.has(event.id) || seen.has(event.id)) continue;
    seen.add(event.id);
    const startMs = Date.parse(event.start);
    if (!Number.isFinite(startMs) || startMs <= nowMs) continue;
    const dueMs = startMs - HEADS_UP_MS;
    if (dueMs <= nowMs) plan.now.push(event);
    else plan.later.push({ event, delayMs: dueMs - nowMs });
  }
  return plan;
}

/** Reads the poll's `events` array defensively; anything malformed is dropped. */
export function parseCalendarEvents(value: unknown): CalendarEvent[] {
  if (!Array.isArray(value)) return [];
  const out: CalendarEvent[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.start !== "string") continue;
    out.push({
      id: e.id,
      title: typeof e.title === "string" ? e.title : "",
      start: e.start,
      allDay: e.allDay === true,
    });
  }
  return out;
}
