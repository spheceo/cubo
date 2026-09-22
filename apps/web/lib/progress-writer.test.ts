import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { PlaybackUpdate } from './local-engine';
import { ProgressWriter } from './progress-writer';

function update(positionSeconds: number): PlaybackUpdate {
  return {
    key: 'movie:1', mediaId: 1, mediaType: 'movie', imdbId: null,
    title: 'Movie', subtitle: null, posterPath: null, backdropPath: null,
    logoPath: null, season: null, episode: null, positionSeconds,
    durationSeconds: 3600, watchedDeltaSeconds: 1, sessionStarted: false,
    watchHref: '/watch/movie/1', detailHref: '/movie/1',
  };
}

test('rapid seeks send the newest position after the in-flight write, without losing watch time', async () => {
  const sent: PlaybackUpdate[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writer = new ProgressWriter(async (value) => {
    sent.push(value);
    if (sent.length === 1) await gate;
  });
  void writer.enqueue(update(1800));
  void writer.enqueue({ ...update(900), sessionStarted: true });
  const drained = writer.enqueue(update(120));
  assert.deepEqual(sent.map((value) => value.positionSeconds), [1800]);
  release();
  await drained;
  assert.deepEqual(sent.map((value) => value.positionSeconds), [1800, 120]);
  assert.equal(sent[1]?.watchedDeltaSeconds, 2);
  assert.equal(sent[1]?.sessionStarted, true);
});

test('whenIdle waits for a write that started after the previous drain', async () => {
  const sent: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writer = new ProgressWriter(async (value) => {
    sent.push(value.positionSeconds);
    if (value.positionSeconds === 20) await gate;
  });
  await writer.enqueue(update(10));
  const follow = writer.enqueue(update(20));
  let idleDone = false;
  void writer.whenIdle().then(() => {
    idleDone = true;
  });
  await Promise.resolve();
  assert.equal(idleDone, false);
  release();
  await follow;
  await writer.whenIdle();
  assert.equal(idleDone, true);
  assert.deepEqual(sent, [10, 20]);
});

test('a failed request does not poison later progress saves', async () => {
  const sent: number[] = [];
  const writer = new ProgressWriter(async (value) => {
    sent.push(value.positionSeconds);
    if (sent.length === 1) throw new Error('Core disconnected');
  });
  await writer.enqueue(update(1800));
  await writer.enqueue(update(600));
  assert.deepEqual(sent, [1800, 600]);
});
