/**
 * End-credits mapping samples the already-playing <video> only. A second
 * decoder/seeker is never created — prefetch must not move the playhead or
 * write watch progress.
 *
 * Credits-like means true black (gaps between name cards) or a dark card
 * with real ink. A dim pictured scene is not credits. A 6 s hold plants the
 * marker at the start of that sequence. A stored marker that lands on a
 * pictured scene is thrown out.
 */
export const CREDITS_SCAN_AFTER = 0.5;
export const CREDITS_OCR_WARM_AFTER = 0.4;
export const NEXT_EPISODE_CREDITS_MIN = 0.8;
export const BLACK_HOLD_SECONDS = 6;
const SAMPLE_MS = 2_000;
const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 360;
const CROP_TOP = 40;
const CROP_HEIGHT = 280;
const STORAGE_KEY = 'cubo.creditsStart';
const OCR_HITS_NEEDED = 2;
const SCENE_LUMA = 45;
const BLACK_LUMA = 32;
/** Silo name cards sit around 54–55; 55.1 must not drop a live hold. */
const DARK_LUMA = 58;
const INK_LUMA = 200;
const SEEK_RESET_SECONDS = 3;
export const FALSE_MARKER_SAMPLES = 2;

export type FrameLuma = {
  avg: number;
  brightRatio: number;
  hasText: boolean;
  isBlack: boolean;
};

export const CREDITS_TEXT_RE =
  /directed\s+by|a\s+film\s+by|created\s+by|written\s+by|produced\s+by|executive\s+producers?|co[- ]?producers?|\bproducers?\b|\bwriters?\b|\bdirector\b|\beditors?\b|edited\s+by|music\s+by|story\s+by|screenplay/i;

export function creditsTextMatch(text: string): boolean {
  return CREDITS_TEXT_RE.test(text.replace(/\s+/g, ' '));
}

export function summarizeFrame(image: ImageData): FrameLuma {
  const pixels = image.data;
  let lumSum = 0;
  let bright = 0;
  let samples = 0;
  for (let index = 0; index < pixels.length; index += 16) {
    const luma =
      0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
    lumSum += luma;
    if (luma > INK_LUMA) bright += 1;
    samples += 1;
  }
  const avg = samples === 0 ? 0 : lumSum / samples;
  const brightRatio = samples === 0 ? 0 : bright / samples;
  return {
    avg,
    brightRatio,
    hasText: brightRatio > 0.012 && brightRatio < 0.25,
    isBlack: avg < BLACK_LUMA,
  };
}

/** Dark field with sparse bright ink — title cards, not dialogue. */
export function looksLikeCreditsCard(image: ImageData): boolean {
  const stats = summarizeFrame(image);
  return stats.avg < DARK_LUMA && stats.hasText;
}

export function isBlackCardWithText(stats: FrameLuma): boolean {
  return stats.isBlack && stats.hasText;
}

/** Dark title card — slightly looser than a true black field so compressed
 *  or near-black credits (Silo-style name cards) still count. */
export function isDarkCardWithText(stats: FrameLuma): boolean {
  return stats.avg < DARK_LUMA && stats.hasText;
}

/** True black, or a dark card with real ink. A dim face/window (Silo ~41,
 *  ~0.7% bright) is not credits. */
export function isCreditsLike(stats: FrameLuma): boolean {
  return stats.isBlack || isDarkCardWithText(stats);
}

/** Stored marker landed on a pictured scene — throw it out. */
export function isFalseCreditsMarker(stats: FrameLuma): boolean {
  return !isCreditsLike(stats) && stats.avg >= 35;
}

export function isPicturedScene(stats: FrameLuma): boolean {
  return stats.avg >= SCENE_LUMA && !isCreditsLike(stats);
}

/** Pictured scene, then an abrupt black card with text — not a fade. */
export function isSuddenBlackCut(previousAvg: number | null, current: FrameLuma): boolean {
  return previousAvg != null && previousAvg >= SCENE_LUMA && isBlackCardWithText(current);
}

/** Left a pictured scene, or already late and the frame looks like credits. */
export function shouldStartBlackHold(
  previousAvg: number | null,
  current: FrameLuma,
  ratio: number,
  alreadyHolding: boolean,
): boolean {
  if (alreadyHolding || !isCreditsLike(current)) return false;
  // First sample after a seek/jump: only trust true black, not a dark scene.
  if (previousAvg == null) return current.isBlack;
  if (previousAvg >= SCENE_LUMA) return true;
  return ratio >= NEXT_EPISODE_CREDITS_MIN;
}

