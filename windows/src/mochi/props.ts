// Mochi's busy-state props: the little scenes drawn over the body while an agent
// works (laptop, thought cloud, magnifier, page, terminal). Ported from the
// approved mocks (windows/mochi-states-demo.html and mochi-states-2.html).
//
// Pixel values in the mocks were tuned at R = 51 (typing, thinking) and R = 42
// (the rest). Each draw function takes `s`, the factor that maps those absolute
// pixels to the real R, so the look matches at any stage size.
//
// The engine owns the timing: it calls overlayPose() in update() (pose must beat
// the mouse look) and drawOverlay() at the end of draw(), both with the same `t`.

import type { RGB } from "./engine";

export type Activity = "typing" | "reading" | "bash" | "searching";
export type OverlayKind = Activity | "thinking" | "approval" | "question" | "error" | "ratelimit";

/** The error scene plays once; it is over this many seconds after entering the state. */
export const ERROR_END = 3.2;

/** Anything above this (and any prop's `s`) is in canvas px; below it nothing is drawn. */
export const OVERLAY_MIN_R = 14;
/** Reference radii the mock pixel values were tuned at. */
const R_TYPING = 51;
const R_OTHER = 42;

const HAND = "#E08A6B";
const HAND_EDGE = "#B85C3E";
const BODY = "#D97757";
const AMBER = "#F5A524";
const CYAN = "#4DD2FF";
const FONT = `system-ui, "Segoe UI Variable Text", "Segoe UI", sans-serif`;

export interface HandStyle { fill: string; edge: string }

const css = (c: RGB, k: number, toward: 0 | 1) => {
  const m = (v: number) => Math.round((v + (toward - v) * k) * 255);
  return `rgb(${m(c[0])},${m(c[1])},${m(c[2])})`;
};

/** Mock colours for Mochi; lighter fill and darker edge derived from an integration's colour. */
export function handStyle(body: RGB | null): HandStyle {
  if (!body) return { fill: HAND, edge: HAND_EDGE };
  return { fill: css(body, 0.2, 1), edge: css(body, 0.3, 0) };
}

/** Which overlay (if any) a state + activity plays. */
export function overlayFor(state: string, activity: Activity | null): OverlayKind | null {
  if (state === "thinking") return "thinking";
  if (state === "searching") return "searching";
  if (state === "approval" || state === "question" || state === "error" || state === "ratelimit") return state;
  if (state === "working") return activity ?? "typing";
  return null;
}

/** Whether the overlay draws flat hands (the real side hands hide meanwhile). */
export function overlayHasHands(kind: OverlayKind): boolean {
  return kind !== "bash" && kind !== "error" && kind !== "ratelimit";
}

/** What an overlay forces on the engine. Look wins over the mouse; the rest is set after smoothing. */
export interface Pose {
  lookX?: number;
  lookY?: number;
  yaw?: number;
  pitch?: number;
  oy?: number;
  tilt?: number;
  /** Squash targets (the engine eases toward them). */
  sy?: number;
  sx?: number;
}

