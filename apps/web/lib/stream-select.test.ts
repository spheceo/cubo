import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Stream } from '@cubo/core';
import {
  AUTO_PLAY_MAX_BYTES,
  collectionPackRank,
  isAutomaticSource,
  isOversizedStream,
  rankStreams,
  seasonPackRank,
  streamSizeBytes,
} from './stream-select';

const episode = { season: 2, episode: 1 };
const single: Stream = {
  name: 'Torrentio 1080p', title: 'The.Gentlemen.S02E01.1080p',
  filename: 'The.Gentlemen.S02E01.mkv', infoHash: 'single', fileIdx: 0,
  quality: '1080p', sizeBytes: 800_000_000, seeders: 20, trackers: [],
};
const pack: Stream = {
  ...single, infoHash: 'pack', title: 'The.Gentlemen.S02.COMPLETE.1080p',
  sizeBytes: 3_900_000_000, seeders: 100,
};

test('a selected episode filename does not hide explicit season-pack metadata', () => {
  assert.equal(seasonPackRank(pack, episode), 2);
  assert.equal(seasonPackRank(single, episode), 0);
  assert.equal(seasonPackRank({ ...pack, title: 'The Gentlemen Season 2' }, episode), 2);
  assert.equal(seasonPackRank({ ...pack, title: 'The.Gentlemen.S02.1080p' }, episode), 2);
  assert.equal(seasonPackRank({ ...single, title: 'The.Gentlemen.2x01' }, episode), 0);
});

test('single episodes beat larger healthy packs within the same playback tier', () => {
  assert.deepEqual(rankStreams([pack, single], { transcode: true, hevc: false }, null, episode)
    .map((stream) => stream.infoHash), ['single', 'pack']);
});

test('a single-title remux beats a direct-play file inside a pack', () => {
  const directPack = { ...pack, filename: 'The.Gentlemen.S02E01.mp4' };
  assert.equal(
    rankStreams([single, directPack], { transcode: true, hevc: false }, null, episode)[0],
    single,
  );
});

test('direct-play still beats remux for the same kind of release', () => {
  const direct = { ...single, infoHash: 'direct', filename: 'The.Gentlemen.S02E01.mp4' };
  assert.equal(
    rankStreams([single, direct], { transcode: true, hevc: false }, null, episode)[0],
    direct,
  );
});

test('a named dub loses to original-language audio even with a UK flag and direct-play', () => {
  const dubbed = {
    ...single,
    infoHash: 'dublado',
    filename: 'Silo.S01E01.1080p.WEB-DL.mkv.mp4',
    title: 'Silo.S01E01-02.1080p.WEB-DL.DUBLADO\n🇬🇧 / 🇵🇹',
    seeders: 59,
  };
  const original = {
    ...single,
    infoHash: 'english',
    filename: 'Silo.S01E01.1080p.mkv',
    title: 'Silo S01E01 1080p WEB-DL\n🇬🇧 / 🇯🇵 / 🇷🇺',
    seeders: 20,
  };
  const ranked = rankStreams(
    [dubbed, original],
    { transcode: true, hevc: false },
    'en',
    { season: 1, episode: 1 },
  );
  assert.equal(ranked[0].infoHash, 'english');
});

test('movie ranking has no episode pack preference', () => {
  assert.equal(seasonPackRank(pack), 0);
});

