import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import subtitleFileHandler from './api/subtitle-file.ts';
import subtitlesHandler from './api/subtitles.ts';
import tmdbHandler from './api/tmdb.ts';
import torrentioHandler from './api/torrentio.ts';

const root = path.dirname(fileURLToPath(import.meta.url));

// Serves the Vercel functions in api/ during `vite` dev so the local flow
// matches production without needing the Vercel CLI.
function cuboApi(): Plugin {
  return {
    name: 'cubo-api',
    configureServer(server) {
      const env = loadEnv('development', root, '');
      for (const [key, value] of Object.entries(env)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }

      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        // Mirror the vercel.json rewrites: nested API paths arrive as ?path=.
        const proxied = url.match(/^\/api\/(tmdb|torrentio|subtitles)(?:\/(.*))?$/);
        const handler =
          proxied?.[1] === 'tmdb'
            ? tmdbHandler
            : proxied?.[1] === 'torrentio'
              ? torrentioHandler
              : proxied?.[1] === 'subtitles'
                ? subtitlesHandler
                : url.startsWith('/api/subtitle-file')
                  ? subtitleFileHandler
                  : null;
        if (!handler) return next();

        if (proxied) {
          const rest = proxied[2] ?? '';
          const queryStart = rest.indexOf('?');
          const params = new URLSearchParams(
            queryStart === -1 ? '' : rest.slice(queryStart + 1),
          );
          params.set('path', queryStart === -1 ? rest : rest.slice(0, queryStart));
          req.url = `/api/${proxied[1]}?${params.toString()}`;
        }

        Promise.resolve(handler(req, res)).catch(() => {
          if (!res.headersSent) res.statusCode = 502;
          res.end();
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), cuboApi()],
  resolve: {
    alias: [{ find: /^@\//, replacement: `${root}/` }],
  },
  build: {
    rollupOptions: {
      output: {
        // Long-lived vendor chunks so app-code changes don't invalidate the
        // framework bytes in visitors' caches. hls.js splits automatically
        // via its dynamic import.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](react|react-dom|react-router|scheduler)[\\/]/.test(id)) return 'react';
          if (/[\\/](gsap|@gsap)[\\/]/.test(id)) return 'motion';
          if (id.includes('@tanstack')) return 'query';
          return undefined;
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: ['kenobi'],
    port: 4200,
    strictPort: true,
  },
});
