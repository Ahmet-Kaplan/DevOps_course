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
 * The answer is deliberately TINY because this URL is public: anyone on the
 * internet can call https://<your-domain>/api/health. It says "ok" or "error"
 * and nothing about what is behind the API (no database status, no uptime):
 * attackers learn the least possible. The REASON for an error goes to the
 * server log instead, where only operators look: `docker compose logs backend`.
 *
 * `version` comes from APP_VERSION, baked into the image at build time (CI
 * sets it to the git commit's short SHA) — so you can see which build is live.
 * That is public anyway (it is the image tag on Docker Hub).
 */

const { Router } = require('express');

function createHealthRouter({ db, config }) {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      await db.ping();
      res.json({ status: 'ok', version: config.appVersion });
    } catch (err) {
      console.error(`[health] database check failed: ${err.message}`);
      res.status(503).json({ status: 'error', version: config.appVersion });
    }
  });

  return router;
}

module.exports = { createHealthRouter };
