// When a finished Claude turn earns a celebration. Pure, so it is easy to test.

/** A turn that ran at least this long (ms) gets confetti when it finishes cleanly. */
export const CELEBRATE_AFTER_MS = 5 * 60 * 1000;

export function shouldCelebrate(promptAt: number | null | undefined, now: number): boolean {
  if (promptAt == null) return false;
  return now - promptAt >= CELEBRATE_AFTER_MS;
}
