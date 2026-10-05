// Mochi accessories on the head model — port of the 3D helpers in
// NotchBuddy/Sources/CoucouKit/MochiOutfitDrawing.swift (lines 1-210), plus the
// brand accessories (headphones, calendar page) built on them.
//
// Everything here is a pure function of the head state (yaw, pitch, roll): it
// draws inside the engine's body transform and adds no animation of its own.

export type AccessoryName = "headphones" | "calendar";
export type Vec3 = readonly [number, number, number];

// ── Constants (mirror JS / Swift) ─────────────────────────────────────────────

export const K_EXP = 2.7;
export const K_VIEW_TILT = -0.3;
export const K_ACC_PITCH = 0.4;
export const K_EYE_W = 0.25;
export const K_EYE_H = 0.27;
export const K_EYE_SP = 0.37;
export const K_EYE_P = -0.12;

/** Head geometry + pose (MochiH). */
export interface MochiH {
  R: number; rx: number; ry: number;
  yaw: number; pitch: number;
  view: number;
  physDx: number; physDy: number;
  roll: number;
}

export function makeH(
  R: number, yaw = 0, pitch = 0, physDx = 0, physDy = 0, roll = 0,
): MochiH {
  return { R, rx: R * 1.14, ry: R * 0.88, yaw, pitch, view: K_VIEW_TILT, physDx, physDy, roll };
}

export interface EyeFrame {
  sd: number; x: number; y: number; fx: number; fy: number;
  visible: boolean; w: number; h: number;
}

export function mEyeFrames(H: MochiH): EyeFrame[] {
  const out: EyeFrame[] = [];
  for (const sd of [-1, 1]) {
    const eyeYaw = sd * K_EYE_SP + H.yaw;
    const eyePitch = K_EYE_P + H.pitch;
    const cp = Math.cos(eyePitch);
    out.push({
      sd,
      x: Math.sin(eyeYaw) * cp * H.rx,
      y: -Math.sin(eyePitch) * H.ry,
      fx: Math.max(0.18, Math.cos(eyeYaw)),
      fy: Math.max(0.18, cp),
      visible: Math.cos(eyeYaw) * cp > 0.04,
      w: H.R * K_EYE_W,
      h: H.R * K_EYE_H,
    });
  }
  return out;
}

// ── 3D helpers ────────────────────────────────────────────────────────────────

export interface P3 { x: number; y: number; z: number }

/** Radius of the horizontal ring at head-local height y. */
export function mRingR(y: number): number {
  const a = Math.min(1, Math.abs(y));
  return Math.pow(1 - Math.pow(a, K_EXP), 1 / K_EXP);
}

/** Rotate head-local (x right, y up, z viewer) by yaw then pitch. */
export function mRot3(p: Vec3, yaw: number, pitch: number): Vec3 {
  const [x, y, z] = p;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return [x1, y * cp + z1 * sp, -y * sp + z1 * cp];
}

/** Head-local to screen (body space). */
export function mProj(H: MochiH, p: Vec3): P3 {
  const r = mRot3(p, H.yaw, H.view + H.pitch * K_ACC_PITCH);
  return { x: r[0] * H.rx, y: -r[1] * H.ry, z: r[2] };
}

/** Point on the head surface at height y, longitude lon, scaled by s. */
export function mSurf(y: number, lon: number, s = 1): Vec3 {
  const r = mRingR(y) * s;
  return [r * Math.sin(lon), y, r * Math.cos(lon)];
}

/** Front arc of projected ring points, ordered left to right (silhouette tangents). */
export function frontSilhouetteArc(pts: P3[]): P3[] {
  const n = pts.length;
  if (n <= 1) return pts;
  let minIdx = 0, maxIdx = 0;
  for (let i = 1; i < n; i++) {
    if (pts[i].x < pts[minIdx].x) minIdx = i;
    if (pts[i].x > pts[maxIdx].x) maxIdx = i;
  }
  if (minIdx === maxIdx) return [pts[minIdx]];
  const arcA: P3[] = [];
  let i = minIdx;
  for (;;) {
    arcA.push(pts[i]);
    if (i === maxIdx) break;
    i = (i + 1) % n;
    if (arcA.length > n) break;
  }
  const arcB: P3[] = [];
  i = minIdx;
  for (;;) {
    arcB.push(pts[i]);
    if (i === maxIdx) break;
    i = (i - 1 + n) % n;
    if (arcB.length > n) break;
  }
  const zA = arcA.reduce((s, p) => s + p.z, 0) / Math.max(1, arcA.length);
  const zB = arcB.reduce((s, p) => s + p.z, 0) / Math.max(1, arcB.length);
  return zA >= zB ? arcA : arcB;
}

export function mFrontArc(H: MochiH, y: number, s: number): P3[] {
  const n = 120;
  const pts: P3[] = [];
  for (let i = 0; i < n; i++) {
    const lon = -Math.PI + (i / n) * 2 * Math.PI;
    pts.push(mProj(H, mSurf(y, lon, s)));
  }
  return frontSilhouetteArc(pts);
}