/** Black gaps between name cards keep the hold; a pictured scene kills it. */
export function shouldKeepCreditsHold(stats: FrameLuma): boolean {
  return isCreditsLike(stats);
}

export function blackHoldComplete(
  holdFrom: number | null,
  now: number,
  stillCard: boolean,
): boolean {
  return holdFrom != null && stillCard && now - holdFrom >= BLACK_HOLD_SECONDS;
}

export function nextEpisodeDue(
  shownTime: number,
  duration: number,
  creditsStart: number | null | undefined,
): boolean {
  const start = normalizeCreditsStart(creditsStart);
  if (duration <= 0 || start == null) return false;
  return shownTime >= start && shownTime / duration >= NEXT_EPISODE_CREDITS_MIN;
}

/** 0 is the Core "cleared" sentinel, not a real credits timestamp. */
export function normalizeCreditsStart(
  value: number | null | undefined,
): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function mergeCreditsStart(
  left: number | null | undefined,
  right: number | null | undefined,
): number | null {
  const first = normalizeCreditsStart(left);
  const second = normalizeCreditsStart(right);
  if (first == null) return second;
  if (second == null) return first;
  return Math.min(first, second);
}

/** This browser's saved marker wins over a stale Core value (cleared 0, or
 *  an old false-positive that never got overwritten). */
export function resolveCreditsStart(
  local: number | null | undefined,
  remote: number | null | undefined,
): number | null {
  return normalizeCreditsStart(local) ?? normalizeCreditsStart(remote);
}

export function creditsOverlayActive(due: boolean, watchingCredits: boolean): boolean {
  return due && !watchingCredits;
}

export type CreditsHoldState = {
  lastAvg: number | null;
  holdFrom: number | null;
  mapped: number | null;
  falseHits: number;
};

export type CreditsHoldEvent = 'sample' | 'hold_start' | 'hold_reset' | 'mapped' | 'invalidated';

/** One sample of the live hold/invalidation machine — same rules the player uses. */
export function tickCreditsHold(
  state: CreditsHoldState,
  stats: FrameLuma,
  absolute: number,
  ratio: number,
): CreditsHoldState & { event: CreditsHoldEvent } {
  if (state.mapped != null && absolute >= state.mapped && isFalseCreditsMarker(stats)) {
    const falseHits = state.falseHits + 1;
    if (falseHits >= FALSE_MARKER_SAMPLES) {
      return {
        lastAvg: stats.avg,
        holdFrom: null,
        mapped: null,
        falseHits: 0,
        event: 'invalidated',
      };
    }
    return {
      lastAvg: stats.avg,
      holdFrom: state.holdFrom,
      mapped: state.mapped,
      falseHits,
      event: 'sample',
    };
  }
  if (state.mapped != null) {
    return {
      lastAvg: stats.avg,
      holdFrom: state.holdFrom,
      mapped: state.mapped,
      falseHits: 0,
      event: 'sample',
    };
  }

  const creditsLike = isCreditsLike(stats);
  const wasHolding = state.holdFrom != null;
  let holdFrom = state.holdFrom;
  let event: CreditsHoldEvent = 'sample';
  if (shouldStartBlackHold(state.lastAvg, stats, ratio, wasHolding)) {
    holdFrom = absolute;
    event = 'hold_start';
  } else if (wasHolding && !shouldKeepCreditsHold(stats)) {
    holdFrom = null;
    event = 'hold_reset';
  }
  if (blackHoldComplete(holdFrom, absolute, creditsLike)) {
    return {
      lastAvg: stats.avg,
      holdFrom,
      mapped: holdFrom,
      falseHits: 0,
      event: 'mapped',
    };
  }
  return {
    lastAvg: stats.avg,
    holdFrom,
    mapped: null,
    falseHits: 0,
    event,
  };
}

export function loadCreditsStart(playbackKey: string): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, number>;
    const value = parsed[playbackKey];
    return normalizeCreditsStart(typeof value === 'number' ? value : null);
  } catch {
    return null;
  }
}

