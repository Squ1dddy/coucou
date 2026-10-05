// Wheel logic for the overview carousel. Pure, so it can be reasoned about (and
// tested) without a DOM.

export type Dir = 1 | -1;

/** One mouse notch is 100 px; a touchpad swipe reports many small deltas. */
const WHEEL_THRESHOLD = 50;
const WHEEL_LOCK_MS = 350;
const LINE_PX = 16;

/**
 * Turns raw wheel deltas into at most one step per lock window. Deltas that
 * arrive while locked are dropped, so a fast spin or a touchpad's inertia tail
 * cannot skip agents.
 */
export class WheelStepper {
  private acc = 0;
  private lockedUntil = 0;

  /** `deltaMode` is the WheelEvent's (0 pixels, 1 lines, 2 pages). */
  feed(deltaY: number, nowMs: number, deltaMode = 0): Dir | 0 {
    if (nowMs < this.lockedUntil) {
      this.acc = 0;
      return 0;
    }
    this.acc += deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * 100 : deltaY;
    if (Math.abs(this.acc) < WHEEL_THRESHOLD) return 0;
    const dir: Dir = this.acc > 0 ? 1 : -1;
    this.acc = 0;
    this.lockedUntil = nowMs + WHEEL_LOCK_MS;
    return dir;
  }
}

/** Next index in a list of `len`, never wrapping; `bounce` at either end. */
export function stepIndex(
  index: number,
  dir: Dir,
  len: number,
): { index: number; bounce: boolean } {
  const next = index + dir;
  if (len === 0 || next < 0 || next >= len) return { index, bounce: true };
  return { index: next, bounce: false };
}
