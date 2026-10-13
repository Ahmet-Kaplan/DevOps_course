'use strict';

/**
 * Configuration — the "Config" factor of the Twelve-Factor App.
 *
 * Everything that changes between environments (laptop, CI, production) is
 * read from ENVIRONMENT VARIABLES, never hard-coded. The same Docker image
 * then runs everywhere; only the environment injected by `docker compose`
 * (from .env / .env.prod) differs. That is what makes "build once, deploy
 * many" possible: CI builds one image, and we promote exactly that image.
 *
 * `loadConfig()` takes the env object as a parameter (defaulting to
 * process.env) so unit tests can pass a fake environment instead of mutating
 * global state.
 */

const jwt = require('jsonwebtoken');

const DEV_JWT_SECRET = 'dev-only-insecure-secret-change-me';

/** Parse "true"/"false" (case-insensitive); unset -> fallback, anything else -> error. */
function parseBoolean(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be "true" or "false", got "${value}"`);
}

/** Parse a positive integer env var, failing loudly on garbage. */
function parsePositiveInt(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

/**
 * jsonwebtoken gotcha worth knowing: a *string* without a unit is read as
 * MILLISECONDS ("3600" === 3.6 s!), while a *number* means SECONDS. Env vars
 * are always strings, so we convert pure digits to a number (= seconds).
 */
function parseExpiresIn(value) {
  const raw = (value || '7d').trim();
  const expiresIn = /^\d+$/.test(raw) ? Number(raw) : raw;
  try {
    // Sign a throwaway token: jsonwebtoken validates the format for us.
    jwt.sign({}, 'probe', { expiresIn });
  } catch {
    throw new Error(`JWT_EXPIRES_IN has an invalid format: "${value}" (examples: 7d, 12h, 3600)`);
  }
  return expiresIn;
}

/**
 * Build the configuration object from an environment.
 * Throws (-> process exits non-zero) on invalid or missing required values.
 * Failing fast at startup is far better than failing on the first request:
 * Docker's restart policy and our deploy script's health checks surface the
 * problem immediately, with a clear message in `docker compose logs`.
 */
function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

  // In production a missing secret is fatal. Silently falling back to a
  // well-known default would let anyone forge login tokens.
  let jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) {
    if (isProduction) {
      throw new Error('JWT_SECRET is required when NODE_ENV=production (generate one with: openssl rand -hex 32)');
    }
    jwtSecret = DEV_JWT_SECRET;
  }

  return Object.freeze({
    nodeEnv,
    isProduction,
    port: parsePositiveInt('PORT', env.PORT, 3000),
    appVersion: env.APP_VERSION || 'dev',

    jwtSecret,
    jwtExpiresIn: parseExpiresIn(env.JWT_EXPIRES_IN),
    // Secure cookies are only sent over HTTPS. Production sits behind TLS on
    // the edge proxy, so default to true there (stages 1-2 of the workshop set
    // COOKIE_SECURE=false while the site is still plain HTTP); dev defaults to false.
    cookieSecure: parseBoolean('COOKIE_SECURE', env.COOKIE_SECURE, isProduction),
    authRateLimitMax: parsePositiveInt('AUTH_RATE_LIMIT_MAX', env.AUTH_RATE_LIMIT_MAX, 30),

    // We deliberately use the standard libpq variable names (PGHOST, PGUSER,
    // ...). `psql` and every other Postgres tool understand them too, so the
    // same env works for debugging: `docker compose exec backend env | grep PG`.
    db: {
      host: env.PGHOST || 'localhost',
      port: parsePositiveInt('PGPORT', env.PGPORT, 5432),
      database: env.PGDATABASE || 'bugsquash',
      user: env.PGUSER || 'bugsquash',
      password: env.PGPASSWORD,
    },
  });
}

module.exports = { loadConfig, DEV_JWT_SECRET };
