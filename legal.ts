/** Canonical copy lives in LEGAL.md on main. Both /legal pages fetch this. */
export const LEGAL_URL =
  'https://raw.githubusercontent.com/spheceo/cubo/main/LEGAL.md';

export type LegalInline =
  | { type: 'text'; value: string }
  | { type: 'link'; label: string; href: string };

export type LegalDoc = {
  title: string;
  lede: string;
  sections: { title: string; paragraphs: string[] }[];
};

/** Last-deploy fallback when GitHub is unreachable. Keep in sync with LEGAL.md. */
export const FALLBACK_LEGAL = `# The short version.

Cubo is an open-source engine you run on your own hardware. It hosts, indexes, and distributes no media itself — playback comes entirely from sources the person running Core connects.

## What Cubo is

A self-hosted streaming engine. It streams media over the protocols and from the sources the operator points it at, converts formats for browser playback, and remembers viewing progress on that machine.

## What Cubo is not

Cubo is not a library, a host, or a catalog of files. It cannot take material down from networks or servers it does not operate. Removal requests belong with whoever actually stores the files.

## Your responsibility

You are responsible for the sources you connect to Core and for using Cubo in accordance with the laws that apply to you. If you are unsure whether a source is legitimate where you live, don't connect it.

## Trademarks & data

Catalog metadata may be provided by The Movie Database (TMDB). This product uses the TMDB API but is not endorsed or certified by TMDB. Artwork and titles belong to their respective owners.

## License

The code is released under the [MIT License](https://github.com/spheceo/cubo/blob/main/LICENSE). It is provided "as is", without warranty of any kind.
`;

export function parseLegalMarkdown(source: string): LegalDoc | null {
  const text = source.replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const titleMatch = text.match(/^#\s+(.+)$/m);
  if (!titleMatch) return null;

  const afterTitle = text.slice(text.indexOf(titleMatch[0]) + titleMatch[0].length).trim();
  const chunks = afterTitle.split(/^##\s+/m);
  const lede = (chunks[0] ?? '').replace(/\s+/g, ' ').trim();
  if (!lede) return null;

  const sections = chunks.slice(1).flatMap((chunk) => {
    const newline = chunk.indexOf('\n');
    const title = (newline === -1 ? chunk : chunk.slice(0, newline)).trim();
    const body = (newline === -1 ? '' : chunk.slice(newline)).trim();
    const paragraphs = body
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return title && paragraphs.length ? [{ title, paragraphs }] : [];
  });

  return sections.length ? { title: titleMatch[1].trim(), lede, sections } : null;
}

export function legalDocFrom(source: string): LegalDoc {
  const parsed = parseLegalMarkdown(source);
  if (!parsed) throw new Error('LEGAL.md is missing a title, lede, or section');
  return parsed;
}

export function splitInlineMarkdown(text: string): LegalInline[] {
  const parts: LegalInline[] = [];
  const pattern = /\[([^\]]+)\]\((https?:[^)\s]+)\)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ type: 'text', value: text.slice(cursor, index) });
    parts.push({ type: 'link', label: match[1], href: match[2] });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) parts.push({ type: 'text', value: text.slice(cursor) });
  return parts;
}

export async function fetchPublishedLegal(): Promise<LegalDoc | null> {
  try {
    const response = await fetch(LEGAL_URL, { cache: 'no-store' });
    if (!response.ok) return null;
    return parseLegalMarkdown(await response.text());
  } catch {
    return null;
  }
}
