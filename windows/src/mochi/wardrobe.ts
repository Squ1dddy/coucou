// Mochi's outfits, drawn on the 3D head model. Port of the outfit section of
// NotchBuddy/Sources/CoucouKit/MochiOutfitDrawing.swift (pompom to bow).
//
// Same shapes, colours and layering as the Mac app: every outfit has a front pass
// and some a behind pass, drawn before and after the body by the engine. The
// engine owns the alpha (presence and morph fade); this file owns the shape and
// the presence transform (a hat drops in and scales up, glasses slide up, ...).

import { Ease } from "../core/anim";
import {
  frontSilhouetteArc, mCapClip, mFrontArc, mFrontArcRoll, mInvert, mEyeFrames, mProj, mProjRoll, mRingR, mSurf,
  makeH, mochiOutfitPath, type MochiH, type P3,
} from "./outfit3d";
import type { OutfitName } from "./outfits";

export interface OutfitOpts {
  mini: boolean;
  /** 0..1 presence (the engine's accPresence). */
  presence: number;
  /** Turns of the current roll animation (1 finished, 2 dizzy). */
  rollTurns: number;
}

type Ctx = CanvasRenderingContext2D;
type Stop = [number, string];

// ── Small canvas helpers ──────────────────────────────────────────────────────

function lin(x: Ctx, x0: number, y0: number, x1: number, y1: number, stops: Stop[]) {
  const g = x.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

function rad(x: Ctx, cx: number, cy: number, r: number, stops: Stop[]) {
  const g = x.createRadialGradient(cx, cy, 0, cx, cy, Math.max(0.0001, r));
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

function line(pts: { x: number; y: number }[]): Path2D {
  const p = new Path2D();
  pts.forEach((q, i) => (i === 0 ? p.moveTo(q.x, q.y) : p.lineTo(q.x, q.y)));
  return p;
}

function stroke(x: Ctx, p: Path2D, color: string, w: number, cap: CanvasLineCap = "round") {
  x.strokeStyle = color;
  x.lineWidth = w;
  x.lineCap = cap;
  x.lineJoin = "round";
  x.stroke(p);
}

function ellipse(cx: number, cy: number, rx: number, ry: number): Path2D {
  const p = new Path2D();
  p.ellipse(cx, cy, Math.max(0, rx), Math.max(0, ry), 0, 0, Math.PI * 2);
  return p;
}

function bigRect(H: MochiH): Path2D {
  const p = new Path2D();
  p.rect(-H.rx * 4, -H.ry * 4, H.rx * 8, H.ry * 8);
  return p;
}

function rrectPath(X: number, Y: number, W: number, Hh: number, r: number): Path2D {
  const p = new Path2D();
  p.roundRect(X, Y, W, Hh, Math.max(0, Math.min(r, W / 2, Hh / 2)));
  return p;
}

// ── Pompom and fuzzy band ─────────────────────────────────────────────────────

function drawPompom(
  x: Ctx, px: number, py: number, r: number,
  base = "#FFFFFF", shade = "rgb(213,217,226)",
) {
  x.save();
  x.translate(px, py);
  const n = 11;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const br = r * (0.34 + 0.06 * Math.sin(i * 2.3));
    const bx = Math.cos(a) * r * 0.78;
    const by = Math.sin(a) * r * 0.78;
    x.fillStyle = rad(x, bx - br * 0.4, by - br * 0.5, br * 1.3, [[0, base], [1, shade]]);
    x.fill(ellipse(bx, by, br, br));
  }
  x.fillStyle = rad(x, -r * 0.3, -r * 0.35, r * 1.05, [[0, base], [0.7, base], [1, shade]]);
  x.fill(ellipse(0, 0, r * 0.86, r * 0.86));
  x.restore();
}

function drawFuzzyBand(
  x: Ctx, arc: P3[], thick: number, base = "#FFFFFF", shade = "rgb(218,221,228)",
) {
  if (arc.length < 2) return;
  const p = line(arc);
  stroke(x, p, shade, thick);
  stroke(x, p, base, thick * 0.78);
  const step = Math.max(2, Math.floor(arc.length / 16));
  for (let i = 0; i < arc.length; i += step) {
    const q = arc[i];
    const r = thick * (0.32 + 0.1 * Math.sin(i * 1.7));
    x.fillStyle = rad(x, q.x - r * 0.3, q.y - thick * 0.35 - r * 0.3, r * 1.2, [[0, base], [1, shade]]);
    x.fill(ellipse(q.x, q.y - thick * 0.32, r, r));
  }
}

// ── Bunny ears (behind the body) ──────────────────────────────────────────────

function drawBunnyEarsBack(x: Ctx, H: MochiH, rollProgress: number) {
  const R = H.R;
  const earH = R * 0.85;
  for (const sd of [-1, 1]) {
    const earRoot = mProj(H, [sd * 0.45, 0.92, 0]);
    const earRootL = mProj(H, [sd * 0.45 - 0.22, 0.92, 0]);
    const earRootR = mProj(H, [sd * 0.45 + 0.22, 0.92, 0]);
    const visHW = Math.max(R * 0.04, Math.abs(earRootR.x - earRootL.x) / 2);

    const flatten = Math.sin(rollProgress * Math.PI);
    const effEarH = earH * (1 - 0.8 * flatten);
    const tiltAngle = sd * 0.6 * flatten;

    const earCX = earRoot.x;
    const earCY = earRoot.y - effEarH * 0.65 + effEarH * 0.5;

    x.save();
    x.translate(earCX, earCY);
    x.rotate(tiltAngle);
    const outer = ellipse(0, 0, visHW, effEarH / 2);
    x.fillStyle = "#F9F0F0";
    x.fill(outer);
    x.strokeStyle = "rgba(0,0,0,0.06)";
    x.lineWidth = 0.8;
    x.stroke(outer);
    x.fillStyle = "rgba(252,165,165,0.7)";
    x.fill(ellipse(0, -effEarH / 2 + R * 0.1 + effEarH * 0.325, visHW * 0.5, effEarH * 0.325));
    x.restore();
  }
}

// ── Beanie ────────────────────────────────────────────────────────────────────

function drawBeanieFront(x: Ctx, H: MochiH, body: Path2D, simplified: boolean) {
  const s = 1.035, yEdge = 0.42, yCuff = 0.58;
  const head = mochiOutfitPath(H.rx * s, H.ry * s);

  // shadow on the head under the cuff
  x.save();
  x.clip(body);
  x.clip(mCapClip(H, yEdge - 0.12, 1));
  x.fillStyle = "rgba(30,40,70,0.10)";
  x.fill(bigRect(H));
  x.restore();

  // knit body
  x.save();
  x.clip(mCapClip(H, yCuff, s));
  x.fillStyle = lin(x, H.rx * 0.5, -H.ry * 1.1, -H.rx * 0.6, H.ry * 0.2,
    [[0, "#7DB6FF"], [1, "#2F6FE0"]]);
  x.fill(head);
  if (!simplified) {
    x.save();
    x.clip(head);
    for (let k = -6; k <= 6; k++) {
      const lon = k * 0.24;
      const pts: P3[] = [];
      for (let i = 0; i <= 16; i++) {
        const y = yCuff + ((1.05 - yCuff) * i) / 16;
        const q = mProj(H, mSurf(y, lon, s));
        if (q.z > 0) pts.push(q);
      }
      if (pts.length < 2) continue;
      stroke(x, line(pts), "rgba(20,50,140,0.16)", H.R * 0.045);
    }
    x.restore();
  }
  x.restore();

  // cuff (folded band)
  x.save();
  x.clip(mCapClip(H, yEdge, s * 1.04));
  x.clip(mInvert(mCapClip(H, yCuff, s * 1.04), H), "evenodd");
  const cuffHead = mochiOutfitPath(H.rx * s * 1.04, H.ry * s * 1.04);
  x.fillStyle = lin(x, 0, -H.ry * 0.6, 0, -H.ry * 0.2, [[0, "#3C7BEA"], [1, "#2257C4"]]);
  x.fill(cuffHead);
  x.clip(cuffHead);
  for (let k = -14; k <= 14; k++) {
    const lon = k * 0.115;
    const a = mProj(H, mSurf(yEdge, lon, s * 1.04));
    const b = mProj(H, mSurf(yCuff, lon, s * 1.04));
    if (a.z < 0) continue;
    stroke(x, line([a, b]), "rgba(10,30,100,0.22)", H.R * 0.035, "butt");
  }
  x.restore();

  // top highlight
  x.save();
  x.clip(mCapClip(H, yCuff, s));
  x.clip(head);
  x.fillStyle = rad(x, H.rx * 0.3, -H.ry * 0.85, H.R * 0.45,
    [[0, "rgba(255,255,255,0.35)"], [1, "rgba(255,255,255,0)"]]);
  x.fill(head);
  x.restore();

  // pompom on a short spring
  const top = mProj(H, [0, 1.08 * s, 0]);
  drawPompom(x, top.x + H.physDx * H.rx * 0.25, top.y - H.R * 0.12 + H.physDy * H.ry * 0.15, H.R * 0.24);
}

// ── Santa hat ─────────────────────────────────────────────────────────────────

function drawSantaHatFront(x: Ctx, H: MochiH, body: Path2D) {
  const s = 1.05, yEdge = 0.52;
  const arc = mFrontArc(H, yEdge, s);
  if (!arc.length) return;
  const L = arc[0];
  const Rt = arc[arc.length - 1];
  const crown = mProj(H, [0, 1.05, 0]);
  const side = 1;
  const tip = {
    x: crown.x + side * H.rx * (0.95 + H.physDx * 0.35),
    y: crown.y + H.ry * (0.05 + H.physDy * 0.2),
  };
  const peak = { x: crown.x + side * H.rx * 0.25, y: crown.y - H.ry * 0.62 };

  const bag = new Path2D();
  bag.moveTo(L.x, L.y);
  bag.bezierCurveTo(L.x - H.rx * 0.05, L.y - H.ry * 0.7, peak.x - H.rx * 0.55, peak.y - H.ry * 0.05, peak.x, peak.y);
  bag.quadraticCurveTo(tip.x - H.rx * 0.05, peak.y - H.ry * 0.02, tip.x, tip.y);
  bag.quadraticCurveTo(tip.x - H.rx * 0.12, tip.y - H.ry * 0.22, peak.x + H.rx * 0.18, peak.y + H.ry * 0.32);
  bag.bezierCurveTo(Rt.x + H.rx * 0.05, peak.y + H.ry * 0.45, Rt.x + H.rx * 0.08, Rt.y - H.ry * 0.35, Rt.x, Rt.y);
  for (let i = arc.length - 1; i >= 0; i--) bag.lineTo(arc[i].x, arc[i].y);
  bag.closePath();

  // shadow on the head
  x.save();
  x.clip(body);
  x.clip(mCapClip(H, yEdge - 0.14, 1));
  x.fillStyle = "rgba(120,10,10,0.10)";
  x.fill(bigRect(H));
  x.restore();

  x.fillStyle = lin(x, -H.rx * 0.6, -H.ry * 1.6, H.rx * 0.7, -H.ry * 0.3,
    [[0, "#FF6B6B"], [0.55, "#E53935"], [1, "#B71C1C"]]);
  x.fill(bag);

  // folds
  x.save();
  x.clip(bag);
  const folds: [number, number, number][] = [[0.15, 0.55, 0.10], [0.45, 0.85, 0.08]];
  for (const [a, b, w] of folds) {
    const fold = new Path2D();
    fold.moveTo(peak.x - H.rx * 0.1 + (Rt.x - L.x) * a * 0.3, peak.y + H.ry * 0.15);
    fold.quadraticCurveTo(
      peak.x + H.rx * 0.35, peak.y + H.ry * (0.05 + a * 0.3),
      tip.x - H.rx * (0.45 - b * 0.3), tip.y - H.ry * 0.12,
    );
    stroke(x, fold, "rgba(90,0,0,0.20)", H.R * w);
  }
  x.fillStyle = rad(x, peak.x - H.rx * 0.25, peak.y + H.ry * 0.05, H.R * 0.5,
    [[0, "rgba(255,255,255,0.32)"], [1, "rgba(255,255,255,0)"]]);
  x.fill(bag);
  x.restore();

  drawFuzzyBand(x, arc, H.R * 0.3);
  drawPompom(x, tip.x, tip.y + H.R * 0.04, H.R * 0.22);
}

// ── Party hat ─────────────────────────────────────────────────────────────────

function drawPartyHatFront(x: Ctx, H: MochiH, simplified: boolean) {
  const baseY = 0.82, baseR = 0.42;
  const lean = -0.24 + H.physDx * 0.12;
  const c = mProj(H, [0.16, baseY + 0.06, 0]);
  const ring: P3[] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    ring.push(mProj(H, [0.16 + baseR * Math.sin(a), baseY + 0.06, baseR * Math.cos(a)]));
  }
  let left = ring[0], right = ring[0];
  for (const q of ring) {
    if (q.x < left.x) left = q;
    if (q.x > right.x) right = q;
  }
  const h = H.ry * 1.6;
  const apex = { x: c.x + Math.sin(lean) * h, y: c.y - Math.cos(lean) * h };
  const front = frontSilhouetteArc(ring);

  const cone = new Path2D();
  cone.moveTo(left.x, left.y);
  cone.quadraticCurveTo((left.x + apex.x) / 2 - H.rx * 0.06, (left.y + apex.y) / 2, apex.x - H.R * 0.05, apex.y + H.R * 0.06);
  cone.quadraticCurveTo(apex.x, apex.y - H.R * 0.03, apex.x + H.R * 0.05, apex.y + H.R * 0.06);
  cone.quadraticCurveTo((right.x + apex.x) / 2 + H.rx * 0.06, (right.y + apex.y) / 2, right.x, right.y);
  for (let i = front.length - 1; i >= 0; i--) cone.lineTo(front[i].x, front[i].y);
  cone.closePath();

  x.fillStyle = lin(x, left.x, apex.y, right.x, left.y,
    [[0, "#FF9BD0"], [0.5, "#F15BAE"], [1, "#C2187A"]]);
  x.fill(cone);

  x.save();
  x.clip(cone);
  if (!simplified) {
    const dots: [number, number][] = [
      [0.25, -0.35], [0.3, 0.3], [0.55, -0.05], [0.72, 0.28],
      [0.8, -0.3], [0.45, 0.6], [0.48, -0.65],
    ];
    x.fillStyle = "rgba(255,255,255,0.92)";
    for (const [t, u] of dots) {
      const bx = left.x + (right.x - left.x) * (0.5 + u * 0.5);
      const by = left.y + (right.y - left.y) * (0.5 + u * 0.5);
      const px = bx + (apex.x - bx) * (1 - t);
      const py = by + (apex.y - by) * (1 - t);
      const r = H.R * 0.075 * (0.6 + t * 0.5);
      x.fill(ellipse(px, py, r, r * 0.9));
    }
  }
  x.fillStyle = lin(x, left.x, 0, right.x, 0,
    [[0, "rgba(255,255,255,0.28)"], [0.35, "rgba(255,255,255,0)"], [1, "rgba(80,0,40,0.18)"]]);
  x.fill(cone);
  x.restore();

  if (front.length) stroke(x, line(front), "#FFD84D", H.R * 0.07);
  drawPompom(x, apex.x, apex.y - H.R * 0.04, H.R * 0.16, "#FFE27A", "#F2B705");
}

