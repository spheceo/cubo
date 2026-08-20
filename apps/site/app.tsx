import { useEffect, useState } from 'react';

const RELEASES_BASE = 'https://github.com/spheceo/cubo/releases/latest/download';
const DOWNLOADS = {
  macArm: `${RELEASES_BASE}/cubo-macos-apple-silicon.dmg`,
  macIntel: `${RELEASES_BASE}/cubo-macos-intel.dmg`,
  windows: `${RELEASES_BASE}/cubo-windows-x64-setup.exe`,
};

type Platform = 'mac' | 'windows' | 'other';

function detectPlatform(): Platform {
  const agent = navigator.userAgent;
  if (/Macintosh|Mac OS X/i.test(agent)) return 'mac';
  if (/Windows/i.test(agent)) return 'windows';
  return 'other';
}

/** Purely cosmetic: shows the current version next to the download buttons. */
function useLatestVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('https://api.github.com/repos/spheceo/cubo/releases/latest')
      .then((response) => (response.ok ? response.json() : null))
      .then((release: { tag_name?: string } | null) => {
        if (!cancelled && release?.tag_name) {
          setVersion(release.tag_name.replace(/^v/, ''));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return version;
}

export function App() {
  const [platform] = useState<Platform>(detectPlatform);
  const version = useLatestVersion();

  return (
    <>
      <nav className="nav">
        <span className="logo">
          cubo<span className="accent">.</span>
        </span>
        <div className="nav-links">
          <a href="https://github.com/spheceo/cubo" rel="noreferrer">
            GitHub
          </a>
          <a className="nav-cta" href="https://app.cubo.spheceo.com" rel="noreferrer">
            Open web app
          </a>
        </div>
      </nav>

      <main>
        <section className="hero">
          <p className="eyebrow">Free, open source, yours</p>
          <h1>
            Your movies.
            <br />
            One click away.
          </h1>
          <p className="lede">
            Cubo finds trending films and series and streams them instantly through
            your own hardware. No accounts, no subscriptions — your library and
            viewing history never leave machines you control.
          </p>

          <div className="download-row">
            <DownloadButtons platform={platform} />
          </div>
          <p className="version">
            {version ? `Version ${version} · ` : ''}macOS &amp; Windows · MIT licensed
          </p>
        </section>

        <section className="features">
          <article>
            <h2>Streams in seconds</h2>
            <p>
              Sources are ranked by quality and health, playback starts as the first
              pieces arrive, and if a source fails mid-play Cubo quietly moves to the
              next one from the same position.
            </p>
          </article>
          <article>
            <h2>Plays everything</h2>
            <p>
              A built-in converter (bundled ffmpeg) unlocks high-quality releases the
              browser alone can&rsquo;t play — full seeking included, with automatic
              audio conversion.
            </p>
          </article>
          <article>
            <h2>Your library stays yours</h2>
            <p>
              Progress, watch-later and history live in Cubo Core on your machine.
              Reach it from any device — pair it with Tailscale and your whole
              library follows you.
            </p>
          </article>
        </section>

        <section className="downloads" id="download">
          <h2>Download Cubo</h2>
          <p className="downloads-note">
            Runs on macOS 12+ (Apple Silicon and Intel) and Windows 10+.
          </p>
          <div className="download-grid">
            <a className="card" href={DOWNLOADS.macArm}>
              <span className="card-title">macOS</span>
              <span className="card-sub">Apple Silicon · .dmg</span>
            </a>
            <a className="card" href={DOWNLOADS.macIntel}>
              <span className="card-title">macOS</span>
              <span className="card-sub">Intel · .dmg</span>
            </a>
            <a className="card" href={DOWNLOADS.windows}>
              <span className="card-title">Windows</span>
              <span className="card-sub">64-bit installer · .exe</span>
            </a>
          </div>
          <p className="fine-print">
            Cubo isn&rsquo;t notarized yet: on macOS, right-click the app and choose
            Open the first time; on Windows, choose &ldquo;More info → Run
            anyway&rdquo; if SmartScreen appears. Updates install themselves from
            inside the app.
          </p>
        </section>
      </main>

      <footer>
        <span>&copy; {new Date().getFullYear()} Cubo</span>
        <a href="https://github.com/spheceo/cubo/blob/main/LICENSE" rel="noreferrer">
          MIT License
        </a>
        <a href="https://github.com/spheceo/cubo" rel="noreferrer">
          Source
        </a>
        <a href="https://app.cubo.spheceo.com/legal" rel="noreferrer">
          Legal
        </a>
      </footer>
    </>
  );
}

function DownloadButtons({ platform }: { platform: Platform }) {
  if (platform === 'windows') {
    return (
      <>
        <a className="button primary" href={DOWNLOADS.windows}>
          Download for Windows
        </a>
        <a className="button ghost" href="#download">
          Other platforms
        </a>
      </>
    );
  }
  return (
    <>
      <a className="button primary" href={DOWNLOADS.macArm}>
        Download for Mac
      </a>
      <a className="button ghost" href="#download">
        {platform === 'mac' ? 'Intel Mac or Windows?' : 'All downloads'}
      </a>
    </>
  );
}
