import { useEffect, useState, type ReactNode } from 'react';
import {
  FALLBACK_LEGAL,
  fetchPublishedLegal,
  legalDocFrom,
  splitInlineMarkdown,
  type LegalDoc,
} from '../../legal';

const RELEASES_BASE = 'https://github.com/spheceo/cubo/releases/latest/download';
const DOWNLOADS = {
  macArm: `${RELEASES_BASE}/cubo-macos-apple-silicon.dmg`,
  macIntel: `${RELEASES_BASE}/cubo-macos-intel.dmg`,
  windows: `${RELEASES_BASE}/cubo-windows-x64-setup.exe`,
};

const TMDB = 'https://image.tmdb.org/t/p';

/** Curated stills for the marketing collage — visual only, not a catalog.
 *  Every path is curl-verified against image.tmdb.org (dead TMDB paths 404
 *  silently and leave holes in the collage). */
const STILLS = [
  `${TMDB}/w780/rAiYTfKGqDCRIIqo664sY9XZIvQ.jpg`,
  `${TMDB}/w780/8sSKdEmlmqF4kJUd28SqthXC4yZ.jpg`,
  `${TMDB}/w780/7iwUUcKURMT7aKfCwMy6YnGtchD.jpg`,
  `${TMDB}/w780/jUdV706J4d3nUEbfimqVnGZqTbW.jpg`,
  `${TMDB}/w780/r57L2UBLPKcHdZQYg8tagv9XqK2.jpg`,
  `${TMDB}/w780/kkcwhgSFd81QDlXo8ytrpHPQjhy.jpg`,
  `${TMDB}/w780/rZfmzpixLKLR3Hg2u0WgC7XLFl8.jpg`,
  `${TMDB}/w780/b9q9VmbXDvJmTziRqkwdEmFdwhr.jpg`,
  `${TMDB}/w780/flxau5Iu7bChQHsESqvGZ3FQRaI.jpg`,
  `${TMDB}/w780/s4v0UX1anfXm0UvloLsTTJ4v222.jpg`,
  `${TMDB}/w780/vJb3fniB8E0JnSMr1tDyIsb6gPi.jpg`,
  `${TMDB}/w780/hD8y787ciNWQ2bn396YrSsOIzdN.jpg`,
];

type Platform = 'mac' | 'windows' | 'other';

const PLATFORM_LABEL: Record<Platform, string> = {
  mac: 'macOS',
  windows: 'Windows',
  other: 'Linux',
};

const INSTALL_COMMANDS = {
  mac: 'curl -fsSL https://cubo.spheceo.com/install.sh | sh',
  other: 'curl -fsSL https://cubo.spheceo.com/install.sh | sh',
  windows: 'irm https://cubo.spheceo.com/install.ps1 | iex',
} as const;

function detectPlatform(): Platform {
  const agent = navigator.userAgent;
  if (/Macintosh|Mac OS X/i.test(agent)) return 'mac';
  if (/Windows/i.test(agent)) return 'windows';
  return 'other';
}

/** Purely cosmetic: shows the current version next to calls to action. */
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

/** Path-based router: '/', '/downloads', '/legal'. */
function useRoute(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onChange = () => {
      setPath(window.location.pathname);
      window.scrollTo(0, 0);
    };
    window.addEventListener('popstate', onChange);
    return () => window.removeEventListener('popstate', onChange);
  }, []);
  return path.replace(/\/+$/, '') || '/';
}

