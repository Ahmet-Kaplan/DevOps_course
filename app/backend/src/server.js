'use strict';

/**
 * Process entry point: load config -> connect + migrate DB -> listen on PORT
 * -> shut down gracefully on SIGTERM/SIGINT.
 *
 * ---------------------------------------------------------------------------
 * PID 1 AND SIGNALS — why the shutdown code below matters in a container
 * ---------------------------------------------------------------------------
 * A container runs in its own PID namespace. The Dockerfile uses the exec
 * form `CMD ["node", "src/server.js"]`, so node itself is PID 1 inside it.
 *
 * `docker stop` / `docker compose down` / a redeploy sends SIGTERM to PID 1,
 * waits (10 s by default, `stop_grace_period` in compose), then sends SIGKILL.
 *
 * PID 1 is special: the kernel does NOT apply default signal actions to it.
 * A normal process dies on SIGTERM by default; PID 1 simply ignores SIGTERM
 * unless it installs a handler. Node installs none for SIGTERM, so without the
 * handlers below every `docker stop` would hang for 10 s and end in SIGKILL —
 * in-flight requests cut off, DB connections dropped uncleanly.
 *
 * Two classic traps:
 *   - Shell form `CMD node src/server.js` runs `/bin/sh -c ...`; the shell
 *     becomes PID 1 and does not forward SIGTERM to node.
 *   - Wrapping in `npm start` adds another process in between.
 * Alternatives: `docker run --init` / compose `init: true`, which put a tiny
 * init (tini) at PID 1 to forward signals and reap zombie processes.
 * ---------------------------------------------------------------------------
 */

const http = require('node:http');

const { loadConfig, DEV_JWT_SECRET } = require('./config');
const { createDb } = require('./db');
const { createApp } = require('./app');

// Must be below Docker's 10 s stop timeout so WE finish before SIGKILL does.
const SHUTDOWN_TIMEOUT_MS = 8_000;

async function main() {
  // Throws on bad config (e.g. no JWT_SECRET in production) -> caught below,
  // exit code 1. Fail fast and loudly rather than run misconfigured.
  const config = loadConfig();
  const db = createDb(config.db);

  let server = null;
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return; // a second Ctrl+C should not start a second shutdown
    shuttingDown = true;
    console.info(`[server] ${signal} received, shutting down gracefully...`);

    // Safety net: if something hangs, exit anyway before Docker sends SIGKILL.
    // unref() so this timer alone does not keep the process alive.
    setTimeout(() => {
      console.error('[server] graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    try {
      if (server) {
        // 1. Stop accepting new connections; the callback fires once all
        //    in-flight requests have finished.
        const closed = new Promise((resolve) => server.close(resolve));
        // 2. Idle keep-alive sockets would otherwise hold close() open.
        server.closeIdleConnections();
        await closed;
      }
      // 3. Only now close DB connections: in-flight requests may still need them.
      await db.close();
      console.info('[server] shutdown complete, bye!');
      process.exit(0);
    } catch (err) {
      console.error('[server] error during shutdown:', err);
      process.exit(1);
    }
  }

  // Register BEFORE the (possibly slow) migration, so `docker stop` works
  // even while we are still waiting for Postgres to come up.
  process.on('SIGTERM', () => shutdown('SIGTERM')); // docker stop, compose down
  process.on('SIGINT', () => shutdown('SIGINT')); // Ctrl+C in a terminal

  console.info(`[server] starting Bug Squash Arena API ${config.appVersion} (NODE_ENV=${config.nodeEnv})`);
  if (config.jwtSecret === DEV_JWT_SECRET) {
    console.warn('[server] using the built-in development JWT secret - never do this in production');
  }

  await db.migrate();
  if (shuttingDown) return;

  const app = createApp({ db, config });
  server = http.createServer(app);

  // Slightly longer than the proxies' keep-alive (nginx: 60 s) so the proxy,
  // not us, closes idle upstream connections — avoids rare 502s caused by a
  // request arriving on a socket we are just closing.
  server.keepAliveTimeout = 65_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject); // e.g. EADDRINUSE
    // No host argument = listen on all interfaces. Inside a container this is
    // required: 127.0.0.1 would only be reachable from inside the container's
    // own network namespace, not via Docker's port publishing or other
    // containers. Exposure to the outside is controlled by compose instead.
    server.listen(config.port, resolve);
  });
  console.info(`[server] listening on port ${config.port}`);
}

main().catch((err) => {
  console.error(`[server] fatal: ${err.message}`);
  // Non-zero exit -> Docker's restart policy (restart: unless-stopped) retries.
  process.exit(1);
});