test('a UK flag beside other flags does not beat a flagless direct-play file', () => {
  const yts: Stream = {
    ...single,
    infoHash: 'yts',
    filename: 'Black Panther (2018) [BluRay] [YTS.AM].mp4',
    title: 'Black Panther (2018) [BluRay] [1080p] [YTS.AM]\n👤 80 💾 2.11 GB ⚙️ YTS',
    seeders: 80,
    sizeBytes: null,
  };
  const collection: Stream = {
    ...single,
    infoHash: 'mcu-pack',
    filename: 'Black Panther BD1080.www.pctnew.org.mkv',
    title:
      'Marvel Coleccion Volumen 4 [BluRay 1080p][DTS 5.1-AC3 5.1 Castellano DTS 5.1-Ingles+Subs][ES-EN]\nBlack Panther BD1080.www.pctnew.org.mkv\n👤 78 💾 16.27 GB ⚙️ Wolfmax4k\n🇬🇧 / 🇪🇸',
    seeders: 78,
    sizeBytes: null,
  };
  const saga: Stream = {
    ...single,
    infoHash: 'saga',
    filename: '18.Black Panther (2018) IMAX 1080p.mkv',
    title:
      'Marvel Cinematic Universe (2008-2025) Phase I-II-III-IV-V-VI 1080p 10bit IMAX\n👤 14 💾 5.66 GB ⚙️ 1337x\nMulti Subs / 🇬🇧 / 🇮🇳',
    seeders: 14,
    sizeBytes: null,
  };
  assert.equal(collectionPackRank(collection), 2);
  assert.equal(collectionPackRank(saga), 2);
  assert.equal(collectionPackRank(yts), 0);
  assert.ok(streamSizeBytes(collection) > 16 * 1024 * 1024 * 1024);
  const ranked = rankStreams([collection, saga, yts], { transcode: true, hevc: true }, 'en');
  assert.deepEqual(ranked.map((stream) => stream.infoHash), ['yts', 'saga', 'mcu-pack']);
});

test('year ranges with "to" and anthology names count as collection packs', () => {
  const marvelFilms: Stream = {
    ...single,
    infoHash: 'marvel-films',
    filename: 'M18 Black Panther (2018) 1080p.mp4',
    title:
      'Marvel Films (2008 to 2021) Iron Man Thor Avengers - Mp4 1080p\nM18 Black Panther (2018) 1080p.mp4\n👤 56 💾 2.72 GB ⚙️ 1337x',
    seeders: 56,
    sizeBytes: 2_920_577_761,
  };
  const greatFilms: Stream = {
    ...single,
    infoHash: 'great-films',
    filename: 'Black Panther (2018) 1080p Surround.mp4',
    title: 'Great Films 6: MP4 X264 AC3 1080p\nBlack Panther (2018) 1080p Surround.mp4\n👤 477 💾 3 GB ⚙️ MagnetDL',
    seeders: 477,
    sizeBytes: 3_221_225_472,
  };
  const brrip: Stream = {
    ...single,
    infoHash: 'brrip',
    filename: 'Black.Panther.2018.1080p.BRRip.x264-BRRIP.mkv',
    title: 'Black.Panther.2018.1080p.BRRip.x264-BRRIP\n👤 100 💾 2.17 GB ⚙️ ThePirateBay',
    seeders: 100,
    sizeBytes: 2_330_019_758,
  };
  assert.equal(collectionPackRank(marvelFilms), 2);
  assert.equal(collectionPackRank(greatFilms), 2);
  assert.equal(collectionPackRank(brrip), 0);
  const ranked = rankStreams(
    [marvelFilms, greatFilms, brrip],
    { transcode: true, hevc: true },
    'en',
  );
  assert.equal(ranked[0].infoHash, 'brrip');
});

test('a 30 GB remux loses to a normal-sized rip and is not auto-playable', () => {
  const remux: Stream = {
    ...single,
    infoHash: 'huge',
    filename: 'Black.Panther.2018.1080p.BluRay.REMUX.mkv',
    title: 'Black.Panther.2018.1080p.BluRay.REMUX.AVC.DTS-HD.MA.7.1-FGT\n👤 33 💾 30.06 GB ⚙️ RARBG',
    seeders: 33,
    sizeBytes: 32_276_679_229,
  };
  const rip: Stream = {
    ...single,
    infoHash: 'rip',
    filename: 'Black.Panther.2018.1080p.BluRay.x264.mkv',
    title: 'Black.Panther.2018.REPACK.1080p.BluRay.x264.MkvCage\n👤 89 💾 3.34 GB ⚙️ ThePirateBay',
    seeders: 89,
    sizeBytes: 3_586_297_692,
  };
  assert.ok(remux.sizeBytes! > AUTO_PLAY_MAX_BYTES);
  assert.equal(isOversizedStream(remux), true);
  assert.equal(isOversizedStream(rip), false);
  const ranked = rankStreams([remux, rip], { transcode: true, hevc: true }, 'en');
  assert.deepEqual(ranked.map((stream) => stream.infoHash), ['rip', 'huge']);
});