/** Projection with roll applied (roll-following accessories). */
export function mProjRoll(H: MochiH, p: Vec3): P3 {
  const r = mRot3(p, H.yaw, H.view + H.pitch * K_ACC_PITCH + H.roll);
  return { x: r[0] * H.rx, y: -r[1] * H.ry, z: r[2] };
}

/** Path of the region above the front arc of ring y (what a cap covers). */
export function mCapClip(H: MochiH, y: number, s: number, extraTop = 3): Path2D {
  const arc = mFrontArc(H, y, s);
  const p = new Path2D();
  if (!arc.length) return p;
  p.moveTo(arc[0].x - H.rx, arc[0].y);
  for (const q of arc) p.lineTo(q.x, q.y);
  const last = arc[arc.length - 1];
  p.lineTo(last.x + H.rx, last.y);
  p.lineTo(H.rx * 2, -H.ry * extraTop);
  p.lineTo(-H.rx * 2, -H.ry * extraTop);
  p.closePath();
  return p;
}

/** Complement of `p` inside a large rect; clip with the "evenodd" rule. */
export function mInvert(p: Path2D, H: MochiH): Path2D {
  const q = new Path2D();
  q.rect(-H.rx * 4, -H.ry * 4, H.rx * 8, H.ry * 8);
  q.addPath(p);
  return q;
}

// ── Accessories ───────────────────────────────────────────────────────────────

export interface AccessoryOpts {
  mini: boolean;
  /** Presence scale (0.85 + 0.15 * back(p)); 1 when settled. */
  scale: number;
  /** Ink for dark parts on mini bots (MINI_INK). */
  miniInk: string;
}

const SHELL = "#111317";
const CUSHION = "#2A2D33";

/**
 * Draws one pass of an accessory. `ctx` is already inside the body transform.
 * behind = true draws the parts facing away (z < 0); false draws the near parts.
 */
export function drawAccessory(
  x: CanvasRenderingContext2D,
  kind: AccessoryName,
  H: MochiH,
  behind: boolean,
  o: AccessoryOpts,
) {
  if (kind === "headphones") drawHeadphones(x, H, behind, o);
  else drawCalendar(x, H, behind, o);
}

function inPass(z: number, behind: boolean) {
  return behind ? z < 0 : z >= 0;
}

// Headphones ------------------------------------------------------------------

const BAND_S = 1.025;
const BAND_Z = -0.02;

function bandPoint(a: number): Vec3 {
  // Side-to-side great circle (the x-y plane), following the head's superellipse.
  const e = 2 / K_EXP;
  const c = Math.cos(a), s = Math.sin(a);
  const px = (c >= 0 ? 1 : -1) * Math.pow(Math.abs(c), e);
  const py = Math.pow(Math.max(0, s), e);
  return [px * BAND_S, py * BAND_S, BAND_Z];
}

function rrect(x: CanvasRenderingContext2D, X: number, Y: number, W: number, Hh: number, r: number) {
  const rr = Math.max(0, Math.min(r, W / 2, Hh / 2));
  x.beginPath();
  x.moveTo(X + rr, Y);
  x.arcTo(X + W, Y, X + W, Y + Hh, rr);
  x.arcTo(X + W, Y + Hh, X, Y + Hh, rr);
  x.arcTo(X, Y + Hh, X, Y, rr);
  x.arcTo(X, Y, X + W, Y, rr);
  x.closePath();
}

function drawHeadphones(x: CanvasRenderingContext2D, H: MochiH, behind: boolean, o: AccessoryOpts) {
  const R = H.R;
  const flat = o.mini;
  const dark = flat ? o.miniInk : SHELL;

  x.save();
  x.scale(o.scale, o.scale);

  // Band: polyline of the great circle, split by depth so each pass draws its part.
  const n = 44;
  const pts: P3[] = [];
  for (let i = 0; i <= n; i++) pts.push(mProjRoll(H, bandPoint((i / n) * Math.PI)));
  const bandPath = (dx: number, dy: number) => {
    const p = new Path2D();
    let pen = false;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[i + 1];
      if (!inPass((a.z + b.z) / 2, behind)) { pen = false; continue; }
      if (!pen) { p.moveTo(a.x + dx, a.y + dy); pen = true; }
      p.lineTo(b.x + dx, b.y + dy);
    }
    return p;
  };
  x.lineCap = "round";
  x.lineJoin = "round";
  x.strokeStyle = dark;
  x.lineWidth = R * (flat ? 0.22 : 0.14);
  x.stroke(bandPath(0, 0));
  if (!flat) {
    x.strokeStyle = "rgba(255,255,255,0.22)";
    x.lineWidth = R * 0.04;
    x.stroke(bandPath(R * 0.03, -R * 0.035));
  }

  // Ear cups: screen-space pads centred on the head's side, straddling the silhouette.
  const cw = R * (flat ? 0.34 : 0.26);
  const ch = R * (flat ? 0.5 : 0.46);
  for (const sd of [-1, 1]) {
    const c = mProjRoll(H, [sd * 1.0, 0.06, 0]);
    if (!inPass(c.z, behind)) continue;
    rrect(x, c.x - cw / 2, c.y - ch / 2, cw, ch, cw / 2);
    x.fillStyle = dark;
    x.fill();
    if (flat) continue;
    // cushion on the side facing the head
    const iw = cw * 0.5, ih = ch * 0.78;
    rrect(x, c.x - sd * cw * 0.28 - iw / 2, c.y - ih / 2, iw, ih, iw / 2);
    x.fillStyle = CUSHION;
    x.fill();
    // soft highlight, top right
    x.beginPath();
    x.ellipse(c.x + cw * 0.12, c.y - ch * 0.28, cw * 0.14, ch * 0.09, -0.4, 0, Math.PI * 2);
    x.fillStyle = "rgba(255,255,255,0.20)";
    x.fill();
  }
  x.restore();
}

