import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  mergeUpdateStatus,
  updateButtonLabel,
  updateInProgress,
  updateProgressPercent,
} from './update-ui';
import type { CoreUpdateStatus } from './local-engine';

const base: CoreUpdateStatus = {
  current: '0.0.12',
  latest: 'v0.0.13',
  state: 'idle',
};

test('idle update button names the latest version', () => {
  assert.equal(updateButtonLabel({ state: 'idle', progress: 0 }), 'Update');
  assert.equal(
    updateButtonLabel({ state: 'idle', progress: 0, latest: 'v0.0.13' }),
    'Update to v0.0.13',
  );
  assert.equal(
    updateButtonLabel({ state: 'ready', progress: 1, latest: '0.1.0' }),
    'Update to v0.1.0',
  );
});

test('download progress lands on the button label', () => {
  assert.equal(updateButtonLabel({ state: 'downloading' }), 'Updating…');
  assert.equal(
    updateButtonLabel({ state: 'downloading', progress: 0.42 }),
    'Updating 42%',
  );
  assert.equal(updateButtonLabel({ state: 'applying', progress: 1 }), 'Installing…');
  assert.equal(
    updateButtonLabel({ state: 'ready', progress: 1 }, true),
    'Installing…',
  );
});

test('percent hides until Core reports real bytes', () => {
  assert.equal(updateProgressPercent(undefined), null);
  assert.equal(updateProgressPercent(0), null);
  assert.equal(updateProgressPercent(0.004), 1);
  assert.equal(updateProgressPercent(1), 100);
});

test('in-flight download is not clobbered by an idle poll', () => {
  const current: CoreUpdateStatus = {
    ...base,
    state: 'downloading',
    progress: 0.3,
  };
  const merged = mergeUpdateStatus(current, { ...base, state: 'idle' }, true);
  assert.equal(merged.state, 'downloading');
  assert.equal(merged.progress, 0.3);
});

test('later byte progress wins while downloading', () => {
  const current: CoreUpdateStatus = {
    ...base,
    state: 'downloading',
    progress: 0.2,
  };
  const merged = mergeUpdateStatus(
    current,
    { ...base, state: 'downloading', progress: 0.55 },
    true,
  );
  assert.equal(merged.progress, 0.55);
});

test('banner stays up through download and apply', () => {
  assert.equal(updateInProgress('idle', false), false);
  assert.equal(updateInProgress('downloading', false), true);
  assert.equal(updateInProgress('ready', true), true);
  assert.equal(updateInProgress('applying', false), true);
});
