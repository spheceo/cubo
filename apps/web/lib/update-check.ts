const GITHUB_LATEST = 'https://api.github.com/repos/spheceo/cubo/releases/latest';
const GITHUB_TTL_MS = 10 * 60 * 1000;

let githubCache: { at: number; tag: string | null } | null = null;

export function parseReleaseVersion(tag: string): [number, number, number] | null {
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  const parts = version.split('.').slice(0, 3).map((part) => Number.parseInt(part, 10));
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) return null;
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

export function isNewerRelease(latest: string, current: string): boolean {
  const next = parseReleaseVersion(latest);
  const running = parseReleaseVersion(current);
  if (!next || !running) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== running[index]) return next[index] > running[index];
  }
  return false;
}

/** Prefer Core's answer; if it has none (stale "up to date" cache), use GitHub. */
export function coalesceLatest(
  coreLatest: string | null | undefined,
  githubTag: string | null,
  current: string,
): string | null {
  if (coreLatest) return coreLatest;
  if (githubTag && isNewerRelease(githubTag, current)) return githubTag;
  return null;
}

export async function fetchGithubLatestTag(): Promise<string | null> {
  if (githubCache && Date.now() - githubCache.at < GITHUB_TTL_MS) {
    return githubCache.tag;
  }
  try {
    const response = await fetch(GITHUB_LATEST, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return githubCache?.tag ?? null;
    const body = (await response.json()) as {
      tag_name?: string;
      draft?: boolean;
      prerelease?: boolean;
    };
    const tag =
      !body.draft && !body.prerelease && typeof body.tag_name === 'string' ? body.tag_name : null;
    githubCache = { at: Date.now(), tag };
    return tag;
  } catch {
    return githubCache?.tag ?? null;
  }
}
