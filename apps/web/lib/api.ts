import { createClient } from '@cubo/core';

/** Same-origin API (Vercel, Vite dev, or Core's browser gateway). */
export const API_BASE = '';

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export const catalog = createClient({ baseUrl: API_BASE });