export function clearCreditsStart(playbackKey: string): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, number>;
    delete parsed[playbackKey];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // Private mode.
  }
}

export function saveCreditsStart(playbackKey: string, seconds: number): void {
  if (normalizeCreditsStart(seconds) == null) {
    clearCreditsStart(playbackKey);
    return;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    parsed[playbackKey] = seconds;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // Private mode — Core still keeps the mapping.
  }
}

type OcrWorker = {
  recognize: (image: OffscreenCanvas) => Promise<{ data: { text: string } }>;
};

let ocrWorkerPromise: Promise<OcrWorker> | null = null;

async function loadOcrWorker(): Promise<OcrWorker> {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const [{ createWorker, OEM, PSM }, workerUrl] = await Promise.all([
        import('tesseract.js'),
        import('tesseract.js/dist/worker.min.js?url'),
      ]);
      const worker = await createWorker('eng', OEM.LSTM_ONLY, {
        workerPath: workerUrl.default,
        workerBlobURL: false,
        logger: () => undefined,
      });
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        tessedit_char_whitelist:
          'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',
      });
      return worker;
    })().catch((error) => {
      ocrWorkerPromise = null;
      throw error;
    });
  }
  return ocrWorkerPromise;
}

function readElementFrame(
  source: CanvasImageSource,
  frame: OffscreenCanvas,
  crop: OffscreenCanvas,
): { image: ImageData; stats: FrameLuma } | null {
  const context = frame.getContext('2d', { willReadFrequently: true });
  const cropContext = crop.getContext('2d', { willReadFrequently: true });
  if (!context || !cropContext) return null;
  context.drawImage(source, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
  const image = context.getImageData(0, CROP_TOP, FRAME_WIDTH, CROP_HEIGHT);
  return { image, stats: summarizeFrame(image) };
}

export function startCreditsMapper({
  video,
  timeOffset,
  duration,
  knownStart,
  playbackKey,
  onMapped,
  onLog,
}: {
  video: HTMLVideoElement;
  timeOffset: () => number;
  duration: () => number;
  knownStart: number | null;
  playbackKey: string;
  onMapped: (seconds: number | null) => void;
  onLog?: (event: string, data?: Record<string, unknown>) => void;
}): () => void {
  let stopped = false;
  let ocrHits = 0;
  let mapped = normalizeCreditsStart(knownStart);
  let warming = false;
  let busy = false;
  let lastAvg: number | null = null;
  let lastLocalTime = -1;
  let blackHoldFrom: number | null = null;
  let scanAnnounced = false;
  let falseMarkerHits = 0;
  const frame = new OffscreenCanvas(FRAME_WIDTH, FRAME_HEIGHT);
  const crop = new OffscreenCanvas(FRAME_WIDTH, CROP_HEIGHT);

  const log = (event: string, data?: Record<string, unknown>) => {
    const payload = { key: playbackKey, ...data };
    console.info(`[credits] ${event}`, payload);
    onLog?.(event, payload);
  };

  const confirm = (seconds: number, method: string, extra?: Record<string, unknown>) => {
    if (mapped != null) return;
    mapped = seconds;
    saveCreditsStart(playbackKey, seconds);
    log('credits_mapped', { seconds, method, ...extra });
    onMapped(seconds);
  };

  const invalidate = (stats: FrameLuma, absolute: number) => {
    const previous = mapped;
    mapped = null;
    blackHoldFrom = null;
    falseMarkerHits = 0;
    clearCreditsStart(playbackKey);
    log('credits_marker_invalidated', {
      previous,
      seconds: absolute,
      avg: stats.avg,
      hasText: stats.hasText,
      isBlack: stats.isBlack,
    });
    onMapped(null);
  };

  log('credits_mapper_start', { knownStart: mapped });

  const tick = async () => {
    if (stopped) return;
    if (video.paused || video.seeking || video.readyState < 2) return;
    const fullDuration = duration();
    if (fullDuration <= 0) return;
    const localTime = video.currentTime;
    if (lastLocalTime >= 0 && Math.abs(localTime - lastLocalTime) > SEEK_RESET_SECONDS) {
      log('credits_seek_reset', { from: lastLocalTime, to: localTime, lastAvg });
      lastAvg = null;
      blackHoldFrom = null;
      ocrHits = 0;
    }
    lastLocalTime = localTime;
    const absolute = timeOffset() + localTime;
    const ratio = absolute / fullDuration;
    if (ratio >= CREDITS_OCR_WARM_AFTER && !warming && !ocrWorkerPromise) {
      warming = true;
      void loadOcrWorker()
        .then(() => log('credits_ocr_ready'))
        .catch((error) => {
          warming = false;
          log('credits_ocr_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    if (ratio < CREDITS_SCAN_AFTER) return;
    if (!scanAnnounced) {
      scanAnnounced = true;
      log('credits_scan_begin', {
        seconds: Number(absolute.toFixed(1)),
        ratio: Number(ratio.toFixed(3)),
        duration: Number(fullDuration.toFixed(1)),
      });
    }

    let grabbed: { image: ImageData; stats: FrameLuma } | null = null;
    try {
      grabbed = readElementFrame(video, frame, crop);
    } catch (error) {
      log('credits_frame_tainted', {
        error: error instanceof Error ? error.message : String(error),
      });
      stopped = true;
      return;
    }
    if (!grabbed) return;
    const { image, stats } = grabbed;
    const previousAvg = lastAvg;
    const previousHold = blackHoldFrom;
    const next = tickCreditsHold(
      {
        lastAvg,
        holdFrom: blackHoldFrom,
        mapped,
        falseHits: falseMarkerHits,
      },
      stats,
      absolute,
      ratio,
    );
    falseMarkerHits = next.falseHits;
    lastAvg = next.lastAvg;
    blackHoldFrom = next.holdFrom;

    if (next.event === 'invalidated') {
      invalidate(stats, absolute);
      return;
    }
    if (next.event === 'mapped' && next.mapped != null) {
      confirm(next.mapped, 'credits_hold', {
        heldFor: absolute - next.mapped,
        avg: stats.avg,
      });
      return;
    }
    if (mapped != null) return;

    const cut = isSuddenBlackCut(previousAvg, stats);
    if (next.event === 'hold_start') {
      log('credits_black_hold_start', {
        seconds: absolute,
        ratio,
        cut,
        lateCard: !cut && ratio >= NEXT_EPISODE_CREDITS_MIN,
        avg: stats.avg,
        previousAvg,
        brightRatio: stats.brightRatio,
        isBlack: stats.isBlack,
        hasText: stats.hasText,
      });
    } else if (next.event === 'hold_reset') {
      log('credits_black_hold_reset', {
        seconds: absolute,
        heldFor: absolute - (previousHold ?? absolute),
        avg: stats.avg,
        hasText: stats.hasText,
        isBlack: stats.isBlack,
      });
    }
    log('credits_sample', {
      seconds: Number(absolute.toFixed(1)),
      ratio: Number(ratio.toFixed(3)),
      avg: Number(stats.avg.toFixed(1)),
      brightRatio: Number(stats.brightRatio.toFixed(3)),
      hasText: stats.hasText,
      isBlack: stats.isBlack,
      creditsLike: isCreditsLike(stats),
      cut,
      holdFrom: blackHoldFrom,
      ocrBusy: busy,
    });

    const cropContext = crop.getContext('2d', { willReadFrequently: true });
    if (!looksLikeCreditsCard(image) || busy || !cropContext) {
      if (!looksLikeCreditsCard(image)) ocrHits = 0;
      return;
    }

    busy = true;
    try {
      cropContext.putImageData(image, 0, 0);
      const worker = await loadOcrWorker();
      if (stopped || mapped != null) return;
      const result = await worker.recognize(crop);
      if (stopped || mapped != null) return;
      const text = result.data.text.replace(/\s+/g, ' ').trim();
      const matched = creditsTextMatch(text);
      log('credits_ocr', { seconds: absolute, text, matched, ocrHits: matched ? ocrHits + 1 : 0 });
      if (!matched) {
        ocrHits = 0;
        return;
      }
      ocrHits += 1;
      if (ocrHits < OCR_HITS_NEEDED) return;
      confirm(absolute, 'ocr_words', { text });
    } catch (error) {
      ocrHits = 0;
      log('credits_ocr_failed', {
        seconds: absolute,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      busy = false;
    }
  };

  const timer = window.setInterval(() => {
    void tick();
  }, SAMPLE_MS);
  void tick();

  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}