// Release names below are verbatim from Torrentio results for Silo S03.
const silo = { ...single, quality: '1080p', trackers: [] };
const hdrezkaDub: Stream = {
  ...silo,
  infoHash: 'hdrezka',
  name: 'Torrentio\nWEB-DL',
  filename: 'Silo.S03E09.HDrS.WEB-DLRip.mp4',
  title:
    'Укрытие / Бункер / Silo [S01-03] (2023-2026) WEB-DLRip-AVC | КПК | HDrezka Studio\nSilo.S03/Silo.S03E09.HDrS.WEB-DLRip.mp4\n👤 19 💾 286.73 MB ⚙️ Rutor\n🇬🇧 / 🇷🇺',
};
const chineseHardsub: Stream = {
  ...silo,
  infoHash: 'dyg7',
  filename: '末日地堡.Silo.S03E08.Gray.Goo.1080p.HD中英双字[最新电影www.dyg7.com].mp4',
  title: 'Silo.S03E08.6v\n👤 8 💾 902.9 MB ⚙️ EXT',
};
const englishCzech: Stream = {
  ...silo,
  infoHash: 'english',
  filename: 'Silo_S03E09_Rozloučení.mkv',
  title: 'Silo S03E09 (EN)[1080p][WEB-DL][HEVC]\n👤 75 💾 2.29 GB ⚙️ EXT\n🇬🇧 / 🇨🇿 / 🇸🇰',
};
const russianWithOriginal: Stream = {
  ...silo,
  infoHash: 'lostfilm',
  filename: 'Silo.S03E09.1080p.WEB-DL.LostFilm.Eng.mkv',
  title:
    'Укрытие / Бункер / Silo / Сезон: 3 / Серии: 1-10 из 10 [2026 WEB-DL 1080p] MVO (LostFilm) + Original + Sub (Rus Eng)\nSilo.S03E09.1080p.WEB-DL.LostFilm.Eng.mkv\n👤 84 💾 4.99 GB ⚙️ Rutracker\n🇬🇧 / 🇷🇺',
};

test('a Russian voice-over release is a dub even with a UK flag', () => {
  assert.equal(isAutomaticSource(hdrezkaDub, 'en'), false);
  // ...but it is exactly right for a Russian original.
  assert.equal(isAutomaticSource(hdrezkaDub, 'ru'), true);
});

test('Chinese burned-in caption rips never auto-play', () => {
  assert.equal(isAutomaticSource(chineseHardsub, 'en'), false);
  assert.equal(isAutomaticSource(chineseHardsub, 'zh'), false);
});

test('a foreign pack that carries the original track stays eligible, below clean releases', () => {
  assert.equal(isAutomaticSource(russianWithOriginal, 'en'), true);
  const ranked = rankStreams(
    [russianWithOriginal, hdrezkaDub, englishCzech],
    { transcode: true, hevc: true },
    'en',
    { season: 3, episode: 9 },
  ).filter((stream) => isAutomaticSource(stream, 'en'));
  assert.deepEqual(ranked.map((stream) => stream.infoHash), ['english', 'lostfilm']);
});