// ── Crown ─────────────────────────────────────────────────────────────────────

const CROWN_YB = 0.46;

function drawCrownPart(x: Ctx, H: MochiH, side: number, simplified: boolean) {
  const s = 1.06, yb = 0.46, yt = 0.66;
  const n = 8, spikeH = 0.42;
  const N = 120;
  interface Seg { b: P3; tt: P3; z: number }
  const seg: Seg[] = [];
  for (let i = 0; i <= N; i++) {
    const lon = -Math.PI + (i / N) * 2 * Math.PI;
    const b = mProj(H, mSurf(yb, lon, s));
    const phase = ((lon + Math.PI) / (2 * Math.PI)) * n;
    const f = phase - Math.floor(phase);
    const spike = Math.pow(Math.max(0, 1 - Math.abs(f - 0.5) * 2), 1.6);
    const topY = yt + spikeH * spike;
    const sp = mSurf(yt, lon, s);
    const tt = mProj(H, [sp[0] * (1 - 0.08 * spike), topY, sp[2] * (1 - 0.08 * spike)]);
    seg.push({ b, tt, z: b.z });
  }
  const keep = seg.filter((q) => (side > 0 ? q.z >= 0 : q.z < 0.02));
  if (keep.length < 2) return;
  keep.sort((a, b) => a.b.x - b.b.x);

  const shape = new Path2D();
  shape.moveTo(keep[0].tt.x, keep[0].tt.y);
  for (let i = 1; i < keep.length; i++) shape.lineTo(keep[i].tt.x, keep[i].tt.y);
  for (let i = keep.length - 1; i >= 0; i--) shape.lineTo(keep[i].b.x, keep[i].b.y);
  shape.closePath();

  const dark = side < 0;
  x.fillStyle = dark
    ? lin(x, 0, -H.ry * 1.05, 0, -H.ry * 0.45, [[0, "#C98A12"], [1, "#8A5A06"]])
    : lin(x, 0, -H.ry * 1.05, 0, -H.ry * 0.45, [[0, "#FFE58A"], [0.5, "#FBBF24"], [1, "#D08A0B"]]);
  x.fill(shape);

  if (dark) return;

  x.save();
  x.clip(shape);
  x.fillStyle = lin(x, -H.rx, 0, H.rx, 0, [
    [0, "rgba(120,70,0,0.25)"], [0.45, "rgba(255,255,255,0)"],
    [0.62, "rgba(255,255,255,0.35)"], [1, "rgba(120,70,0,0.25)"],
  ]);
  x.fill(shape);
  x.restore();

  if (simplified) return;
  const gems = ["#EF4444", "#3B82F6", "#22C55E", "#A855F7"];
  for (let k = 0; k < n; k++) {
    const lon = -Math.PI + ((k + 0.5) / n) * 2 * Math.PI;
    const sp = mSurf(yt, lon, s);
    const tipP = mProj(H, [sp[0] * 0.92, yt + spikeH, sp[2] * 0.92]);
    const mid = mProj(H, mSurf((yb + yt) / 2, lon, s * 1.01));
    if (mid.z <= 0.12) continue;
    const r = H.R * 0.055;
    x.fillStyle = rad(x, tipP.x - r * 0.3, tipP.y - r, r * 1.2, [[0, "#FFF6CC"], [1, "#E0A21A"]]);
    x.fill(ellipse(tipP.x, tipP.y - r * 0.5, r, r));
    const gr = H.R * 0.075;
    x.fillStyle = gems[k % gems.length];
    x.fill(ellipse(mid.x, mid.y, gr * Math.max(0.35, mid.z), gr));
    x.fillStyle = "rgba(255,255,255,0.75)";
    x.fill(ellipse(mid.x - gr * 0.25 * mid.z, mid.y - gr * 0.35, gr * 0.28, gr * 0.28));
  }
}

