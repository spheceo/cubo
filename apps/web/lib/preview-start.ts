/** Skip the opening logos/credits. Reuse buffered scenes beyond that floor;
 * otherwise choose a bounded early scene rather than a distant random seek. */
export function previewStart(
  duration: number,
  fraction: number,
  buffered: ReadonlyArray<readonly [number, number]> = [],
  clipSeconds = 40,
): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const latest = Math.max(0, Math.min(duration / 2, duration - clipSeconds - 6));
  const earliest = Math.min(latest, Math.max(90, Math.min(300, duration * 0.1)));
  for (const [start, end] of buffered) {
    const candidate = Math.max(earliest, start);
    if (candidate <= latest && end - candidate >= clipSeconds) return candidate;
  }
  const bounded = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  return earliest + bounded * Math.min(120, latest - earliest);
}
