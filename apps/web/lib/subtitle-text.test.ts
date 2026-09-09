import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { decodeSubtitleBytes, toWebVtt } from './subtitle-text';

test('music notes survive SRT to WebVTT', () => {
  const vtt = toWebVtt(
    "1\n00:01:02,000 --> 00:01:04,000\n♪ Krunk, you sick fuck\nThey're fat enough creature ♪\n",
  );
  assert.match(vtt, /♪ Krunk, you sick fuck/);
  assert.match(vtt, /They're fat enough creature ♪/);
  assert.match(vtt, /00:01:02\.000 --> 00:01:04\.000/);
});

test('UTF-8 music notes are not read as Latin-1', () => {
  assert.equal(decodeSubtitleBytes(new TextEncoder().encode('♪ lyrics ♪')), '♪ lyrics ♪');
});

test('double-encoded music notes are repaired', () => {
  const latin1 = new TextDecoder('windows-1252').decode(new TextEncoder().encode('♪'));
  const twice = new TextDecoder('windows-1252').decode(new TextEncoder().encode(latin1));
  assert.equal(decodeSubtitleBytes(new TextEncoder().encode(latin1)), '♪');
  assert.equal(decodeSubtitleBytes(new TextEncoder().encode(twice)), '♪');
});

test('Windows-1252 curly apostrophes still decode', () => {
  assert.equal(decodeSubtitleBytes(Uint8Array.from([0x54, 0x68, 0x65, 0x79, 0x92, 0x72, 0x65])), 'They’re');
});
