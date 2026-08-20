import { createClient } from '@cubo/core';

/** Canonical deployment. The bundled desktop build has no serverless functions
 *  on its tauri:// origin, so it calls the deployed API directly; everywhere
 *  else (Vercel, Vite dev, Core's browser gateway) the API is same-origin. */
export const DEPLOYED_SITE_URL = 'https://app.cubo.spheceo.com';

const DESKTOP_ORIGINS = new Set(['tauri://localhost', 'http://tauri.localhost']);

export const API_BASE = DESKTOP_ORIGINS.has(window.location.origin)
  ? DEPLOYED_SITE_URL
  : '';

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export const catalog = createClient({ baseUrl: API_BASE });
