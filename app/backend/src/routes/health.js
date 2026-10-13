'use strict';

/**
 * GET /api/health — the endpoint every layer of our stack asks "are you OK?":
 *   - the Dockerfile HEALTHCHECK (container shows "healthy" in `docker ps`)
 *   - docker compose `depends_on: condition: service_healthy` / `up --wait`
 *   - deploy/deploy.sh smoke test after a release
 *   - the frontend footer, which displays the API `version`
 *
 * It checks the database too: an API that is up but cannot reach Postgres is
 * not really healthy. 503 "Service Unavailable" tells orchestrators and load
 * balancers to stop sending traffic until it recovers.
 *
 * `version` comes from APP_VERSION, baked into the image at build time (CI
 * sets it to the git commit's short SHA) — so you can see which build is live.
 */

const { Router } = require('express');

function createHealthRouter({ db, config }) {
  const router = Router();

  router.get('/', async (req, res) => {
    const base = { version: config.appVersion, uptime: Math.floor(process.uptime()) };
    try {
      await db.ping();
      res.json({ status: 'ok', db: 'up', ...base });
    } catch {
      res.status(503).json({ status: 'error', db: 'down', ...base });
    }
  });

  return router;
}

module.exports = { createHealthRouter };
