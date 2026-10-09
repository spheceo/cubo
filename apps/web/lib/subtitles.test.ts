import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseSubtitleCues } from './subtitles';

test('ASS override tags are stripped from cue text', () => {
  const [cue] = parseSubtitleCues(
    "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n{\\an8}wrong, and I'm starting to realise\\Nhow difficult {\\i1}this{\\i0} game is.\n",
  );
  assert.equal(cue?.text, "wrong, and I'm starting to realise\nhow difficult this game is.");
});
