// Dev harness: every Mochi state, the one-shot animations and the mini bots side
// by side, for visual checks without the real island. Not part of the app bundle.

import { BotEngine, hexToRGB } from "../src/mochi/engine";
import { createMiniBot, tickMiniBots } from "../src/mochi/minibots";
import { INTEGRATION_AGENTS, type AccessoryKind, type AgentTask } from "../src/core/state";
import type { BotStateName } from "../src/core/layout";

const STATES: BotStateName[] = [
  "idle", "working", "thinking", "searching", "approval", "question",
  "error", "finished", "ratelimit", "sleeping", "dizzy",
];
const SIZE = Number(new URLSearchParams(location.search).get("size")) || 120;
const dpr = Math.min(2, window.devicePixelRatio || 1);
const bigs: { canvas: HTMLCanvasElement; engine: BotEngine }[] = [];

function bigBot(parent: HTMLElement, label: string, setup: (e: BotEngine) => void) {
  const cell = document.createElement("div");
  cell.className = "cell";
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE * dpr;
  canvas.style.width = canvas.style.height = `${SIZE}px`;
  const engine = new BotEngine();
  setup(engine);
  const name = document.createElement("span");
  name.textContent = label;
  cell.append(canvas, name);
  parent.append(cell);
  bigs.push({ canvas, engine });
}

const states = document.getElementById("states")!;
for (const s of STATES) bigBot(states, s, (e) => e.setState(s, true));

const connectors = document.getElementById("connectors")!;
for (const t of INTEGRATION_AGENTS) {
  bigBot(connectors, t.name, (e) => {
    e.bodyColor = hexToRGB(t.color);
    e.setAccessory(t.accessory ?? null, false);
    e.setState("idle", true);
  });
}
// Default orange Mochi wearing each prop.
bigBot(connectors, "Mochi + headphones", (e) => { e.setAccessory("headphones", false); e.setState("idle", true); });
bigBot(connectors, "Spotify playing", (e) => {
  e.bodyColor = hexToRGB(INTEGRATION_AGENTS.find((t) => t.id === "integration_spotify")!.color);
  e.setAccessory("headphones", false);
  e.setState("working", true);
});
bigBot(connectors, "Mochi + calendar", (e) => { e.setAccessory("calendar", false); e.setState("idle", true); });

const minis = document.getElementById("minis")!;
for (const size of [13, 24]) {
  const cell = document.createElement("div");
  cell.className = "cell mini-cell";
  for (const t of INTEGRATION_AGENTS) {
    const task: AgentTask = { ...t, state: t.id === "integration_claude" || t.id === "integration_spotify" ? "working" : "idle" };
    cell.append(createMiniBot(task, size));
  }
  minis.append(cell);
}

const controls = document.getElementById("controls")!;
const actions: [string, (e: BotEngine) => void][] = [
  ["Roll", (e) => e.doRoll(900, 1)],
  ["Greet", (e) => e.greet()],
  ["Squash", (e) => e.squash()],
  ["Slap", (e) => e.slap()],
  ["Gulp", (e) => e.gulp()],
  ["Morph in", (e) => e.animateMorph(1)],
  ["Morph out", (e) => e.animateMorph(0)],
];
// Props on/off: toggles every big bot's accessory (animated) to watch the presence motion.
const propKinds = new Map<BotEngine, AccessoryKind | null>();
for (const { engine } of bigs) propKinds.set(engine, engine.accessory);
let propsOn = true;
actions.push(["Props on/off", (e) => {
  const kind = propKinds.get(e) ?? null;
  e.setAccessory(propsOn ? null : kind, true);
}]);
for (const [label, fn] of actions) {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = () => {
    bigs.forEach((x) => fn(x.engine));
    if (label === "Props on/off") propsOn = !propsOn;
  };
  controls.append(b);
}

let last = performance.now();
function loop(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  for (const { canvas, engine } of bigs) {
    const ctx = canvas.getContext("2d")!;
    engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    engine.draw(ctx, SIZE, SIZE);
  }
  tickMiniBots(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