function drawCrownFront(x: Ctx, H: MochiH, body: Path2D, simplified: boolean) {
  x.save();
  x.clip(body);
  x.clip(mCapClip(H, CROWN_YB - 0.1, 1));
  x.clip(mInvert(mCapClip(H, CROWN_YB, 1), H), "evenodd");
  x.fillStyle = "rgba(80,50,0,0.12)";
  x.fill(bigRect(H));
  x.restore();
  drawCrownPart(x, H, 1, simplified);
}

// ── Witch hat ─────────────────────────────────────────────────────────────────

function witchBrimPts(H: MochiH): P3[] {
  const y = 0.7, rr = 1.42;
  const out: P3[] = [];
  for (let i = 0; i <= 120; i++) {
    const a = -Math.PI + (i / 120) * 2 * Math.PI;
    const wob = 1 + 0.035 * Math.sin(a * 3 + 0.6);
    const droop = -0.1 * Math.pow(Math.abs(Math.sin(a)), 2);
    out.push(mProj(H, [rr * wob * Math.sin(a), y + droop, rr * wob * Math.cos(a)]));
  }
  return out;
}

function drawWitchHatBack(x: Ctx, H: MochiH) {
  const pts = witchBrimPts(H);
  if (!pts.some((q) => q.z < 0.05)) return;
  const ell = line(pts);
  ell.closePath();
  x.fillStyle = lin(x, 0, -H.ry, 0, -H.ry * 0.4, [[0, "#2A0A4F"], [1, "#3B0F6B"]]);
  x.fill(ell);
}

