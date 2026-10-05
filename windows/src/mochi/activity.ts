// Work props for big Mochi while a session works: thought bubble (thinking),
// laptop (typing), magnifier (searching). Flat 2D to match the flat bodies: solid
// fills, no shine. Drawn inside the body transform so they squash and tilt with Mochi.
// Looping details use `nowMs` directly; that is fine for an idle detail.

export type ActivityKind = "thinking" | "typing" | "searching";

const PAPER = "#F5F6F8";
const PAPER_EDGE = "#D9DCE2";
const DOT = "#7A808C";
const LID = "#2B2E35";
const BASE = "#3A3E46";
const SCREEN = "#9EC5FF";
const CODE = "#D7E8FF";
const GLASS = "rgba(158,197,255,0.35)";

/** `s` is the presence scale (0.85…1); (rx, ry) are the head radii. All sizes scale with R. */
export function drawActivity(
  x: CanvasRenderingContext2D, kind: ActivityKind, R: number,
  _rx: number, ry: number, s: number, nowMs: number,
) {
  const t = nowMs / 1000;
  switch (kind) {
    case "thinking": drawBubble(x, R, ry, s, t); break;
    case "typing": drawLaptop(x, R, s, t); break;
    case "searching": drawMagnifier(x, R, s, t); break;
  }
}

function drawBubble(x: CanvasRenderingContext2D, R: number, ry: number, s: number, t: number) {
  // Anchor on the head's upper right; trail circles rise up and to the right.
  x.save();
  x.translate(0.55 * R, -ry * 0.92);
  x.scale(s, s);
  const trail: [number, number, number][] = [
    [0.04, -0.06, 0.07], [0.2, -0.24, 0.1], [0.38, -0.46, 0.14],
  ];
  const cloudX = 0.5 * R;
  const cloudY = -0.98 * R;
  const circles: [number, number, number][] = [
    [-0.27, 0.05, 0.2], [0, -0.06, 0.25], [0.27, 0.05, 0.2],
  ];

  // Outline pass first (fat stroke), fill pass on top: one clean silhouette.
  for (const pass of [0, 1]) {
    x.beginPath();
    for (const [dx, dy, r] of trail) {
      x.moveTo(dx * R + r * R, dy * R);
      x.arc(dx * R, dy * R, r * R, 0, Math.PI * 2);
    }
    for (const [dx, dy, r] of circles) {
      x.moveTo(cloudX + (dx + r) * R, cloudY + dy * R);
      x.arc(cloudX + dx * R, cloudY + dy * R, r * R, 0, Math.PI * 2);
    }
    x.roundRect(cloudX - 0.27 * R, cloudY + 0.0 * R, 0.54 * R, 0.25 * R, 0.1 * R);
    if (pass === 0) {
      x.lineWidth = 0.06 * R;
      x.lineJoin = "round";
      x.strokeStyle = PAPER_EDGE;
      x.stroke();
    } else {
      x.fillStyle = PAPER;
      x.fill();
    }
  }

  // Three dots pulse in sequence, 1.2 s cycle.
  x.fillStyle = DOT;
  for (let i = 0; i < 3; i++) {
    const a = 0.5 + 0.5 * Math.cos(2 * Math.PI * (t / 1.2 - i / 3));
    const prev = x.globalAlpha;
    x.globalAlpha = prev * (0.25 + 0.75 * a);
    x.beginPath();
    x.arc(cloudX + (i - 1) * 0.19 * R, cloudY + 0.07 * R, 0.055 * R, 0, Math.PI * 2);
    x.fill();
    x.globalAlpha = prev;
  }
  x.restore();
}

function drawLaptop(x: CanvasRenderingContext2D, R: number, s: number, t: number) {
  // Typing bob: ±0.02R at ~8 Hz.
  const bob = Math.sin(t * Math.PI * 2 * 8) * 0.02 * R;
  x.save();
  x.translate(0, 0.66 * R + bob);
  x.scale(s, s);

  // Lid (dark bezel), a slim trapezoid leaning back; base in front of it.
  const lw = 0.5 * R; // half-width at the hinge
  const lt = 0.44 * R; // half-width at the top
  const top = -0.5 * R;
  const hinge = -0.02 * R;
  x.fillStyle = LID;
  x.beginPath();
  x.moveTo(-lw, hinge);
  x.lineTo(-lt, top);
  x.lineTo(lt, top);
  x.lineTo(lw, hinge);
  x.closePath();
  x.fill();

  // Screen with flickering "code" lines, clipped to the inset.
  const inset = 0.07 * R;
  const sTop = top + inset;
  const sBot = hinge - inset * 0.8;
  const sl = lt - inset;
  const sr = lw - inset * 1.2;
  x.fillStyle = SCREEN;
  x.beginPath();
  x.moveTo(-(sr), sBot);
  x.lineTo(-sl, sTop);
  x.lineTo(sl, sTop);
  x.lineTo(sr, sBot);
  x.closePath();
  x.fill();
  x.save();
  x.clip();
  x.fillStyle = CODE;
  const lineH = 0.055 * R;
  const tick = Math.floor(t * 5);
  const scroll = ((t * 0.5) % 1) * 0.16 * R; // lines drift upward and wrap
  for (let i = -1; i < 4; i++) {
    const y = sTop + (i * 0.16) * R + 0.1 * R - scroll + 0.16 * R;
    const hsh = Math.abs(Math.sin((tick + i + Math.floor(t * 0.5)) * 12.9898) * 43758.5453) % 1;
    const w = (0.25 + 0.6 * hsh) * (sr + sl);
    x.fillRect(-sl + 0.02 * R, y, w, lineH);
  }
  x.restore();

  // Base: wider flat slab in front of the hinge.
  x.fillStyle = BASE;
  x.beginPath();
  x.moveTo(-0.66 * R, 0.14 * R);
  x.lineTo(-0.56 * R, hinge);
  x.lineTo(0.56 * R, hinge);
  x.lineTo(0.66 * R, 0.14 * R);
  x.closePath();
  x.fill();
  // Tiny key tap marks, alternate sides with the bob.
  x.fillStyle = LID;
  const left = Math.sin(t * Math.PI * 2 * 8) > 0;
  x.fillRect((left ? -0.28 : 0.14) * R, 0.03 * R, 0.14 * R, 0.04 * R);
  x.restore();
}

function drawMagnifier(x: CanvasRenderingContext2D, R: number, s: number, t: number) {
  const sweep = Math.sin((t / 1.6) * Math.PI * 2) * 0.15 * R;
  const cx = 1.05 * R + sweep;
  const cy = -0.15 * R;
  const r = 0.3 * R;
  x.save();
  x.translate(cx, cy);
  x.scale(s, s);
  // Handle first so the lens covers its root.
  x.lineCap = "round";
  x.strokeStyle = LID;
  x.lineWidth = 0.11 * R;
  x.beginPath();
  x.moveTo(0.5 * r, 0.87 * r);
  x.lineTo(0.5 * 0.55 * R, 0.87 * 0.55 * R);
  x.stroke();
  x.fillStyle = GLASS;
  x.beginPath();
  x.arc(0, 0, r, 0, Math.PI * 2);
  x.fill();
  x.lineWidth = 0.07 * R;
  x.beginPath();
  x.arc(0, 0, r, 0, Math.PI * 2);
  x.stroke();
  // Small glint, flat.
  x.strokeStyle = "rgba(255,255,255,0.7)";
  x.lineWidth = 0.04 * R;
  x.beginPath();
  x.arc(0, 0, r * 0.62, Math.PI * 1.1, Math.PI * 1.45);
  x.stroke();
  x.restore();
}
