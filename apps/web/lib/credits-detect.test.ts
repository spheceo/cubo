import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  BLACK_HOLD_SECONDS,
  blackHoldComplete,
  creditsTextMatch,
  isBlackCardWithText,
  isCreditsLike,
  isDarkCardWithText,
  isFalseCreditsMarker,
  isPicturedScene,
  isSuddenBlackCut,
  looksLikeCreditsCard,
  creditsOverlayActive,
  mergeCreditsStart,
  nextEpisodeDue,
  normalizeCreditsStart,
  resolveCreditsStart,
  shouldKeepCreditsHold,
  shouldStartBlackHold,
  summarizeFrame,
  tickCreditsHold,
  type CreditsHoldState,
  type FrameLuma,
} from './credits-detect';

function pixels(width: number, height: number, fill: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(fill);
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

function cardOnBlack(): ImageData {
  const card = pixels(64, 32, 4);
  for (let index = 0; index < card.data.length; index += 160) {
    card.data[index] = 230;
    card.data[index + 1] = 230;
    card.data[index + 2] = 230;
  }
  return card;
}

test('credits regex accepts end-card roles and ignores dialogue', () => {
  assert.equal(creditsTextMatch('Directed by Guy Ritchie'), true);
  assert.equal(creditsTextMatch('A FILM BY\nGUY RITCHIE'), true);
  assert.equal(creditsTextMatch('Created by Guy Ritchie'), true);
  assert.equal(creditsTextMatch('Written  by  Theo  James'), true);
  assert.equal(creditsTextMatch('Executive Producer'), true);
  assert.equal(creditsTextMatch('Producer'), true);
  assert.equal(creditsTextMatch('Writer'), true);
  assert.equal(creditsTextMatch('Produced by'), true);
  assert.equal(creditsTextMatch('I was directed toward the door'), false);
  assert.equal(creditsTextMatch('see you next week'), false);
});

test('next episode waits for a mapped credits start', () => {
  assert.equal(nextEpisodeDue(91, 100, null), false);
  assert.equal(nextEpisodeDue(85, 100, 84), true);
  assert.equal(nextEpisodeDue(83, 100, 84), false);
  assert.equal(nextEpisodeDue(79, 100, 70), false);
  assert.equal(nextEpisodeDue(50, 0, 40), false);
});

test('credits timestamps keep the earlier mapping', () => {
  assert.equal(mergeCreditsStart(null, 1200), 1200);
  assert.equal(mergeCreditsStart(1100, 1200), 1100);
  assert.equal(mergeCreditsStart(undefined, undefined), null);
  assert.equal(normalizeCreditsStart(0), null);
  assert.equal(mergeCreditsStart(0, 3501), 3501);
  assert.equal(mergeCreditsStart(0, null), null);
  assert.equal(nextEpisodeDue(3498, 3563, 0), false);
  assert.equal(nextEpisodeDue(3502, 3563, 3501), true);
});

test('credits-card heuristic wants a dark field with sparse bright ink', () => {
  assert.equal(looksLikeCreditsCard(pixels(64, 32, 0)), false);
  assert.equal(looksLikeCreditsCard(cardOnBlack()), true);
  assert.equal(looksLikeCreditsCard(pixels(64, 32, 220)), false);
});

test('a sudden cut is a pictured scene then a black card with text', () => {
  const card = summarizeFrame(cardOnBlack());
  assert.equal(isBlackCardWithText(card), true);
  assert.equal(isSuddenBlackCut(80, card), true);
  assert.equal(isSuddenBlackCut(20, card), false);
  assert.equal(isSuddenBlackCut(null, card), false);
  assert.equal(isSuddenBlackCut(80, summarizeFrame(pixels(64, 32, 180))), false);
});

test('past 80% a name card can start a hold without a bright-scene cut', () => {
  const card = summarizeFrame(cardOnBlack());
  assert.equal(shouldStartBlackHold(12, card, 0.98, false), true);
  assert.equal(shouldStartBlackHold(12, card, 0.6, false), false);
  assert.equal(shouldStartBlackHold(80, card, 0.6, false), true);
  assert.equal(shouldStartBlackHold(12, card, 0.98, true), false);
  const dimStats = {
    avg: 42,
    brightRatio: 0.04,
    hasText: true,
    isBlack: false,
  };
  assert.equal(isBlackCardWithText(dimStats), false);
  assert.equal(isDarkCardWithText(dimStats), true);
  assert.equal(shouldStartBlackHold(12, dimStats, 0.98, false), true);
});

test('a black card has to hold for several seconds after the cut', () => {
  assert.equal(blackHoldComplete(1000, 1000 + BLACK_HOLD_SECONDS - 1, true), false);
  assert.equal(blackHoldComplete(1000, 1000 + BLACK_HOLD_SECONDS, true), true);
  assert.equal(blackHoldComplete(1000, 1000 + BLACK_HOLD_SECONDS, false), false);
  assert.equal(blackHoldComplete(null, 1000 + BLACK_HOLD_SECONDS, true), false);
});

test('a gray Silo name card just over luma 55 still counts as credits', () => {
  const card = { avg: 55.1, brightRatio: 0.023, hasText: true, isBlack: false };
  assert.equal(isCreditsLike(card), true);
  assert.equal(shouldKeepCreditsHold(card), true);
});

const SILO_DURATION = 3563.776;

function luma(
  avg: number,
  extra: Partial<FrameLuma> = {},
): FrameLuma {
  const isBlack = avg < 32;
  const brightRatio = extra.brightRatio ?? 0;
  const hasText = extra.hasText ?? (brightRatio > 0.012 && brightRatio < 0.25);
  return { avg, brightRatio, hasText, isBlack, ...extra };
}

function replay(
  samples: { seconds: number; stats: FrameLuma }[],
  start: CreditsHoldState = { lastAvg: null, holdFrom: null, mapped: null, falseHits: 0 },
) {
  let state = start;
  const events: { event: string; seconds: number; mapped: number | null }[] = [];
  for (const sample of samples) {
    const next = tickCreditsHold(
      state,
      sample.stats,
      sample.seconds,
      sample.seconds / SILO_DURATION,
    );
    if (next.event !== 'sample') {
      events.push({ event: next.event, seconds: sample.seconds, mapped: next.mapped });
    }
    state = next;
  }
  return { state, events };
}

test('Silo Freedom Day logs map the name-card start, not the Oyelowo scene', () => {
  const { state, events } = replay([
    { seconds: 3487.3, stats: luma(42.8) },
    { seconds: 3489.3, stats: luma(42.5) },
    { seconds: 3491.3, stats: luma(92.1) },
    { seconds: 3493.3, stats: luma(92.9) },
    { seconds: 3495.3, stats: luma(54.8, { brightRatio: 0.021, hasText: true }) },
    { seconds: 3497.3, stats: luma(55.1, { brightRatio: 0.023, hasText: true }) },
    { seconds: 3499.3, stats: luma(55.3, { brightRatio: 0.025, hasText: true }) },
    { seconds: 3501.3, stats: luma(0, { isBlack: true }) },
    { seconds: 3503.3, stats: luma(0.4, { isBlack: true }) },
    { seconds: 3505.3, stats: luma(0.5, { isBlack: true }) },
  ]);
  assert.equal(events[0]?.event, 'hold_start');
  assert.equal(events[0]?.seconds, 3495.3);
  assert.equal(events.some((entry) => entry.event === 'hold_reset'), false);
  assert.equal(state.mapped, 3495.3);
  assert.equal(nextEpisodeDue(3494, SILO_DURATION, state.mapped), false);
  assert.equal(nextEpisodeDue(3496, SILO_DURATION, state.mapped), true);
});

test('a stored 3471 marker on the Oyelowo scene is thrown out', () => {
  const { state, events } = replay(
    [
      { seconds: 3483.9, stats: luma(51.4) },
      { seconds: 3485.9, stats: luma(51.4) },
    ],
    { lastAvg: null, holdFrom: null, mapped: 3471.077, falseHits: 0 },
  );
  assert.equal(events[0]?.event, 'invalidated');
  assert.equal(state.mapped, null);
  assert.equal(nextEpisodeDue(3485.9, SILO_DURATION, state.mapped), false);
});

test('a cleared 0 sentinel does not show Next Episode on resume at 3498', () => {
  assert.equal(resolveCreditsStart(null, 0), null);
  assert.equal(resolveCreditsStart(3501, 3471), 3501);
  assert.equal(resolveCreditsStart(null, 3501), 3501);
  assert.equal(nextEpisodeDue(3498, SILO_DURATION, 0), false);
  assert.equal(nextEpisodeDue(3498, SILO_DURATION, 3501), false);
  assert.equal(nextEpisodeDue(3502, SILO_DURATION, 3501), true);
  assert.equal(creditsOverlayActive(true, false), true);
  assert.equal(creditsOverlayActive(true, true), false);
  assert.equal(creditsOverlayActive(false, false), false);
});

test('Silo-style black gaps keep a credits hold and late black can start one', () => {
  const scene = { avg: 92, brightRatio: 0, hasText: false, isBlack: false };
  const dimScene = { avg: 42, brightRatio: 0, hasText: false, isBlack: false };
  const nameCard = { avg: 54, brightRatio: 0.022, hasText: true, isBlack: false };
  const blackGap = { avg: 0, brightRatio: 0, hasText: false, isBlack: true };
  const faintNames = { avg: 0.4, brightRatio: 0.001, hasText: false, isBlack: true };

  assert.equal(isPicturedScene(scene), true);
  assert.equal(isCreditsLike(dimScene), false);
  assert.equal(isCreditsLike(nameCard), true);
  assert.equal(isCreditsLike(blackGap), true);
  assert.equal(isCreditsLike(faintNames), true);

  assert.equal(shouldStartBlackHold(92, nameCard, 0.98, false), true);
  assert.equal(shouldKeepCreditsHold(blackGap), true);
  assert.equal(shouldKeepCreditsHold(faintNames), true);
  assert.equal(shouldKeepCreditsHold(scene), false);
  assert.equal(shouldStartBlackHold(0, blackGap, 0.983, false), true);
  assert.equal(shouldStartBlackHold(42, dimScene, 0.98, false), false);
  assert.equal(shouldStartBlackHold(null, nameCard, 0.97, false), false);
  assert.equal(shouldStartBlackHold(null, blackGap, 0.97, false), true);

  const oyelowo = { avg: 41.2, brightRatio: 0.007, hasText: false, isBlack: false };
  assert.equal(isCreditsLike(oyelowo), false);
  assert.equal(isFalseCreditsMarker(oyelowo), true);
  assert.equal(shouldStartBlackHold(null, oyelowo, 0.974, false), false);
});