function drawWitchHatFront(x: Ctx, H: MochiH, body: Path2D) {
  const all = witchBrimPts(H);
  const brim = line(all);
  brim.closePath();
  const fr = all.filter((q) => q.z >= 0).sort((a, b) => a.x - b.x);

  x.save();
  x.clip(body);
  x.clip(mCapClip(H, 0.5, 1));
  x.fillStyle = "rgba(40,0,70,0.10)";
  x.fill(bigRect(H));
  x.restore();

  x.fillStyle = lin(x, 0, -H.ry * 0.9, 0, -H.ry * 0.3, [[0, "#5B21B6"], [1, "#3B0764"]]);
  x.fill(brim);
  if (fr.length) stroke(x, line(fr), "rgba(190,150,255,0.35)", H.R * 0.035);

  // cone
  const baseR = 0.62, by = 0.74;
  const bl = mProj(H, [-baseR, by, 0]);
  const br = mProj(H, [baseR, by, 0]);
  const c = mProj(H, [0, by, 0]);
  const lean = 0.1 + H.physDx * 0.15;
  const top = { x: c.x + H.rx * 0.18 + Math.sin(lean) * H.ry * 0.3, y: c.y - H.ry * 1.25 };
  const tip = { x: top.x + H.rx * (0.45 + H.physDx * 0.25), y: top.y + H.ry * (0.22 + H.physDy * 0.1) };
  const capFront = mFrontArc(H, by, baseR / mRingR(by)).filter((q) => q.x >= bl.x - 1 && q.x <= br.x + 1);

  const cone = new Path2D();
  cone.moveTo(bl.x, bl.y);
  cone.bezierCurveTo(bl.x + H.rx * 0.12, bl.y - H.ry * 0.5, top.x - H.rx * 0.28, top.y + H.ry * 0.25,
    top.x - H.rx * 0.02, top.y - H.ry * 0.02);
  cone.quadraticCurveTo(top.x + H.rx * 0.25, top.y - H.ry * 0.08, tip.x, tip.y);
  cone.quadraticCurveTo(top.x + H.rx * 0.22, top.y + H.ry * 0.08, top.x + H.rx * 0.14, top.y + H.ry * 0.22);
  cone.bezierCurveTo(br.x - H.rx * 0.18, c.y - H.ry * 0.45, br.x - H.rx * 0.02, br.y - H.ry * 0.2, br.x, br.y);
  for (let i = capFront.length - 1; i >= 0; i--) cone.lineTo(capFront[i].x, capFront[i].y);
  cone.closePath();

  x.fillStyle = lin(x, bl.x, top.y, br.x, bl.y, [[0, "#7C3AED"], [0.55, "#4C1D95"], [1, "#2E1065"]]);
  x.fill(cone);

  x.save();
  x.clip(cone);
  x.fillStyle = lin(x, bl.x, 0, br.x, 0,
    [[0, "rgba(255,255,255,0.22)"], [0.4, "rgba(255,255,255,0)"], [1, "rgba(0,0,0,0.15)"]]);
  x.fill(cone);
  const crease = new Path2D();
  crease.moveTo(top.x - H.rx * 0.05, top.y + H.ry * 0.05);
  crease.quadraticCurveTo(top.x + H.rx * 0.1, top.y + H.ry * 0.12, top.x + H.rx * 0.2, top.y + H.ry * 0.06);
  stroke(x, crease, "rgba(20,0,40,0.35)", H.R * 0.05);

  // orange band
  const fc = mProj(H, [0, by, baseR]);
  const lift = H.ry * 0.11;
  const band = new Path2D();
  band.moveTo(bl.x - 2, bl.y - lift);
  band.quadraticCurveTo(fc.x, 2 * (fc.y - lift) - (bl.y + br.y) / 2, br.x + 2, br.y - lift);
  stroke(x, band, "#F97316", H.ry * 0.17, "butt");
  x.restore();

  // buckle
  const bk0 = mProj(H, [0, by, baseR]);
  const bkx = bk0.x, bky = bk0.y - H.ry * 0.11;
  const bw = H.R * 0.2, bh = H.R * 0.16;
  x.save();
  x.translate(bkx, bky);
  x.fillStyle = "#FCD34D";
  x.fill(rrectPath(-bw / 2, -bh / 2, bw, bh, bh * 0.25));
  x.fillStyle = "#C2410C";
  x.fill(rrectPath(-bw / 2 + bw * 0.24, -bh / 2 + bh * 0.28, bw * 0.52, bh * 0.44, bh * 0.1));
  x.restore();
}