test('3D side-by-side releases never win the auto-pick', () => {
  const sbs: Stream = {
    name: 'Torrentio\n1080p 3D SBS',
    title:
      'Severance.S01.1080p.3D.FULL-SBS.HEVC.SBS-SUB.ENG.iFA-AI3D\nSeverance.S01E01.Good.News.About.Hell.1080p.3D.FULL-SBS.HEVC.SBS-SUB.ENG.iFA-AI3D.mkv\n👤 5 💾 3.3 GB ⚙️ 1337x',
    infoHash: 'sbs',
    fileIdx: 2,
    filename: 'Severance.S01E01.Good.News.About.Hell.1080p.3D.FULL-SBS.HEVC.SBS-SUB.ENG.iFA-AI3D.mkv',
    quality: '1080p',
    seeders: 5,
    sizeBytes: 3543348019,
    trackers: [],
  };
  const halfOu: Stream = {
    ...sbs,
    infoHash: 'hou',
    name: 'Torrentio\n1080p',
    title: 'Severance S01E01 1080p H-OU x264\n👤 30 💾 3 GB',
    filename: 'Severance.S01E01.1080p.H-OU.mkv',
  };
  const flat: Stream = {
    ...sbs,
    infoHash: 'flat',
    name: 'Torrentio\n1080p',
    title: 'Severance S01E01 Good News About Hell 1080p BluRay 10Bit DDP5 1 H265-d3g\n👤 106 💾 2.43 GB ⚙️ ThePirateBay',
    filename: 'Severance S01E01 Good News About Hell 1080p BluRay 10Bit DDP5 1 H265-d3g.mkv',
    seeders: 106,
    sizeBytes: 2609192632,
  };

  assert.equal(isAutomaticSource(sbs, 'en'), false);
  assert.equal(isAutomaticSource(halfOu, 'en'), false);
  assert.equal(isAutomaticSource(flat, 'en'), true);
  const ranked = rankStreams([sbs, halfOu, flat], { transcode: true, hevc: true }, 'en', {
    season: 1,
    episode: 1,
  });
  assert.equal(ranked[0].infoHash, 'flat');
});

test('English dub mode prefers releases that carry English audio for a German original', () => {
  const release = (infoHash: string, title: string, seeders = 20): Stream => ({
    name: 'Torrentio\n1080p', title, filename: `${infoHash}.S01E01.mkv`, infoHash, fileIdx: 0, quality: '1080p',
    sizeBytes: 1_000_000_000, seeders, trackers: [],
  });
  // Real Torrentio titles for Dark S01E01.
  const germanOnly = release('qxr', 'Dark (2017) Season 1-3 S01-S03 (1080p NF WEB-DL x265 HEVC 10bit EAC3 5.1 German Ghost) [QxR]\n🇩🇪', 192);
  const gerEng = release('psa', 'Dark.S01.COMPLETE.DUAL-AUDIO.GER-ENG.1080p.10bit.WEBRip.6CH.x265\nDual Audio / 🇬🇧 / 🇩🇪', 383);
  const bareDual = release('kontrast', 'Dark.S01.DUAL.1080p.WEBRip.x265-KONTRAST\nDual Audio / 🇩🇪', 46);
  const englishSubs = release('budget', 'Dark COMPLETE S01 S02 S03 (EN subs) 720p.10bit.WEBRip.x265-budgetbits\n🇬🇧 / 🇩🇪');
  const germanWithSubFlag = release('garshasp', 'Dark (2017) Season 1 S01 (1080p NF WEB-DL x265 HEVC 10bit EAC3 5.1 German Garshasp)\n🇬🇧 / 🇩🇪');
  const frenchMulti = release('btt', 'Dark.COMPLETE.MULTi.1080p.NF.WEB.DDP.5.1.AV1-BTT\nMulti Audio / 🇫🇷');
  const russian = release('rutracker', 'Тьма / Dark MVO (LostFilm) + Original + Sub (Rus Eng)\n🇬🇧 / 🇷🇺 / 🇩🇪');
  const dub = { dub: 'en', original: 'de' };

  for (const stream of [germanOnly, englishSubs, germanWithSubFlag, frenchMulti, russian]) {
    assert.equal(isAutomaticSource(stream, dub), false, stream.infoHash);
  }
  assert.equal(isAutomaticSource(gerEng, dub), true);
  assert.equal(isAutomaticSource(bareDual, dub), true);
  const ranked = rankStreams(
    [germanOnly, bareDual, gerEng, englishSubs],
    { transcode: true, hevc: true },
    dub,
  ).filter((stream) => isAutomaticSource(stream, dub));
  assert.deepEqual(ranked.map((stream) => stream.infoHash), ['psa', 'kontrast']);

  // The original choice keeps today's order: the German-only release wins.
  assert.equal(rankStreams([gerEng, germanOnly], { transcode: true, hevc: true }, 'de')[0].infoHash, 'qxr');
});
