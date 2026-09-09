/** Decode an OpenSubtitles payload. The CDN often labels UTF-8 as Latin-1;
 *  ASCII dialogue looks fine either way, but `♪` and other non-ASCII become
 *  `Ã¢â„¢Âª` if we honor that charset and re-emit UTF-8. */
export function decodeSubtitleBytes(bytes: Uint8Array): string {
  let body = bytes;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    body = body.subarray(3);
  }
  try {
    return repairUtf8Mojibake(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return repairUtf8Mojibake(new TextDecoder('windows-1252').decode(body));
  }
}

export function toWebVtt(source: string): string {
  const normalized = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (normalized.trimStart().startsWith('WEBVTT')) return normalized;
  return `WEBVTT\n\n${normalized.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
}

function looksLikeUtf8Mojibake(text: string): boolean {
  return /[\u00C3\u00C2\u2122\u201E\u0084]/.test(text);
}

function encodeWindows1252(text: string): Uint8Array | null {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const byte = WINDOWS_1252_FROM_BMP[code];
    if (byte == null && code > 0xff) return null;
    out[index] = byte ?? code;
  }
  return out;
}

function repairUtf8Mojibake(text: string): string {
  let current = text;
  for (let pass = 0; pass < 2; pass += 1) {
    if (!looksLikeUtf8Mojibake(current)) break;
    const bytes = encodeWindows1252(current);
    if (!bytes) break;
    try {
      const fixed = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (fixed === current) break;
      current = fixed;
    } catch {
      break;
    }
  }
  return current;
}

/** BMP codepoint → CP1252 byte for the C1-range extras. ASCII and Latin-1
 *  except 0x80–0x9F map to themselves. */
const WINDOWS_1252_FROM_BMP: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};