// ── Sunglasses ────────────────────────────────────────────────────────────────

function rollEyes(H: MochiH) {
  return mEyeFrames(makeH(H.R, H.yaw, H.pitch + H.roll, H.physDx, H.physDy));
}

function drawSunglassesFront(x: Ctx, H: MochiH, body: Path2D) {
  const eyes = rollEyes(H);
  const w = H.R * 0.62, h = H.R * 0.46;
  x.save();
  x.clip(body);

  const [le, re] = eyes;
  if (le.visible && re.visible) {
    const bridge = new Path2D();
    bridge.moveTo(le.x + (w / 2) * le.fx * 0.9, le.y - h * 0.18);
    bridge.quadraticCurveTo((le.x + re.x) / 2, (le.y + re.y) / 2 - h * 0.42,
      re.x - (w / 2) * re.fx * 0.9, re.y - h * 0.18);
    stroke(x, bridge, "#111317", H.R * 0.07);
  }
  for (const e of eyes) {
    if (!e.visible) continue;
    const ox = e.x + ((e.sd * w) / 2) * e.fx;
    const temple = new Path2D();
    temple.moveTo(ox, e.y - h * 0.2);
    temple.lineTo(e.sd * H.rx * 1.05, e.y - h * 0.35);
    stroke(x, temple, "#111317", H.R * 0.06);
  }
  for (const e of eyes) {
    if (!e.visible) continue;
    x.save();
    x.translate(e.x, e.y);
    x.scale(e.fx, e.fy);
    const lens = rrectPath(-w / 2, -h / 2, w, h, h * 0.42);
    x.fillStyle = "rgba(17,19,23,0.82)";
    x.fill(lens);
    stroke(x, lens, "#0B0C0F", H.R * 0.05, "butt");
    const glare = new Path2D();
    glare.moveTo(-w * 0.28, -h * 0.05);
    glare.lineTo(-w * 0.05, -h * 0.3);
    stroke(x, glare, "rgba(255,255,255,0.45)", H.R * 0.05);
    x.restore();
  }
  x.restore();
}

