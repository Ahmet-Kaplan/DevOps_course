/**
 * Vite configuration for Bug Squash Arena.
 *
 * Two very different jobs:
 *   1. `npm run dev`   a development server with hot reload and an /api proxy.
 *   2. `npm run build` a one-off compile into ./dist: plain static files that
 *                      nginx serves in production. No Node.js runs in production.
 *
 * Environment variables read here (they run in Node, at dev/build time, never in the browser):
 *   VITE_API_PROXY_TARGET  where the dev server forwards /api (default http://localhost:3000).
 *                          In docker-compose.yml it is http://backend:3000: the Compose
 *                          service name, resolved by Docker's embedded DNS.
 *   VITE_USE_POLLING=true  poll for file changes instead of using inotify. Needed when the
 *                          source is bind-mounted from macOS/Windows into a Linux container
 *                          (Docker Desktop does not forward file-change events reliably).
 *   VITE_APP_VERSION       not used in this file: Vite inlines any VITE_* variable into the
 *                          client bundle (see src/js/layout.js). The Dockerfile sets it from
 *                          a build arg.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** Absolute path of a file next to this config. */
const here = (file) => fileURLToPath(new URL(file, import.meta.url));

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000';
const usePolling = process.env.VITE_USE_POLLING === 'true';

/*
 * Browser -> Vite (5173) -> backend (3000). The browser only ever talks to one
 * origin, exactly like production behind nginx, so cookies and relative /api
 * URLs behave the same in dev and prod.
 */
const proxy = {
  '/api': {
    target: apiProxyTarget,
    changeOrigin: false, // keep the original Host header, as nginx does
    xfwd: true, // add X-Forwarded-For / -Proto, as nginx does
  },
};

export default defineConfig({
  // Multi-page app: /login.html is a real file, and unknown URLs are a 404
  // (instead of the single-page-app fallback to index.html).
  appType: 'mpa',

  server: {
    // Inside a container, 127.0.0.1 is the *container's own* loopback (its own
    // network namespace). Docker's published port arrives on the container's
    // eth0, so the server must listen on all interfaces. Compose publishes it as
    // 127.0.0.1:5173 on the host, so it is still not exposed to the LAN.
    host: '0.0.0.0',
    port: 5173,
    strictPort: true, // fail loudly instead of silently moving to 5174
    proxy,
    watch: usePolling ? { usePolling: true, interval: 300 } : undefined,
  },

  // `npm run preview` serves ./dist the way nginx would. Handy for checking a build.
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    proxy,
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Each HTML file is an entry point. Shared modules (api.js, layout.js...) are
    // split into common chunks automatically. Output files get content hashes
    // (index-3fa9c1.js), which is what makes 1-year caching safe in nginx.conf.
    // (Vite 8 bundles with Rolldown; `rolldownOptions` replaces `rollupOptions`.)
    rolldownOptions: {
      input: {
        index: here('./index.html'),
        login: here('./login.html'),
        signup: here('./signup.html'),
        dashboard: here('./dashboard.html'),
        notFound: here('./404.html'),
      },
    },
  },
});
