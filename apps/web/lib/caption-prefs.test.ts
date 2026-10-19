import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { preferredSubtitleId, type CaptionPrefs } from './caption-prefs';

const prefs = (language: string | null): CaptionPrefs => ({ enabled: true, language, size: 'medium', color: 'white' });
const tracks = ['ar', 'bg', 'cs', 'da', 'de', 'el', 'eng', 'es'].map((language) => ({ id: language, language }));

test('captions default to English wherever it sits in the list', () => {
  assert.equal(preferredSubtitleId(tracks, prefs(null)), 'eng');
});

test("the viewer's own caption language wins over English", () => {
  assert.equal(preferredSubtitleId(tracks, prefs('de')), 'de');
});

test('a saved language this title lacks falls back to English, then the first track', () => {
  assert.equal(preferredSubtitleId(tracks, prefs('ja')), 'eng');
  assert.equal(preferredSubtitleId(tracks.filter((track) => track.id !== 'eng'), prefs('ja')), 'ar');
});

test('captions off picks nothing', () => {
  assert.equal(preferredSubtitleId(tracks, { ...prefs(null), enabled: false }), null);
});