export function overlayPose(kind: OverlayKind, t: number): Pose {
  switch (kind) {
    case "typing":
      return { lookX: 0, lookY: -0.45, oy: -Math.abs(Math.sin(t * 10.5)) * 0.025 };
    case "thinking":
      return { tilt: Math.sin(t * 1.3) * 0.06 };
    case "searching": {
      // Driven straight onto yaw/pitch (no smoothing lag) so the eyes stay on the lens.
      const s = Math.sin(t * 1.6);
      return { lookX: s * 1.2, lookY: -0.2, yaw: s * 0.62, pitch: -0.1 };
    }
    case "reading": {
      const cyc = t % 4;
      const line = Math.floor((cyc / 3.6) * 5) % 5;
      const sweep = ((cyc / 3.6) * 5) % 1;
      return { lookX: -0.8 + sweep * 1.6, lookY: -0.25 - line * 0.08 };
    }
    case "bash":
      return { lookX: 1.1, lookY: 0.1 };
    case "ratelimit":
      return { sy: 0.9, sx: 1.07 };
    default:
      return {};
  }
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

export function hand(
  x: CanvasRenderingContext2D, hx: number, hy: number, r: number, style: HandStyle, s: number,
) {
  x.beginPath();
  x.ellipse(hx, hy, r, r * 0.82, 0, 0, Math.PI * 2);
  x.fillStyle = style.fill;
  x.fill();
  x.lineWidth = 1.2 * s;
  x.strokeStyle = style.edge;
  x.stroke();
}

type Puffs = readonly (readonly [number, number, number])[];
/** Small cloud (storm cloud, mock 2). */
export const CLOUD_SMALL: Puffs = [[-14, 3, 9], [-3, -4, 11], [10, -1, 10], [16, 5, 7], [0, 6, 9], [-11, 8, 7]];
/** Big thought cloud (mock 1), drawn at scale 1.35 there. */
const CLOUD_BIG: Puffs = [[-22, 4, 14], [-6, -6, 17], [14, -2, 15], [24, 8, 11], [0, 10, 14], [-18, 12, 10]];

export function cloud(
  x: CanvasRenderingContext2D, px: number, py: number, scale: number, fill: string, puffs: Puffs = CLOUD_SMALL,
) {
  x.save();
  x.translate(px, py);
  x.scale(scale, scale);
  x.fillStyle = fill;
  x.beginPath();
  for (const [ox, oy, r] of puffs) {
    x.moveTo(ox + r, oy);
    x.arc(ox, oy, r, 0, Math.PI * 2);
  }
  x.fill();
  x.restore();
}

// ── Per-animation drawing ─────────────────────────────────────────────────────

function drawTyping(x: CanvasRenderingContext2D, R: number, cx: number, cy: number, t: number, hs: HandStyle) {
  const s = R / R_TYPING;
  const ky = cy + R * 0.72, kw = R * 2.0, kh = R * 0.42;
  x.save();
  x.fillStyle = "#2a2d34";
  x.beginPath();
  x.roundRect(cx - kw / 2, ky - kh * 0.2, kw, kh, 5 * s);
  x.fill();
  x.fillStyle = "#3a3e47";
  x.beginPath();
  x.roundRect(cx - kw / 2 - 4 * s, ky + kh * 0.55, kw + 8 * s, kh * 0.45, 4 * s);
  x.fill();
  x.fillStyle = "#555b66";
  for (let i = 0; i < 7; i++) {
    x.fillRect(cx - kw / 2 + 8 * s + i * (kw - 16 * s) / 7, ky + kh * 0.12, (kw - 16 * s) / 7 - 3 * s, kh * 0.22);
  }
  x.restore();

  const beat = t * 10.5;
  const L = Math.max(0, Math.sin(beat)), Rr = Math.max(0, Math.sin(beat + Math.PI));
  const hr = R * 0.2;
  const lx = cx - R * 0.42 + Math.sin(t * 1.9) * R * 0.14 + Math.sin(t * 4.3) * R * 0.04;
  const rx = cx + R * 0.42 + Math.sin(t * 1.5 + 2) * R * 0.14 + Math.sin(t * 3.7 + 1) * R * 0.04;
  hand(x, lx, ky + kh * 0.05 - L * R * 0.12, hr, hs, s);
  hand(x, rx, ky + kh * 0.05 - Rr * R * 0.12, hr, hs, s);
  for (const [v, sx, hx] of [[L, -1, lx], [Rr, 1, rx]] as const) {
    if (v > 0.92) {
      x.fillStyle = "rgba(255,255,255,0.8)";
      x.fillRect(hx + sx * 8 * s, ky - 6 * s, 2 * s, 5 * s);
      x.fillRect(hx - sx * 2 * s, ky - 9 * s, 2 * s, 5 * s);
    }
  }
}

function drawThinking(
  x: CanvasRenderingContext2D, R: number, cx: number, cy: number, t: number, hs: HandStyle, bodyHex: string,
) {
  const s = R / R_TYPING;
  hand(x, cx + R * 0.55 + Math.cos(t * 3) * 2 * s, cy + R * 0.62 + Math.sin(t * 3) * 1.5 * s, R * 0.17, hs, s);
  const bx = cx + R * 1.15, by = cy - R * 1.25;
  const trail = [[cx + R * 0.95, cy - R * 0.6, 4 * s], [cx + R * 1.12, cy - R * 0.88, 6.5 * s]];
  trail.forEach(([px, py, r], i) => {
    x.globalAlpha = 0.55 + 0.45 * Math.sin(t * 3 - i * 0.8);
    x.beginPath();
    x.arc(px, py, r, 0, Math.PI * 2);
    x.fillStyle = "#f2f2f2";
    x.fill();
  });
  x.globalAlpha = 1;
  const bob = Math.sin(t * 1.6) * 2.5 * s;
  const px = bx + R * 0.35, py = by - R * 0.3 + bob;
  cloud(x, px, py, 1.35 * s, "#f2f2f2", CLOUD_BIG);
  x.save();
  x.translate(px, py);
  x.scale(1.35 * s, 1.35 * s);
  for (let i = 0; i < 3; i++) {
    const on = Math.floor(t * 3) % 3 === i;
    x.beginPath();
    x.arc(-10 + i * 10, 3, on ? 3.6 : 2.6, 0, Math.PI * 2);
    x.fillStyle = on ? bodyHex : "#b9b9b9";
    x.fill();
  }
  x.restore();
}

function drawSearching(x: CanvasRenderingContext2D, R: number, cx: number, cy: number, t: number, hs: HandStyle) {
  const s = R / R_OTHER;
  const sn = Math.sin(t * 1.6), gx = cx + sn * R * 0.75, gy = cy + R * 0.05, lr = R * 0.36;
  x.save();
  x.strokeStyle = "#6b4a2e";
  x.lineWidth = 6 * s;
  x.lineCap = "round";
  x.beginPath();
  x.moveTo(gx + lr * 0.7, gy + lr * 0.7);
  x.lineTo(gx + lr * 1.5, gy + lr * 1.5);
  x.stroke();
  x.fillStyle = "rgba(180,220,255,0.28)";
  x.beginPath();
  x.arc(gx, gy, lr, 0, Math.PI * 2);
  x.fill();
  x.strokeStyle = "#cfd6df";
  x.lineWidth = 4 * s;
  x.stroke();
  const gl = (t * 0.6) % 1;
  if (gl < 0.18) {
    x.strokeStyle = `rgba(255,255,255,${1 - gl / 0.18})`;
    x.lineWidth = 2.5 * s;
    x.beginPath();
    x.arc(gx, gy, lr * 0.65, -2.4, -1.5);
    x.stroke();
  }
  x.restore();
  hand(x, gx + lr * 1.5, gy + lr * 1.5, R * 0.17, hs, s);
}

function drawReading(x: CanvasRenderingContext2D, R: number, cx: number, cy: number, t: number, hs: HandStyle) {
  const s = R / R_OTHER;
  const cyc = t % 4, flip = cyc > 3.6 ? Math.cos((cyc - 3.6) / 0.4 * Math.PI) : 1;
  const pw = R * 1.1, ph = R * 0.8, px = cx, py = cy + R * 0.55;
  x.save();
  x.translate(px, py);
  x.scale(Math.abs(flip) * 0.9 + 0.1, 1);
  x.fillStyle = "#f4f1ea";
  x.beginPath();
  x.roundRect(-pw / 2, -ph / 2, pw, ph, 4 * s);
  x.fill();
  x.fillStyle = "#b8b3a8";
  for (let i = 0; i < 5; i++) {
    x.fillRect(-pw / 2 + 7 * s, -ph / 2 + 8 * s + i * 8 * s, pw - 14 * s - (i === 4 ? 18 * s : 0), 2.5 * s);
  }
  x.restore();
  hand(x, px - pw / 2, py + 2 * s, R * 0.17, hs, s);
  hand(x, px + pw / 2, py + 2 * s, R * 0.17, hs, s);
}

function drawBash(x: CanvasRenderingContext2D, R: number, cx: number, cy: number, t: number) {
  const s = R / R_OTHER;
  const tw = R * 1.25, th = R * 0.95, tx = cx + R * 1.05, ty = cy - R * 0.55;
  x.save();
  x.fillStyle = "#0d1117";
  x.strokeStyle = "#3a3f48";
  x.lineWidth = 1.5 * s;
  x.beginPath();
  x.roundRect(tx, ty, tw, th, 5 * s);
  x.fill();
  x.stroke();
  x.fillStyle = "#2a2f38";
  x.fillRect(tx + s, ty + s, tw - 2 * s, 7 * s);
  ["#F4505E", "#F5A524", "#34D399"].forEach((c, i) => {
    x.fillStyle = c;
    x.beginPath();
    x.arc(tx + 6 * s + i * 6 * s, ty + 4.5 * s, 1.8 * s, 0, Math.PI * 2);
    x.fill();
  });
  x.beginPath();
  x.rect(tx + 2 * s, ty + 9 * s, tw - 4 * s, th - 11 * s);
  x.clip();
  const off = ((t * 14) % 7) * s;
  for (let i = 0; i < 8; i++) {
    const w = (10 + ((i * 37 + Math.floor(t * 2)) % 5) * 6) * s;
    x.fillStyle = i % 3 === 0 ? "#7BE495" : "#3fb56a";
    x.fillRect(tx + 5 * s, ty + th - 6 * s - i * 7 * s + off, Math.min(w, tw - 12 * s), 2.5 * s);
  }
  if (Math.floor(t * 2.5) % 2) {
    x.fillStyle = "#7BE495";
    x.fillRect(tx + 5 * s, ty + th - 8 * s, 4 * s, 5 * s);
  }
  x.restore();
}

function text(
  x: CanvasRenderingContext2D, str: string, px: number, py: number, size: number, color: string, rot = 0,
) {
  x.save();
  x.translate(px, py);
  x.rotate(rot);
  x.font = `800 ${size}px ${FONT}`;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillStyle = color;
  x.fillText(str, 0, 0);
  x.restore();
}

function drawApproval(x: CanvasRenderingContext2D, R: number, cx: number, cy: number, t: number, hs: HandStyle) {
  const s = R / R_OTHER;
  const wave = Math.sin(t * 9) * 0.35, ax = cx + R * 1.3, ay = cy - R * 0.2;
  const hx = ax + Math.sin(-0.5 + wave) * R * 0.75, hy = ay - Math.cos(-0.5 + wave) * R * 0.75;
  hand(x, hx, hy, R * 0.19, hs, s);
  const b = Math.abs(Math.sin(t * 5)) * 6 * s;
  const by = hy - R * 0.55 - b;
  x.beginPath();
  x.arc(hx, by, 11 * s, 0, Math.PI * 2);
  x.fillStyle = AMBER;
  x.fill();
  text(x, "!", hx, by + s, 15 * s, "#1c1c1c");
}

function drawQuestion(x: CanvasRenderingContext2D, R: number, cx: number, cy: number, t: number, hs: HandStyle) {
  const s = R / R_OTHER;
  const pop = Math.min(1, (t % 4) / 0.25), sc = pop < 1 ? pop * 1.2 : 1;
  if (sc > 0.01) text(x, "?", cx + R * 0.15, cy - R * 1.35, 34 * sc * s, CYAN, Math.sin(t * 3.5) * 0.25);
  hand(x, cx + R * 0.5, cy + R * 0.66 - Math.abs(Math.sin(t * 6)) * 4 * s, R * 0.17, hs, s);
}

/** One-shot: `k` is seconds since the error state was entered. */
function drawError(x: CanvasRenderingContext2D, R: number, cx: number, cy: number, k: number) {
  if (k <= 0.35 || k >= ERROR_END) return;
  const s = R / R_OTHER;
  const a = Math.min(1, (k - 0.35) / 0.3) * Math.min(1, (ERROR_END - k) / 0.4);
  x.save();
  x.globalAlpha = a;
  cloud(x, cx, cy - R * 1.45, 1.25 * s, "#5b6170");
  x.fillStyle = CYAN;
  for (let i = 0; i < 4; i++) {
    const dk = (k * 1.6 + i * 0.25) % 1;
    x.fillRect(cx - 12 * s + i * 8 * s, cy - R * 1.2 + dk * R * 0.5, 2 * s, 6 * s);
  }
  x.restore();
}

function drawRatelimit(x: CanvasRenderingContext2D, R: number, cx: number, cy: number, t: number) {
  const s = R / R_OTHER;
  const k = (t % 3) / 3;
  if (k < 0.6) {
    x.save();
    x.globalAlpha = 0.5 * (1 - k / 0.6);
    x.fillStyle = "#cfd6df";
    x.beginPath();
    x.arc(cx - R * 0.6 - k * 25 * s, cy + R * 0.25 - k * 10 * s, (4 + k * 8) * s, 0, Math.PI * 2);
    x.fill();
    x.restore();
  }
  const lvl = 1 - ((t % 5) / 5), bx = cx + R * 0.75, by = cy - R * 1.3;
  x.save();
  x.strokeStyle = "#cfd6df";
  x.lineWidth = 2 * s;
  x.strokeRect(bx, by, 30 * s, 14 * s);
  x.fillStyle = "#cfd6df";
  x.fillRect(bx + 30 * s, by + 4 * s, 3 * s, 6 * s);
  x.fillStyle = lvl > 0.5 ? "#34D399" : lvl > 0.2 ? AMBER : "#F4505E";
  x.fillRect(bx + 2 * s, by + 2 * s, 26 * s * lvl, 10 * s);
  x.restore();
}

/** Draws one overlay in world coordinates, after the body and particles.
 *  `k` = seconds since the state was entered (only the error one-shot uses it). */
export function drawOverlay(
  x: CanvasRenderingContext2D, kind: OverlayKind, R: number, cx: number, cy: number, t: number,
  body: RGB | null, k = 0,
) {
  const hs = handStyle(body);
  x.save();
  switch (kind) {
    case "typing": drawTyping(x, R, cx, cy, t, hs); break;
    case "thinking": drawThinking(x, R, cx, cy, t, hs, body ? css(body, 0, 1) : BODY); break;
    case "searching": drawSearching(x, R, cx, cy, t, hs); break;
    case "reading": drawReading(x, R, cx, cy, t, hs); break;
    case "bash": drawBash(x, R, cx, cy, t); break;
    case "approval": drawApproval(x, R, cx, cy, t, hs); break;
    case "question": drawQuestion(x, R, cx, cy, t, hs); break;
    case "error": drawError(x, R, cx, cy, k); break;
    case "ratelimit": drawRatelimit(x, R, cx, cy, t); break;
  }
  x.restore();
}
