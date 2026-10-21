import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MAX_COUNTDOWN_EASE, approachToward, countdownRate } from './pointer-intent';

const target = { x: 1800, y: 1000 };
const span = 2000;

test('a pointer that does not move, or has nowhere to be, shows no intent', () => {
  assert.equal(approachToward({ x: 10, y: 10 }, { x: 10, y: 10 }, target, span), 0);
  assert.equal(approachToward({ x: 10, y: 10 }, { x: 40, y: 40 }, target, 0), 0);
});

test('moving away from the buttons, or across them, is just looking for the cursor', () => {
  assert.equal(approachToward({ x: 900, y: 500 }, { x: 800, y: 400 }, target, span), 0);
  // Straight sideways to the target's line barely closes the distance.
  const across = approachToward({ x: 1800, y: 200 }, { x: 1700, y: 200 }, target, span);
  assert.ok(across < 0.05);
});

test('heading for the buttons counts more the nearer the pointer gets', () => {
  const far = approachToward({ x: 100, y: 100 }, { x: 190, y: 148 }, target, span);
  const near = approachToward({ x: 1500, y: 840 }, { x: 1590, y: 888 }, target, span);
  assert.ok(far > 0);
  assert.ok(near > far);
  assert.ok(near <= 1);
});

test('the countdown never slows by more than the cap', () => {
  assert.equal(countdownRate(0), 1);
  assert.equal(countdownRate(1), 1 - MAX_COUNTDOWN_EASE);
  assert.equal(countdownRate(4), 1 - MAX_COUNTDOWN_EASE);
  assert.equal(countdownRate(-1), 1);
});
