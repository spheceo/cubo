import assert from 'node:assert/strict';
import test from 'node:test';
import { playInBackground, cancelAutoplayUnmute } from './background-playback';

test('autoplay waits for a gesture before unmuting instead of triggering a pause/play loop', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const listeners = new Map<string, () => void>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  } });
  let muted = false;
  let plays = 0;
  let policyPauses = 0;
  let gesture = false;
  const video = {
    isConnected: true,
    ended: false,
    get muted() { return muted; },
    set muted(value: boolean) { muted = value; if (!value && !gesture) policyPauses++; },
    async play() { plays++; if (!muted && !gesture) throw new DOMException('Gesture required', 'NotAllowedError'); },
  } as HTMLVideoElement;
  try {
    await playInBackground(video, () => false, () => {});
    assert.equal(plays, 2);
    assert.equal(video.muted, true);
    assert.equal(policyPauses, 0);
    assert.equal(listeners.size, 2);
    gesture = true;
    listeners.get('pointerdown')!();
    assert.equal(video.muted, false);
    assert.equal(policyPauses, 0);
    assert.equal(listeners.size, 0);
  } finally {
    cancelAutoplayUnmute();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