// ── Round glasses ─────────────────────────────────────────────────────────────

function drawRoundGlassesFront(x: Ctx, H: MochiH, body: Path2D) {
  const eyes = rollEyes(H);
  const d = H.R * 0.56;
  x.save();
  x.clip(body);

  const [le, re] = eyes;
  if (le.visible && re.visible) {
    const bridge = new Path2D();
    bridge.moveTo(le.x + (d / 2) * le.fx, le.y - d * 0.08);
    bridge.quadraticCurveTo((le.x + re.x) / 2, (le.y + re.y) / 2 - d * 0.3,
      re.x - (d / 2) * re.fx, re.y - d * 0.08);
    stroke(x, bridge, "#8A4B12", H.R * 0.055);
  }
  for (const e of eyes) {
    if (!e.visible) continue;
    const temple = new Path2D();
    temple.moveTo(e.x + ((e.sd * d) / 2) * e.fx, e.y - d * 0.1);
    temple.lineTo(e.sd * H.rx * 1.05, e.y - d * 0.25);
    stroke(x, temple, "#8A4B12", H.R * 0.05);
  }
  for (const e of eyes) {
    if (!e.visible) continue;
    x.save();
    x.translate(e.x, e.y);
    x.scale(e.fx, e.fy);
    const circle = ellipse(0, 0, d / 2, d / 2);
    x.fillStyle = "rgba(190,225,255,0.18)";
    x.fill(circle);
    stroke(x, circle, "#9A5A1A", H.R * 0.065);
    const arc = new Path2D();
    arc.arc(0, 0, d / 2 - H.R * 0.03, Math.PI * 1.1, Math.PI * 1.45, false);
    stroke(x, arc, "rgba(255,255,255,0.55)", H.R * 0.03);
    x.restore();
  }
  x.restore();
}

// ── Scarf ─────────────────────────────────────────────────────────────────────

function drawScarfFront(x: Ctx, H: MochiH) {
  const s = 1.05, y0 = -0.34, y1 = -0.66;
  const top = mFrontArcRoll(H, y0, s);
  const bot = mFrontArcRoll(H, y1, s);
  if (!top.length || !bot.length) return;

  const band = line(top);
  for (let i = bot.length - 1; i >= 0; i--) band.lineTo(bot[i].x, bot[i].y);
  band.closePath();

  x.save();
  x.clip(mochiOutfitPath(H.rx * s, H.ry * s));
  x.fillStyle = lin(x, 0, -H.ry * 0.2, 0, H.ry * 0.7, [[0, "#F87171"], [1, "#B91C1C"]]);
  x.fill(band);

  x.save();
  x.clip(band);
  for (const lon of [-1.0, -0.45, 0.1, 0.65, 1.2]) {
    const a = mProj(H, mSurf(y0, lon, s));
    const b = mProj(H, mSurf(y1, lon, s));
    if (a.z < 0) continue;
    stroke(x, line([{ x: a.x, y: a.y - 4 }, { x: b.x, y: b.y + 4 }]),
      "rgba(255,255,255,0.85)", H.R * 0.09 * Math.max(0.3, a.z));
  }
  x.restore();
  x.fillStyle = lin(x, 0, -H.ry * 0.5, 0, H.ry * 0.3,
    [[0, "rgba(255,255,255,0.18)"], [1, "rgba(0,0,0,0.10)"]]);
  x.fill(band);
  x.restore();

  // hanging end
  const k = mProj(H, mSurf((y0 + y1) / 2, -0.55, s * 1.03));
  if (k.z <= 0) return;
  const sw = H.physDx * H.rx * 0.12;
  const end = new Path2D();
  end.moveTo(k.x - H.R * 0.16, k.y);
  end.quadraticCurveTo(k.x - H.R * 0.24 + sw, k.y + H.ry * 0.35, k.x - H.R * 0.2 + sw * 1.4, k.y + H.ry * 0.62);
  end.lineTo(k.x + H.R * 0.06 + sw * 1.4, k.y + H.ry * 0.6);
  end.quadraticCurveTo(k.x + H.R * 0.02 + sw, k.y + H.ry * 0.3, k.x + H.R * 0.12, k.y);
  end.closePath();
  x.fillStyle = lin(x, 0, k.y, 0, k.y + H.ry * 0.6, [[0, "#EF4444"], [1, "#B91C1C"]]);
  x.fill(end);

  x.save();
  x.clip(end);
  x.fillStyle = "rgba(255,255,255,0.85)";
  for (const t of [0.35, 0.7]) {
    x.fillRect(k.x - H.R * 0.4 + sw, k.y + H.ry * 0.62 * t, H.R * 0.8, H.R * 0.07);
  }
  x.restore();

  for (let i = 0; i < 4; i++) {
    const fx = k.x - H.R * 0.17 + sw * 1.4 + i * H.R * 0.075;
    stroke(x, line([{ x: fx, y: k.y + H.ry * 0.6 }, { x: fx, y: k.y + H.ry * 0.72 }]), "#DC2626", H.R * 0.035);
  }

  // knot
  x.save();
  x.translate(k.x, k.y);
  x.rotate(0.2);
  x.fillStyle = rad(x, -H.R * 0.05, -H.R * 0.05, H.R * 0.2, [[0, "#F87171"], [1, "#B91C1C"]]);
  x.fill(ellipse(0, 0, H.R * 0.17, H.R * 0.14));
  x.restore();
}

