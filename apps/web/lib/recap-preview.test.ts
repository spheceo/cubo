import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { detectRecapPreview, recapWindow, withRecapPreview } from './recap-preview';
import type { SubtitleCue } from './subtitles';

const cue = (start: number, end: number, text: string): SubtitleCue => ({ start, end, text });

// The Traitors S02E03 as subtitled: warning, narrated recap, titles,
// episode, then the teaser after the closing song.
const traitors: SubtitleCue[] = [
  cue(2.0, 3.96, 'This programme contains some strong language.'),
  cue(3.96, 5.16, '<font color="#ffffff">Previously on The Traitors -</font>'),
  cue(5.16, 7.88, '22 players arrived at this Scottish castle'),
  cue(7.88, 38.12, 'to play the ultimate murder mystery game...'),
  cue(39.52, 61.32, 'With the Traitors only getting stronger...'),
  cue(62.56, 89.8, 'The Faithful tried to work out who was a Traitor.'),
  cue(89.8, 91.92, 'This is The Traitors.'),
  cue(112.92, 115.88, 'This decision that we make tonight is a very important decision,'),
  cue(1739.32, 1742.04, 'and the next time I see you, it\'ll be at the Round Table.'),
  cue(3438.96, 3441.28, '# Blindside... #'),
  cue(3443.28, 3445.96, '<font color="#ffffff">Coming soon on the Traitors...</font>'),
  cue(3445.96, 3448.12, 'Are you ready to rob some graves?'),
];

test('narrated recap runs from the lead-in to the pause before the titles', () => {
  const found = detectRecapPreview(traitors, 3493);
  assert.deepEqual(found.recap, { start: 3.96, end: 91.92, source: 'subtitles' });
  assert.deepEqual(found.preview, { start: 3443.28, end: null, source: 'subtitles' });
});

test('a known intro cuts the recap short where the titles begin', () => {
  const found = detectRecapPreview(traitors, 3493, { start: 88, end: 110 });
  assert.equal(found.recap?.end, 88);
});

test('dialogue that merely mentions next time is not a preview', () => {
  const found = detectRecapPreview(traitors.slice(0, 9), 1800);
  assert.equal(found.preview, null);
});

test('no lead-in, no recap; a recap that never pauses is not trusted', () => {
  assert.equal(detectRecapPreview(traitors.filter((entry) => !/Previously/.test(entry.text)), 3493).recap, null);
  const endless = [cue(3, 5, 'Previously on Show...'), ...Array.from({ length: 200 }, (_, i) => cue(5 + i * 2, 7 + i * 2, 'talk'))];
  assert.equal(detectRecapPreview(endless, 3000).recap, null);
});

test('the preview opens the credits prompt and both become timeline sections', () => {
  const merged = withRecapPreview(
    { intro: null, credits: { start: 3480, end: null }, sections: [] },
    detectRecapPreview(traitors, 3493),
  );
  assert.equal(merged?.credits?.start, 3443.28);
  assert.deepEqual(merged?.sections.map((section) => section.kind), ['recap', 'preview']);
  assert.deepEqual(recapWindow(merged), { start: 3.96, end: 91.92, source: 'subtitles' });
});

test('Core sections win over subtitle guesses', () => {
  const merged = withRecapPreview(
    { intro: null, credits: null, sections: [{ start: 0, end: 60, kind: 'recap', label: 'Recap', source: 'theintrodb' }] },
    detectRecapPreview(traitors, 3493),
  );
  assert.deepEqual(recapWindow(merged), { start: 0, end: 60, source: 'theintrodb' });
});
