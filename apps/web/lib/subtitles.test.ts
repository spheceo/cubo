import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseSubtitleCues } from './subtitles';

test('ASS override tags are stripped from cue text', () => {
  const [cue] = parseSubtitleCues(
    "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n{\\an8}wrong, and I'm starting to realise\\Nhow difficult {\\i1}this{\\i0} game is.\n",
  );
  assert.equal(cue?.text, "wrong, and I'm starting to realise\nhow difficult this game is.");
});

test('ASS \\anN placement is kept on the cue', () => {
  const cues = parseSubtitleCues(
    'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n{\\an8}top line\n\n00:00:03.000 --> 00:00:04.000\n{\\an2}bottom line\n\n00:00:05.000 --> 00:00:06.000\nplain line\n',
  );
  assert.equal(cues[0]?.align, 8);
  assert.equal(cues[1]?.align, undefined);
  assert.equal(cues[2]?.align, undefined);
});
