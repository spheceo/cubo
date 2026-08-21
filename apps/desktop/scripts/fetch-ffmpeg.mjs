#!/usr/bin/env node
/**
 * Downloads static ffmpeg + ffprobe builds into src-tauri/binaries/ with the
 * target-triple names Tauri's externalBin (sidecar) bundling expects, e.g.
 * ffmpeg-aarch64-apple-darwin. Run before `tauri build`:
 *
 *   node apps/desktop/scripts/fetch-ffmpeg.mjs [--target <triple>]
 *
 * Without --target the host platform's triple is used. Existing binaries are
 * kept, so repeated runs are free.
 *
 * Every download is PINNED to an exact upstream build and VERIFIED against a
 * SHA-256 recorded below — a compromised or hijacked download server cannot
 * slip a different binary into a Cubo release. To upgrade ffmpeg: pick the
 * new upstream build, download it, compute `shasum -a 256`, and update the
 * URL + hash pairs together.
 *
 * Note: these static builds are GPL-licensed; they ship alongside Cubo as
 * separate executables (invoked as subprocesses, never linked), which keeps
 * Cubo itself MIT.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// macOS: Martin Riedl's signed release builds (ffmpeg 9.0.1).
const RIEDL = 'https://ffmpeg.martin-riedl.de/download/macos';
// Windows + Linux: BtbN autobuild, pinned tag, ffmpeg release branch 9.0.
const BTBN_TAG = 'autobuild-2026-08-21-13-40';
const BTBN_BUILD = 'n9.0.1-6-g9d4ca21220';
const BTBN = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${BTBN_TAG}`;

/** Per-triple pinned sources. `riedl` entries are one zip per tool; `btbn`
 *  entries are one bundle holding both tools under `<bundleDir>/bin/`. */
const SOURCES = {
  'aarch64-apple-darwin': {
    kind: 'riedl',
    urls: {
      ffmpeg: `${RIEDL}/arm64/1787073674_9.0.1/ffmpeg.zip`,
      ffprobe: `${RIEDL}/arm64/1787073674_9.0.1/ffprobe.zip`,
    },
    sha256: {
      ffmpeg: '8287a1b2229e05eb41859f073e18e6c52c60a778f2f5e6881070fe51b79407fe',
      ffprobe: '102a26b8940a053298d9929bfaae71e4b6ef65ba5f19a99a88c433108560741a',
    },
  },
  'x86_64-apple-darwin': {
    kind: 'riedl',
    urls: {
      ffmpeg: `${RIEDL}/amd64/1787081194_9.0.1/ffmpeg.zip`,
      ffprobe: `${RIEDL}/amd64/1787081194_9.0.1/ffprobe.zip`,
    },
    sha256: {
      ffmpeg: '5bdead62ff504ab9b447cc72b212c4fb481e3f7de5877d427a51bee8136dda40',
      ffprobe: '34511bbcf1988ad2886023bf5ace4f44cf62e6defeb3d194d6f7619e5b061f7f',
    },
  },
  'x86_64-pc-windows-msvc': {
    kind: 'btbn',
    url: `${BTBN}/ffmpeg-${BTBN_BUILD}-win64-gpl-9.0.zip`,
    sha256: '6c0a3c1256cba57c62a3bb012c1e8f5e794d38a16c6509d05349237d2b66340f',
    bundleDir: `ffmpeg-${BTBN_BUILD}-win64-gpl-9.0`,
  },
  'x86_64-unknown-linux-gnu': {
    kind: 'btbn',
    url: `${BTBN}/ffmpeg-${BTBN_BUILD}-linux64-gpl-9.0.tar.xz`,
    sha256: 'da7c861c44cc6f92fff7f3f6aefb47690e3e88702826d06fbf9ac592a5f24083',
    bundleDir: `ffmpeg-${BTBN_BUILD}-linux64-gpl-9.0`,
  },
  'aarch64-unknown-linux-gnu': {
    kind: 'btbn',
    url: `${BTBN}/ffmpeg-${BTBN_BUILD}-linuxarm64-gpl-9.0.tar.xz`,
    sha256: '2ab19e7bff6824318df73f759906e13b64d05176654a01e486143296f0f6cbe2',
    bundleDir: `ffmpeg-${BTBN_BUILD}-linuxarm64-gpl-9.0`,
  },
};

function hostTriple() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  if (process.platform === 'win32') return 'x86_64-pc-windows-msvc';
  if (process.platform === 'linux') {
    return process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  }
  throw new Error(`Unsupported host platform: ${process.platform}`);
}

async function download(url, destination, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
      return;
    } catch (error) {
      if (attempt === attempts) throw new Error(`Failed to download ${url}: ${error}`);
      console.warn(`Retrying ${url} (attempt ${attempt} failed)`);
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    }
  }
}

/** Refuses to use a download whose contents differ from the pinned hash. */
async function verify(archive, expectedSha256, label) {
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  if (digest !== expectedSha256) {
    throw new Error(
      `Checksum mismatch for ${label}: expected ${expectedSha256}, got ${digest}. ` +
        `The upstream file changed — refusing to package it.`,
    );
  }
}

/** bsdtar (preinstalled on macOS and Windows runners) extracts zips too;
 *  GNU tar on Linux runners handles .tar.xz. */
function extract(archive, into) {
  execFileSync('tar', ['-xf', archive, '-C', into]);
}

async function main() {
  const targetFlag = process.argv.indexOf('--target');
  const triple = targetFlag !== -1 ? process.argv[targetFlag + 1] : hostTriple();
  const source = SOURCES[triple];
  if (!source) throw new Error(`No ffmpeg source configured for target ${triple}`);

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const binariesDir = path.join(scriptDir, '..', 'src-tauri', 'binaries');
  await mkdir(binariesDir, { recursive: true });

  const extension = triple.includes('windows') ? '.exe' : '';
  const targets = {
    ffmpeg: path.join(binariesDir, `ffmpeg-${triple}${extension}`),
    ffprobe: path.join(binariesDir, `ffprobe-${triple}${extension}`),
  };
  if (existsSync(targets.ffmpeg) && existsSync(targets.ffprobe)) {
    console.log(`ffmpeg sidecars for ${triple} already present`);
    return;
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'cubo-ffmpeg-'));
  try {
    if (source.kind === 'riedl') {
      for (const tool of ['ffmpeg', 'ffprobe']) {
        const archive = path.join(workDir, `${tool}.zip`);
        console.log(`Downloading ${tool} for ${triple}…`);
        await download(source.urls[tool], archive);
        await verify(archive, source.sha256[tool], `${tool} (${triple})`);
        extract(archive, workDir);
        await cp(path.join(workDir, tool), targets[tool]);
        await chmod(targets[tool], 0o755);
      }
    } else {
      const archive = path.join(workDir, path.basename(source.url));
      console.log(`Downloading ffmpeg bundle for ${triple}…`);
      await download(source.url, archive);
      await verify(archive, source.sha256, `ffmpeg bundle (${triple})`);
      extract(archive, workDir);
      const bundleBin = path.join(workDir, source.bundleDir, 'bin');
      await cp(path.join(bundleBin, `ffmpeg${extension}`), targets.ffmpeg);
      await cp(path.join(bundleBin, `ffprobe${extension}`), targets.ffprobe);
      if (!extension) {
        await chmod(targets.ffmpeg, 0o755);
        await chmod(targets.ffprobe, 0o755);
      }
    }
    console.log(`ffmpeg sidecars ready in ${binariesDir}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