// ── Pumpkin ───────────────────────────────────────────────────────────────────

function drawPumpkinFront(x: Ctx, H: MochiH, body: Path2D, simplified: boolean) {
  // Ribs only: the body recolour is done by the engine (drawBody).
  if (!simplified) {
    x.save();
    x.clip(body);
    for (const lon of [-1.15, -0.55, 0.0, 0.55, 1.15]) {
      const pts: P3[] = [];
      for (let i = 0; i <= 30; i++) {
        const y = -0.98 + (1.96 * i) / 30;
        const q = mProjRoll(H, mSurf(y, lon, 1));
        if (q.z > 0) pts.push(q);
      }
      if (pts.length < 2) continue;
      const zz = pts[Math.floor(pts.length / 2)].z;
      stroke(x, line(pts), `rgba(150,50,0,${0.22 * zz})`, H.R * 0.12);
      stroke(x, line(pts.map((q) => ({ x: q.x + H.R * 0.07, y: q.y }))),
        `rgba(255,220,170,${0.18 * zz})`, H.R * 0.04);
    }
    x.restore();
  }

  const t = mProjRoll(H, [0.02, 1.0, 0]);
  // stem
  const stem = new Path2D();
  stem.moveTo(t.x - H.R * 0.09, t.y + H.R * 0.04);
  stem.quadraticCurveTo(t.x - H.R * 0.08, t.y - H.R * 0.22, t.x + H.R * 0.08, t.y - H.R * 0.3);
  stem.lineTo(t.x + H.R * 0.13, t.y - H.R * 0.22);
  stem.quadraticCurveTo(t.x + H.R * 0.04, t.y - H.R * 0.15, t.x + H.R * 0.08, t.y + H.R * 0.04);
  stem.closePath();
  x.fillStyle = lin(x, t.x - H.R * 0.1, 0, t.x + H.R * 0.1, 0, [[0, "#65A30D"], [1, "#3F6212"]]);
  x.fill(stem);

  // leaf
  x.save();
  x.translate(t.x - H.R * 0.06, t.y - H.R * 0.02);
  x.rotate(-0.5);
  const leaf = new Path2D();
  leaf.moveTo(0, 0);
  leaf.quadraticCurveTo(-H.R * 0.18, -H.R * 0.2, -H.R * 0.38, -H.R * 0.02);
  leaf.quadraticCurveTo(-H.R * 0.18, H.R * 0.1, 0, 0);
  x.fillStyle = lin(x, 0, -H.R * 0.15, -H.R * 0.3, 0, [[0, "#84CC16"], [1, "#4D7C0F"]]);
  x.fill(leaf);
  const vein = new Path2D();
  vein.moveTo(-H.R * 0.02, -H.R * 0.01);
  vein.quadraticCurveTo(-H.R * 0.18, -H.R * 0.08, -H.R * 0.32, -H.R * 0.03);
  stroke(x, vein, "rgba(30,60,0,0.4)", H.R * 0.02);
  x.restore();

  if (!simplified) {
    const tendril = new Path2D();
    tendril.moveTo(t.x + H.R * 0.1, t.y - H.R * 0.12);
    tendril.bezierCurveTo(t.x + H.R * 0.3, t.y - H.R * 0.25, t.x + H.R * 0.35, t.y - H.R * 0.02,
      t.x + H.R * 0.22, t.y - H.R * 0.06);
    stroke(x, tendril, "#4D7C0F", H.R * 0.03);
  }
}

// ── Bow ───────────────────────────────────────────────────────────────────────