/** Client-side navigation that keeps the URL bar honest. */
function navigate(to: string): void {
  if (window.location.pathname === to) return;
  window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function App() {
  const [platform] = useState<Platform>(detectPlatform);
  const version = useLatestVersion();
  const route = useRoute();

  const page =
    route === '/downloads' ? (
      <DownloadPage version={version} platform={platform} />
    ) : route === '/legal' ? (
      <LegalPage />
    ) : (
      <HomePage platform={platform} version={version} />
    );

  return (
    <>
      <nav className="nav">
        <a
          href="/"
          className="logo"
          aria-label="cubo"
          onClick={(event) => {
            event.preventDefault();
            navigate('/');
          }}
        >
          <CuboMark />
          cubo
        </a>
        <div className="nav-links">
          <a href="https://github.com/spheceo/cubo" rel="noreferrer">
            GitHub
          </a>
          <a
            href="/downloads"
            onClick={(event) => {
              event.preventDefault();
              navigate('/downloads');
            }}
          >
            Download
          </a>
          <a className="nav-cta" href="https://app.cubo.spheceo.com" rel="noreferrer">
            Open web app
          </a>
        </div>
      </nav>

      {page}
    </>
  );
}

function HomePage({
  platform,
  version,
}: {
  platform: Platform;
  version: string | null;
}) {
  return (
    <>
      <header className="hero" id="top">
        <div className="still-wall" aria-hidden="true">
          {STILLS.map((src) => (
            <img key={src} src={src} alt="" />
          ))}
        </div>
        <div className="hero-shade" />
        <div className="hero-copy">
          <p className="eyebrow">Free · Open source · Self-hosted</p>
          <h1>
            One command.
            <br />
            Your media server.
          </h1>
          <p className="lede">
            Cubo Core turns a machine you already own into a private streaming
            server. Install it, open any device, press play — no accounts, no
            subscriptions, nothing leaves your hardware.
          </p>

          <InstallCore platform={platform} />

          <p className="version">
            {version ? `Version ${version} · ` : ''}macOS, Linux &amp; Windows · MIT licensed
          </p>
        </div>
      </header>

      <main>
        <section className="strip" aria-hidden="true">
          <div className="strip-track">
            {[...STILLS, ...STILLS].map((src, index) => (
              <img key={`strip-${index}`} src={src} alt="" />
            ))}
          </div>
        </section>

        <section className="steps">
          <Step
            num="01"
            title="Install Core"
            body="One command puts the engine on your machine — bundled ffmpeg and auto-updates included."
          />
          <Step
            num="02"
            title="Open any device"
            body="The web app finds Core automatically — phone, tablet, laptop, anything with a browser."
          />
          <Step
            num="03"
            title="Press play"
            body="Media from the sources you connect starts streaming from your hardware in seconds. That's the whole ritual."
          />
        </section>

        <section className="showcase">
          <div className="showcase-copy">
            <p className="eyebrow">Cubo Core</p>
            <h2>
              Your hardware.
              <br />
              Your rules.
            </h2>
            <p className="showcase-lede">
              A quiet background process on a machine you already own &mdash;
              then it stays out of the way.
            </p>
          </div>

          <ul className="spec-list">
            <SpecRow
              icon={<BoltIcon />}
              title="Direct-play first"
              body="MP4 and WebM stream untouched. ffmpeg only steps in for the titles nothing can play natively."
            />
            <SpecRow
              icon={<ShuffleIcon />}
              title="Seeks across sources"
              body="A source that dies mid-play hands off to the next one and resumes at the same second."
            />
            <SpecRow
              icon={<LockIcon />}
              title="Nothing leaves the box"
              body="No accounts and no telemetry. Watch history and cache never go anywhere but your disk."
            />
          </ul>
        </section>

        <section className="cta-banner">
          <h2>Ready in one command.</h2>
          <InstallCore platform={platform} />
          <a
            className="cta-link"
            href="/downloads"
            onClick={(event) => {
              event.preventDefault();
              navigate('/downloads');
            }}
          >
            or browse all downloads →
          </a>
        </section>
      </main>

      <Footer />
    </>
  );
}

function DownloadPage({
  version,
  platform,
}: {
  version: string | null;
  platform: Platform;
}) {
  const leadCmd = INSTALL_COMMANDS[platform === 'windows' ? 'windows' : 'mac'];
  const leadShell = platform === 'windows' ? 'PowerShell' : 'Terminal';

  return (
    <main className="page">
      <header className="dl-head">
        <p className="eyebrow">Download</p>
        <h1>One command and you&rsquo;re running.</h1>
        <ul className="trait-row">
          <li>
            <BoxIcon />
            ffmpeg bundled
          </li>
          <li>
            <GlobeIcon />
            Serves the web app
          </li>
          <li>
            <RefreshIcon />
            Updates itself
          </li>
        </ul>
      </header>

      {/* Lead with the one answer for the visitor's own machine; everything
          else drops to the table below rather than competing up here. */}
      <section className="dl-lead">
        <p className="dl-detected">
          {platform === 'windows' ? <WindowsIcon /> : <AppleIcon />}
          Looks like <strong>{PLATFORM_LABEL[platform]}</strong> &mdash; paste
          this into {leadShell}
        </p>
        <BigCommand cmd={leadCmd} />
        <p className="dl-lead-note">
          Not your machine? <a href="#every">Every option is below.</a>
        </p>
      </section>

      <section className="dl-all" id="every">
        <h2>Every option</h2>
        <ul className="dl-rows">
          <CommandOption
            icon={<TerminalIcon />}
            os="macOS & Linux"
            kind="Terminal"
            cmd={INSTALL_COMMANDS.mac}
          />
          <CommandOption
            icon={<TerminalIcon />}
            os="Windows"
            kind="PowerShell"
            cmd={INSTALL_COMMANDS.windows}
          />
          <FileOption
            icon={<AppleIcon />}
            os="macOS"
            kind="Apple Silicon"
            file="cubo-macos-apple-silicon.dmg"
            href={DOWNLOADS.macArm}
          />
          <FileOption
            icon={<AppleIcon />}
            os="macOS"
            kind="Intel"
            file="cubo-macos-intel.dmg"
            href={DOWNLOADS.macIntel}
          />
          <FileOption
            icon={<WindowsIcon />}
            os="Windows"
            kind="64-bit"
            file="cubo-windows-x64-setup.exe"
            href={DOWNLOADS.windows}
          />
        </ul>

        <details className="fine-print">
          <summary>First-launch notes (unsigned-app quirks)</summary>
          <div>
            <p>
              Cubo isn&rsquo;t notarized yet, so macOS calls the app
              &ldquo;damaged&rdquo; on first launch. Run this once, then open it
              normally:
            </p>
            <code className="command">xattr -cr /Applications/cubo.app</code>
            <p>
              On Windows, choose &ldquo;More info &rarr; Run anyway&rdquo; if
              SmartScreen appears. Updates install themselves after that.
            </p>
          </div>
        </details>
      </section>

      {version ? (
        <p className="version page-version">Latest release: v{version}</p>
      ) : null}
    </main>
  );
}

/** The page's centerpiece: one oversized, copyable command. */
function BigCommand({ cmd }: { cmd: string }) {
  const [copied, copy] = useCopy();
  return (
    <div className="big-cmd">
      <code>{cmd}</code>
      <button type="button" className="big-cmd-btn" onClick={() => copy(cmd)}>
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** One row of the "every option" table, ending in a copy button. */
function CommandOption({
  icon,
  os,
  kind,
  cmd,
}: {
  icon: ReactNode;
  os: string;
  kind: string;
  cmd: string;
}) {
  const [copied, copy] = useCopy();
  return (
    <li className="dl-row">
      <RowName icon={icon} os={os} kind={kind} />
      <code className="dl-row-cmd">{cmd}</code>
      <button type="button" className="row-btn" onClick={() => copy(cmd)}>
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </li>
  );
}

/** One row of the "every option" table, ending in a download link. */
function FileOption({
  icon,
  os,
  kind,
  file,
  href,
}: {
  icon: ReactNode;
  os: string;
  kind: string;
  file: string;
  href: string;
}) {
  return (
    <li className="dl-row">
      <RowName icon={icon} os={os} kind={kind} />
      <code className="dl-row-cmd dl-row-file">{file}</code>
      <a className="row-btn" href={href}>
        <DownloadIcon />
        Download
      </a>
    </li>
  );
}

function RowName({ icon, os, kind }: { icon: ReactNode; os: string; kind: string }) {
  return (
    <span className="dl-row-name">
      <span className="dl-row-icon" aria-hidden="true">
        {icon}
      </span>
      <span>
        <span className="dl-row-os">{os}</span>
        <span className="dl-row-kind">{kind}</span>
      </span>
    </span>
  );
}

function Footer() {
  const follow = (to: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    navigate(to);
  };
  return (
    <footer>
      <span className="footer-brand">
        <CuboMark />
        Cubo
      </span>
      <span>&copy; {new Date().getFullYear()}</span>
      <a href="/downloads" onClick={follow('/downloads')}>
        Download
      </a>
      <a href="/legal" onClick={follow('/legal')}>
        Legal
      </a>
      <a href="https://github.com/spheceo/cubo/blob/main/LICENSE" rel="noreferrer">
        MIT License
      </a>
      <a href="https://github.com/spheceo/cubo" rel="noreferrer">
        Source
      </a>
    </footer>
  );
}

function useLegalDoc(): LegalDoc {
  const [doc, setDoc] = useState(() => legalDocFrom(FALLBACK_LEGAL));
  useEffect(() => {
    let cancelled = false;
    void fetchPublishedLegal().then((live) => {
      if (!cancelled && live) setDoc(live);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return doc;
}

function LegalInlineText({ text }: { text: string }) {
  return (
    <>
      {splitInlineMarkdown(text).map((part, index) =>
        part.type === 'link' ? (
          <a key={index} href={part.href} rel="noreferrer">
            {part.label}
          </a>
        ) : (
          <span key={index}>{part.value}</span>
        ),
      )}
    </>
  );
}

/** Plain-language legal summary. Sourced from LEGAL.md on main. */
function LegalPage() {
  const doc = useLegalDoc();
  return (
    <>
      <main className="page">
        <header className="legal-head">
          <p className="eyebrow">Legal</p>
          <h1>{doc.title}</h1>
          <p className="legal-lede">
            <LegalInlineText text={doc.lede} />
          </p>
        </header>

        <section className="legal-body">
          {doc.sections.map((section) => (
            <article key={section.title} className="legal-block">
              <h2>{section.title}</h2>
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph}>
                  <LegalInlineText text={paragraph} />
                </p>
              ))}
            </article>
          ))}
        </section>
      </main>
      <Footer />
    </>
  );
}

function Step({ num, title, body }: { num: string; title: string; body: string }) {
  return (
    <article className="step">
      <span className="step-num" aria-hidden="true">
        {num}
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(done);
    } else {
      // Clipboard API needs a secure context; fall back silently.
      done();
    }
  };
  return [copied, copy];
}

/** Hero / CTA call-to-action: the one-liner for this platform, with a copy
 *  button. The downloads page has its own, larger treatment. */
function InstallCore({ platform }: { platform: Platform }) {
  const cmd = INSTALL_COMMANDS[platform === 'windows' ? 'windows' : platform];
  const [copied, copy] = useCopy();
  return (
    <div className="install">
      <div className="install-box">
        <code className="install-cmd">{cmd}</code>
        <button type="button" className="copy-btn" onClick={() => copy(cmd)}>
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function SpecRow({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <li className="spec-row">
      <span className="spec-icon" aria-hidden="true">
        {icon}
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
    </li>
  );
}

/* Inline SVG throughout: apps/site deliberately carries no dependencies, so
   there is no icon package to pull from. All inherit currentColor. */

function Glyph({ children, stroke = true }: { children: ReactNode; stroke?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="icon"
      aria-hidden="true"
      fill={stroke ? 'none' : 'currentColor'}
      stroke={stroke ? 'currentColor' : 'none'}
      strokeWidth={stroke ? 1.7 : undefined}
      strokeLinecap={stroke ? 'round' : undefined}
      strokeLinejoin={stroke ? 'round' : undefined}
    >
      {children}
    </svg>
  );
}

function AppleIcon() {
  return (
    <Glyph stroke={false}>
      <path d="M17 12.8c0-2.5 2-3.7 2.1-3.8-1.1-1.7-2.9-1.9-3.6-1.9-1.5-.2-3 .9-3.7.9s-2-.9-3.3-.9c-1.7 0-3.3 1-4.1 2.5-1.8 3.1-.5 7.6 1.3 10.1.9 1.2 1.9 2.6 3.2 2.6 1.2 0 1.7-.8 3.2-.8s1.9.8 3.2.8 2.2-1.2 3-2.5c.9-1.4 1.3-2.8 1.3-2.9 0-.1-2.6-1-2.6-3.9z" />
      <path d="M14.7 5.3c.7-.8 1.1-2 1-3.2-1 0-2.2.7-2.9 1.5-.6.8-1.2 2-1 3.1 1.1.1 2.2-.6 2.9-1.4z" />
    </Glyph>
  );
}

function WindowsIcon() {
  return (
    <Glyph stroke={false}>
      <path d="M3 5.6l7.5-1v7.1H3V5.6zM11.7 4.4L21 3v8.7h-9.3V4.4zM3 12.9h7.5V20L3 19V12.9zM11.7 12.9H21V21l-9.3-1.3v-6.8z" />
    </Glyph>
  );
}

function TerminalIcon() {
  return (
    <Glyph>
      <rect x="2.6" y="4.6" width="18.8" height="14.8" rx="2.6" />
      <path d="M7 9.8l2.8 2.4L7 14.6M12.8 15.1h4.4" />
    </Glyph>
  );
}

function BoxIcon() {
  return (
    <Glyph>
      <path d="M12 2.9l8.4 4.7v8.8L12 21.1l-8.4-4.7V7.6z" />
      <path d="M3.6 7.6l8.4 4.7 8.4-4.7M12 12.3v8.8" />
    </Glyph>
  );
}

function GlobeIcon() {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.3 2.5 3.5 5.6 3.5 9s-1.2 6.5-3.5 9c-2.3-2.5-3.5-5.6-3.5-9S9.7 5.5 12 3z" />
    </Glyph>
  );
}

function RefreshIcon() {
  return (
    <Glyph>
      <path d="M20.4 12a8.4 8.4 0 1 1-2.5-6" />
      <path d="M20.6 3.4v5.2h-5.2" />
    </Glyph>
  );
}

function BoltIcon() {
  return (
    <Glyph>
      <path d="M13.2 2.8L4.4 13.6h6.3l-.9 7.6 8.8-10.8h-6.3z" />
    </Glyph>
  );
}

function ShuffleIcon() {
  return (
    <Glyph>
      <path d="M3.2 6.6h3.4c1.5 0 2.9.8 3.7 2.1l2.9 4.6c.8 1.3 2.2 2.1 3.7 2.1h3M3.2 17.4h3.4c1.5 0 2.9-.8 3.7-2.1M16.9 4.2l3 2.4-3 2.4M16.9 12.9l3 2.4-3 2.4" />
    </Glyph>
  );
}

function LockIcon() {
  return (
    <Glyph>
      <rect x="4.2" y="10.2" width="15.6" height="10.6" rx="2.4" />
      <path d="M8 10.2V7.4a4 4 0 0 1 8 0v2.8" />
    </Glyph>
  );
}

function CopyIcon() {
  return (
    <Glyph>
      <rect x="9" y="9" width="11.4" height="11.4" rx="2.2" />
      <path d="M15 5.7a2.2 2.2 0 0 0-2.2-2.2H5.8a2.3 2.3 0 0 0-2.3 2.3v7a2.2 2.2 0 0 0 2.2 2.2" />
    </Glyph>
  );
}

function CheckIcon() {
  return (
    <Glyph>
      <path d="M4.8 12.6l4.8 4.8L19.4 7.2" />
    </Glyph>
  );
}

function DownloadIcon() {
  return (
    <Glyph>
      <path d="M12 3.6v11.2M7.4 10.4l4.6 4.6 4.6-4.6M4.2 19.4h15.6" />
    </Glyph>
  );
}

function CuboMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={`mark ${className}`.trim()} aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinejoin="round"
      >
        <path d="M16 3.8 27 10v12L16 28.2 5 22V10Z" />
        <path d="M5 10l11 6.3L27 10M16 16.3v11.9" />
      </g>
    </svg>
  );
}
