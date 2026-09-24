/** What the player's grey bar shows from Core's on-disk ranges: the single
 *  stretch the viewer can watch without waiting, from the playhead to the
 *  first missing piece. Torrents fetch pieces out of order, so the raw
 *  ranges ahead are islands with holes — accurate, but not what "buffered"
 *  means to a viewer. Hairline gaps (a piece mid-verify) are bridged. */
export interface TimeRange {
  start: number;
  end: number;
}

const BRIDGE_SECONDS = 2;

export function watchableSpan(ranges: TimeRange[], position: number): TimeRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let span: TimeRange | null = null;
  for (const range of sorted) {
    if (span) {
      if (range.start - span.end > BRIDGE_SECONDS) break;
      span.end = Math.max(span.end, range.end);
      continue;
    }
    if (range.start - BRIDGE_SECONDS <= position && range.end >= position) {
      span = { start: range.start, end: range.end };
    }
  }
  return span ? [span] : [];
}
