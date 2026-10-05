// Friendly activity text: asks the local Ollama (through Rust) to rewrite the
// plain activity line, and stores the answer on the task or subagent. The plain
// text always stays as the fallback, so nothing here may ever block or throw.

import { Bridge } from "./bridge";
import { State } from "./state";

/** At most one rewrite per key in this window; the latest facts win the trailing call. */
const MIN_GAP_MS = 4000;
const WARM_GAP_MS = 60_000;

interface Slot {
  lastAt: number;
  lastPlain: string;
  timer: number | null;
  /** The newest request, run when the window opens. */
  pending: (() => void) | null;
}

const slots = new Map<string, Slot>();
let lastWarm = 0;

function slotFor(key: string): Slot {
  let s = slots.get(key);
  if (!s) {
    // Bounded: the oldest key goes when there are many sessions/subagents.
    if (slots.size > 100) slots.delete(slots.keys().next().value as string);
    s = { lastAt: 0, lastPlain: "", timer: null, pending: null };
    slots.set(key, s);
  }
  return s;
}

function enabled(): boolean {
  return State.settings.friendlyActivity !== false;
}

/** Throttled per key, and only when the plain text changed. */
function throttled(key: string, plain: string, run: () => void) {
  if (!enabled()) return;
  const s = slotFor(key);
  if (plain === s.lastPlain) return;
  s.lastPlain = plain;
  s.pending = run;
  if (s.timer != null) return; // the trailing call will pick up the latest
  const wait = Math.max(0, s.lastAt + MIN_GAP_MS - Date.now());
  s.timer = window.setTimeout(() => {
    s.timer = null;
    s.lastAt = Date.now();
    const go = s.pending;
    s.pending = null;
    go?.();
  }, wait);
}

export const Friendly = {
  /** Pre-load the model, at most once a minute. */
  warm() {
    if (!enabled()) return;
    const now = Date.now();
    if (now - lastWarm < WARM_GAP_MS) return;
    lastWarm = now;
    void Bridge.ollamaWarm();
  },

  main(taskId: string, plain: string, transcriptPath?: string) {
    throttled(`m:${taskId}`, plain, () => {
      void (async () => {
        const said = transcriptPath ? await Bridge.lastAssistantText(transcriptPath) : null;
        const line = await Bridge.rewriteActivity(plain, said);
        const t = State.tasks.find((x) => x.id === taskId);
        // A newer step may have landed while Ollama was thinking.
        if (!line || !t || t.steps.at(-1) !== plain) return;
        t.friendly = line;
        t.friendlyFor = plain;
        State.notify();
      })();
    });
  },

  subagent(taskId: string, agentId: string, plain: string) {
    throttled(`s:${taskId}:${agentId}`, plain, () => {
      void (async () => {
        const find = () => State.tasks.find((x) => x.id === taskId)?.subagents?.find((x) => x.agentId === agentId);
        const said = find()?.description ?? null;
        const line = await Bridge.rewriteActivity(plain, said);
        const sub = find();
        if (!line || !sub || sub.lastActivity !== plain) return;
        sub.friendly = line;
        sub.friendlyFor = plain;
        State.notify();
      })();
    });
  },

  /** Stop: the idle "Last:" line, from what Claude said last. */
  finished(taskId: string, said: string) {
    if (!enabled()) return;
    void (async () => {
      const line = await Bridge.rewriteActivity("Finished", said);
      const t = State.tasks.find((x) => x.id === taskId);
      if (!line || !t || t.state === "thinking" || t.state === "working") return;
      t.friendlyIdle = line;
      State.notify();
    })();
  },
};
