const GITHUB_RELEASES = 'https://api.github.com/repos/spheceo/cubo/releases?per_page=100';
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

/** Highest semver among tags that are newer than the running Core. */
export function newestReleaseTag(tags: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const tag of tags) {
    if (!tag) continue;
    if (!best || isNewerRelease(tag, best)) best = tag;
  }
  return best;
}

/** Prefer the newest tag Core or GitHub knows, never the first increment. */
export function coalesceLatest(
  coreLatest: string | null | undefined,
  githubTag: string | null,
  current: string,
): string | null {
  const newest = newestReleaseTag([coreLatest, githubTag]);
  return newest && isNewerRelease(newest, current) ? newest : null;
}

export async function fetchGithubLatestTag(): Promise<string | null> {
  if (githubCache && Date.now() - githubCache.at < GITHUB_TTL_MS) {
    return githubCache.tag;
  }
  try {
    const response = await fetch(GITHUB_RELEASES, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return githubCache?.tag ?? null;
    const body = (await response.json()) as Array<{
      tag_name?: string;
      draft?: boolean;
      prerelease?: boolean;
    }>;
    const tags = Array.isArray(body)
      ? body
          .filter((release) => !release.draft && !release.prerelease)
          .map((release) => release.tag_name)
          .filter((tag): tag is string => typeof tag === 'string')
      : [];
    const tag = newestReleaseTag(tags);
    githubCache = { at: Date.now(), tag };
    return tag;
  } catch {
    return githubCache?.tag ?? null;
  }
}
