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
 * Note: the macOS/Windows static builds are GPL-licensed; they ship alongside
 * Cubo as separate executables (invoked as subprocesses, never linked), which
 * keeps Cubo itself MIT.
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const RIEDL = 'https://ffmpeg.martin-riedl.de/redirect/latest/macos';
const BTBN =
  'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';

/** Per-triple source layout: each entry yields ffmpeg + ffprobe binaries. */
const SOURCES = {
  'aarch64-apple-darwin': {
    kind: 'riedl',
    urls: { ffmpeg: `${RIEDL}/arm64/release/ffmpeg.zip`, ffprobe: `${RIEDL}/arm64/release/ffprobe.zip` },
  },
  'x86_64-apple-darwin': {
    kind: 'riedl',
    urls: { ffmpeg: `${RIEDL}/amd64/release/ffmpeg.zip`, ffprobe: `${RIEDL}/amd64/release/ffprobe.zip` },
  },
  'x86_64-pc-windows-msvc': { kind: 'btbn', url: BTBN },
};

function hostTriple() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  if (process.platform === 'win32') return 'x86_64-pc-windows-msvc';
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

/** bsdtar (preinstalled on macOS and Windows runners) extracts zips too. */
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
        extract(archive, workDir);
        await cp(path.join(workDir, tool), targets[tool]);
        await chmod(targets[tool], 0o755);
      }
    } else {
      const archive = path.join(workDir, 'ffmpeg.zip');
      console.log(`Downloading ffmpeg bundle for ${triple}…`);
      await download(source.url, archive);
      extract(archive, workDir);
      const bundleBin = path.join(workDir, 'ffmpeg-master-latest-win64-gpl', 'bin');
      await cp(path.join(bundleBin, 'ffmpeg.exe'), targets.ffmpeg);
      await cp(path.join(bundleBin, 'ffprobe.exe'), targets.ffprobe);
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