// Calendar page ---------------------------------------------------------------

const CAL_Y = -0.45;
const CAL_LON = 1.0;
const CAL_S = 1.0;
const CAL_TILT = -0.14;

function drawCalendar(x: CanvasRenderingContext2D, H: MochiH, behind: boolean, o: AccessoryOpts) {
  const R = H.R;
  const simple = o.mini || R < 16;
  const surf = mSurf(CAL_Y, CAL_LON, CAL_S);
  const c = mProjRoll(H, surf);
  if (!inPass(c.z, behind)) return;

  // Card plane: tangent to the head at the anchor, so yaw, pitch and roll
  // foreshorten the card with the head. Card space is 1 x 1 (a unit square).
  const o0 = mProjRoll(H, [0, 0, 0]);
  const right = mProjRoll(H, [Math.cos(CAL_LON), 0, -Math.sin(CAL_LON)]);
  const up = mProjRoll(H, [0, 1, 0]);
  // Size from the rest pose, so the page is a stable fraction of R.
  const r0 = makeH(R);
  const p0 = mProjRoll(r0, [0, 0, 0]);
  const lr = Math.hypot(mProjRoll(r0, [Math.cos(CAL_LON), 0, -Math.sin(CAL_LON)]).x - p0.x,
    mProjRoll(r0, [Math.cos(CAL_LON), 0, -Math.sin(CAL_LON)]).y - p0.y);
  const lu = Math.hypot(mProjRoll(r0, [0, 1, 0]).x - p0.x, mProjRoll(r0, [0, 1, 0]).y - p0.y);
  const wPx = R * (o.mini ? 0.7 : 0.62);
  const hPx = R * (o.mini ? 0.7 : 0.66);
  const kx = wPx / lr, ky = hPx / lu;

  x.save();
  x.transform(
    right.x - o0.x, right.y - o0.y, -(up.x - o0.x), -(up.y - o0.y), c.x, c.y,
  );
  x.rotate(CAL_TILT);
  x.scale(kx * o.scale, ky * o.scale);
  // Unit card space, 1 wide x 1 tall, centred on the origin.
  const px = 1 / kx; // one screen pixel in card-x units (approx, for stroke widths)

  if (o.mini) {
    x.fillStyle = "#FFFFFF";
    x.fillRect(-0.5, -0.5, 1, 1);
    x.fillStyle = "#EA4335";
    x.fillRect(-0.5, -0.5, 1, 0.35);
    x.restore();
    return;
  }

  const cr = 0.09;
  // Soft contact shadow where the page meets the head.
  rrect(x, -0.5 + 0.04, -0.5 + 0.06, 1, 1, cr);
  x.fillStyle = "rgba(30,40,70,0.10)";
  x.fill();

  rrect(x, -0.5, -0.5, 1, 1, cr);
  x.fillStyle = "#FFFFFF";
  x.fill();

  x.save();
  rrect(x, -0.5, -0.5, 1, 1, cr);
  x.clip();
  x.fillStyle = "#EA4335";
  x.fillRect(-0.5, -0.5, 1, 0.3);
  x.restore();

  rrect(x, -0.5, -0.5, 1, 1, cr);
  x.lineWidth = Math.max(0.02, px * 0.6);
  x.strokeStyle = "rgba(0,0,0,0.14)";
  x.stroke();

  // Two ring tabs
  x.fillStyle = "#3C4043";
  for (const sd of [-1, 1]) {
    rrect(x, sd * 0.24 - 0.04, -0.5 - 0.07, 0.08, 0.15, 0.04);
    x.fill();
  }

  if (!simple) {
    x.lineCap = "round";
    x.strokeStyle = "#BDC1C6";
    x.lineWidth = 0.07;
    x.beginPath();
    x.moveTo(-0.28, 0.1); x.lineTo(0.28, 0.1);
    x.moveTo(-0.28, 0.3); x.lineTo(0.08, 0.3);
    x.stroke();
  }
  x.restore();
}
