let lastAt = 0;
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Android has navigator.vibrate; iPhone Safari does not, so the pop leans on sound and shake there. */
export const canVibrate = typeof navigator !== "undefined" && "vibrate" in navigator;

/** Progressive enhancement: Android buzzes, iOS silently ignores. Rate-limited to one call per 80 ms. */
export function vibrate(pattern: number | number[], force = false) {
  try {
    if (reduced() || !canVibrate) return;
    const now = performance.now();
    if (!force && now - lastAt < 80) return;
    lastAt = now;
    navigator.vibrate(pattern);
  } catch {
    /* never throw from a haptic */
  }
}

/** A vibration pattern that buzzes on each crunch hit (onsets in ms from the audio), so 콰-자-작 is felt too. */
export function vibrateHits(onsets: number[], strongMs = 14, delayMs = 0) {
  if (!canVibrate) return;
  if (delayMs > 4) { setTimeout(() => vibrateHits(onsets, strongMs, 0), delayMs); return; }
  if (!onsets.length) { vibrate(strongMs, true); return; }
  const pattern: number[] = [];
  for (let i = 0; i < onsets.length; i++) {
    const on = i === 0 ? strongMs : i === onsets.length - 1 ? 9 : 6;
    if (i > 0) pattern.push(Math.max(10, Math.round(onsets[i] - onsets[i - 1] - (pattern.length ? pattern[pattern.length - 1] : 0))));
    pattern.push(on);
  }
  vibrate(pattern, true);
}

export const prefersReducedMotion = reduced;
