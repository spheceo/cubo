import assert from 'node:assert/strict';
import test from 'node:test';
import { cuboPlayerLink } from './cubo-player';
import type { LocalEngineConnection } from './local-engine';

const connection: LocalEngineConnection = {
  baseUrl: 'http://kenobi:8765',
  port: 8765,
  token: 't/k+n',
  version: '0.0.43',
  transcode: true,
  sessions: true,
  nativePlayer: true,
};

test('cuboPlayerLink carries the Core, the source and a decodable progress template', () => {
    const link = cuboPlayerLink(connection, {
      magnet: 'magnet:?xt=urn:btih:83b1ef08&dn=The Traitors',
      fileIndex: 0,
      mediaKey: 'tv:291431:2:10',
      title: 'The Celebrity Traitors',
      startSeconds: 2500.7,
      audioLanguage: 'en',
      progress: {
        key: 'tv:291431:2:10',
        mediaId: 291431,
        mediaType: 'tv',
        imdbId: null,
        title: 'The Celebrity Traitors — é',
        subtitle: 'S2 E10',
        posterPath: null,
        backdropPath: null,
        logoPath: null,
        season: 2,
        episode: 10,
        watchHref: '/watch/tv/291431?season=2&episode=10',
        detailHref: '/tv/291431',
      },
    });
    assert.ok(link.startsWith('cubo-player://play?'));
    const params = new URLSearchParams(link.slice('cubo-player://play?'.length));
    assert.equal(params.get('core'), 'http://kenobi:8765');
    assert.equal(params.get('token'), 't/k+n');
    assert.equal(params.get('magnet'), 'magnet:?xt=urn:btih:83b1ef08&dn=The Traitors');
    assert.equal(params.get('start'), '2500');
    const raw = params.get('progress')!.replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(raw), (char) => char.charCodeAt(0)));
    assert.equal(JSON.parse(json).title, 'The Celebrity Traitors — é');
  });
