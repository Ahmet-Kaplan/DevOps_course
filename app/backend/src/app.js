'use strict';

/**
 * createApp() builds the Express application WITHOUT starting a server or
 * connecting to a database. Dependencies are passed in ("dependency
 * injection"):
 *
 *   server.js  -> createApp({ db: <real Postgres repository>, config })
 *   unit tests -> createApp({ db: <in-memory fake>, config: <test config> })
 *
 * That separation is why `npm test` needs no Docker and no Postgres.
 */

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const { loadConfig } = require('./config');
const { createRequireAuth } = require('./middleware/auth');
const { createHealthRouter } = require('./routes/health');
const { createAuthRouter } = require('./routes/auth');
const { createScoresRouter } = require('./routes/scores');

/**
 * Minimal access log written to stdout. In containers we never write log
 * files: Docker captures stdout/stderr (`docker compose logs backend`) and
 * the json-file driver rotates them for us.
 */
function accessLog(logger) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      // Health checks hit us every few seconds; only log them when unhealthy.
      if (req.originalUrl.startsWith('/api/health') && res.statusCode < 400) return;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      logger.info(`${req.ip} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
    next();
  };
}

/**
 * @param {object} deps
 * @param {object} deps.db       repository from createDb() or a test fake
 * @param {object} [deps.config] from loadConfig(); defaults to process.env
 * @param {object} [deps.logger] info/warn/error sink; defaults to console
 */
function createApp({ db, config = loadConfig(), logger = console }) {
  if (!db) throw new Error('createApp() needs a db implementation');

  const app = express();

  // REVERSE PROXIES: in production a request travels
  //   browser -> host nginx (TLS) -> [frontend nginx container] -> this app.
  // Each proxy opens its own TCP connection, so the socket's peer address is
  // the proxy, not the user. Proxies pass the real client IP in the
  // X-Forwarded-For header, but a client could forge that header too, so we
  // only trust it when it was added by a proxy on a private address:
  //   loopback    127.0.0.0/8, ::1       (host nginx -> 127.0.0.1:3000)
  //   uniquelocal 10/8, 172.16/12, 192.168/16, fc00::/7 (Docker bridge networks)
  //   linklocal   169.254/16, fe80::/10
  // With this, req.ip is the real user's IP (used by the rate limiter and logs)
  // and req.protocol reflects X-Forwarded-Proto.
  // Surprise worth seeing in `docker compose logs`: even when host nginx
  // connects to 127.0.0.1:3000, the container sees the Docker bridge gateway
  // (e.g. 172.18.0.1) as the peer, because Docker's port publishing forwards
  // the connection. That is why 'uniquelocal' must be trusted, not just loopback.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  // Sensible security headers (nosniff, frame protection, CSP...). HSTS is
  // left to the host nginx: whoever terminates TLS owns the HTTPS policy.
  app.use(helmet({ strictTransportSecurity: false }));

  app.use(accessLog(logger));

  // Parse JSON bodies, refusing anything over 10 kB: our payloads are tiny,
  // and a small cap stops memory-exhaustion attempts with giant bodies.
  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());

  // API answers are per-user and change constantly: no browser/CDN caching.
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const requireAuth = createRequireAuth(config);
  app.use('/api/health', createHealthRouter({ db, config }));
  app.use('/api/auth', createAuthRouter({ db, config, requireAuth }));
  app.use('/api/scores', createScoresRouter({ db, requireAuth }));

  // Nothing matched: JSON 404 (also for non-/api paths, which nginx should
  // never send here anyway).
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Central error handler — Express recognises it by its FOUR parameters,
  // so `_next` must stay even though it is unused.
  app.use((err, req, res, _next) => {
    // Errors raised by express.json() carry a `type` we can map to 4xx.
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Malformed JSON in request body' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body too large' });
    }
    if (err.status >= 400 && err.status < 500 && err.expose) {
      return res.status(err.status).json({ error: err.message });
    }
    // Anything else is our bug (or the DB is down). Log the details for the
    // operator, but never leak stack traces or SQL errors to the client.
    logger.error(`[error] ${req.method} ${req.originalUrl}:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