function drawBowFront(x: Ctx, H: MochiH) {
  const a = mProjRoll(H, mSurf(0.86, 0.55, 1.02));
  if (a.z < -0.2) return;
  const s = H.R * 0.26;
  const sq = Math.max(0.45, Math.cos(0.55 + H.yaw));

  x.save();
  x.translate(a.x, a.y);
  x.rotate(0.35 + H.yaw * 0.3);
  x.scale(sq, 1);

  for (const sd of [-1, 1]) {
    const wing = new Path2D();
    wing.moveTo(0, 0);
    wing.bezierCurveTo(sd * s * 0.6, -s * 0.85, sd * s * 1.35, -s * 0.55, sd * s * 1.15, 0);
    wing.bezierCurveTo(sd * s * 1.35, s * 0.55, sd * s * 0.6, s * 0.85, 0, 0);
    x.fillStyle = lin(x, 0, -s, 0, s, [[0, "#FF8CC6"], [1, "#DB2777"]]);
    x.fill(wing);
    const crease = new Path2D();
    crease.moveTo(sd * s * 0.25, -s * 0.05);
    crease.quadraticCurveTo(sd * s * 0.7, -s * 0.15, sd * s * 0.95, -s * 0.05);
    stroke(x, crease, "rgba(140,10,70,0.35)", s * 0.08);
  }
  x.fillStyle = rad(x, -s * 0.06, -s * 0.1, s * 0.35, [[0, "#FFB3D9"], [1, "#C2185B"]]);
  x.fill(ellipse(0, 0, s * 0.24, s * 0.3));
  x.restore();
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

const ROLL_FOLLOWING: ReadonlySet<OutfitName> = new Set(["sunglasses", "roundGlasses", "bow", "scarf", "pumpkin"]);

/** Hat motion: flies up and swings during a roll, otherwise drops in and scales up. */
function hatTransform(x: Ctx, H: MochiH, o: OutfitOpts) {
  const posP = Ease.back(o.presence);
  if (Math.abs(H.roll) > 0.01) {
    const u = Math.min(1, Math.abs(H.roll) / (2 * Math.PI * Math.max(1, o.rollTurns)));
    x.translate(H.physDx * H.rx * 0.2 * Math.sin(u * Math.PI), -H.ry * 0.45 * Math.sin(u * Math.PI));
    x.rotate(Math.sin(2 * Math.PI * u) * 0.35);
  } else {
    const hatScale = 0.85 + 0.15 * posP;
    x.translate(0, -(1 - posP) * H.ry);
    x.scale(hatScale, hatScale);
  }
}

/** Mochi's body is recoloured by the engine for the pumpkin; true when it should be. */
export function outfitRecolorsBody(kind: OutfitName | null): boolean {
  return kind === "pumpkin";
}

/**
 * Draws one pass of an outfit. `x` is already inside the engine's body transform
 * and the engine has applied the alpha. behind = true is the pass before the body.
 */
export function drawOutfit(x: Ctx, kind: OutfitName, H: MochiH, behind: boolean, o: OutfitOpts) {
  const simplified = H.R < 16 || o.mini;
  const body = mochiOutfitPath(H.rx, H.ry);
  const p = Math.min(1, Math.max(0, o.presence));
  const posP = Ease.back(p);

  if (ROLL_FOLLOWING.has(kind)) {
    // Front while the head's front faces us, behind otherwise (the body hides it).
    const frontFacing = mProjRoll(H, [0, 0, 1]).z >= 0;
    if (behind === frontFacing) return;
  }

  x.save();
  switch (kind) {
    case "bunnyEars": {
      if (!behind) break;
      const u = Math.abs(H.roll) > 0.01
        ? Math.min(1, Math.abs(H.roll) / (2 * Math.PI * Math.max(1, o.rollTurns)))
        : 0;
      const hs = 0.85 + 0.15 * posP;
      x.translate(0, -(1 - posP) * H.ry);
      x.scale(hs, hs);
      drawBunnyEarsBack(x, H, u);
      break;
    }
    case "crown":
      hatTransform(x, H, o);
      if (behind) drawCrownPart(x, H, -1, simplified);
      else drawCrownFront(x, H, body, simplified);
      break;
    case "witchHat":
      hatTransform(x, H, o);
      if (behind) drawWitchHatBack(x, H);
      else drawWitchHatFront(x, H, body);
      break;
    case "beanie":
      if (!behind) { hatTransform(x, H, o); drawBeanieFront(x, H, body, simplified); }
      break;
    case "santaHat":
      if (!behind) { hatTransform(x, H, o); drawSantaHatFront(x, H, body); }
      break;
    case "partyHat":
      if (!behind) { hatTransform(x, H, o); drawPartyHatFront(x, H, simplified); }
      break;
    case "sunglasses":
      x.translate(0, (1 - p) * 0.25 * H.ry);
      drawSunglassesFront(x, H, body);
      break;
    case "roundGlasses":
      x.translate(0, (1 - p) * 0.25 * H.ry);
      drawRoundGlassesFront(x, H, body);
      break;
    case "scarf":
      x.translate(0, (1 - p) * 0.3 * H.ry);
      drawScarfFront(x, H);
      break;
    case "pumpkin":
      drawPumpkinFront(x, H, body, simplified);
      break;
    case "bow": {
      const sc = Math.max(0.001, posP);
      x.scale(sc, sc);
      drawBowFront(x, H);
      break;
    }
  }
  x.restore();
}
