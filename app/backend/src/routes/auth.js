'use strict';

/**
 * /api/auth — sign up, log in, log out, "who am I?".
 *
 * Express 5 note: a handler that is `async` and throws (or whose promise
 * rejects) is forwarded to the error-handling middleware automatically.
 * Express 4 needed try/catch or a wrapper in every async route.
 */

const { Router } = require('express');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');

const { validateCredentials, validateLoginInput } = require('../validation');
const { setAuthCookie, clearAuthCookie } = require('../middleware/auth');

// bcrypt's cost factor: 2^10 rounds of key stretching (~50-100 ms per hash).
// Slow on purpose — cheap for one login, very expensive for an attacker
// trying billions of guesses against a stolen database dump.
const BCRYPT_COST = 10;

const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

const INVALID_LOGIN = 'Invalid username or password';

// Computed once, lazily. Used to burn the same CPU time when a username does
// not exist, so response timing does not reveal which usernames are registered.
let dummyHashPromise;
const getDummyHash = () => {
  dummyHashPromise ??= bcrypt.hash('timing-attack-equalizer', BCRYPT_COST);
  return dummyHashPromise;
};

function createAuthRouter({ db, config, requireAuth }) {
  const router = Router();

  // Brute-force protection: at most N signup/login attempts per client IP per
  // 15 minutes. The IP comes from req.ip, which is only correct because
  // app.js configures 'trust proxy' (we sit behind one or two nginx proxies).
  // The counter lives in process memory: fine for one replica; several
  // replicas would share a store such as Redis instead.
  const authLimiter = rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    limit: config.authRateLimitMax,
    standardHeaders: 'draft-8', // RateLimit / RateLimit-Policy response headers
    legacyHeaders: false, // no X-RateLimit-* headers
    message: { error: 'Too many attempts. The bugs need a break too - try again in 15 minutes.' },
  });

  router.post('/signup', authLimiter, async (req, res) => {
    const result = validateCredentials(req.body);
    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }
    const { username, password } = result.value;

    // Never store passwords, only a salted, slow hash of them.
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    // No "SELECT first, then INSERT": that would race with a parallel sign-up.
    // We just INSERT and let the unique index decide (db returns null if taken).
    const user = await db.createUser(username, passwordHash);
    if (!user) {
      return res.status(409).json({ error: 'That username is already taken' });
    }

    setAuthCookie(res, user, config);
    return res.status(201).json({ user: { id: user.id, username: user.username } });
  });

  router.post('/login', authLimiter, async (req, res) => {
    const result = validateLoginInput(req.body);
    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }
    const { username, password } = result.value;

    const user = await db.findUserByUsername(username);
    // Same work and the same message whether the user exists or not: an
    // attacker must not be able to tell "unknown user" from "wrong password".
    const hash = user ? user.passwordHash : await getDummyHash();
    // bcrypt silently ignores bytes after the 72nd, so "<real password>+junk"
    // would match. Sign-up never accepts > 72 bytes, so reject those outright.
    const passwordOk = !bcrypt.truncates(password) && (await bcrypt.compare(password, hash));
    if (!user || !passwordOk) {
      return res.status(401).json({ error: INVALID_LOGIN });
    }

    setAuthCookie(res, user, config);
    return res.status(200).json({ user: { id: user.id, username: user.username } });
  });

  // Logging out of a stateless JWT session = telling the browser to delete
  // the cookie. (The token itself stays valid until it expires; real revocation
  // would need a server-side denylist or short-lived tokens + refresh tokens.)
  router.post('/logout', (req, res) => {
    clearAuthCookie(res, config);
    res.status(204).end();
  });

  router.get('/me', requireAuth, async (req, res) => {
    // The JWT proves who the user *was* when the token was issued. Confirm the
    // account still exists (e.g. after `docker compose down -v` wiped the DB).
    const user = await db.findUserById(req.user.id);
    if (!user) {
      clearAuthCookie(res, config);
      return res.status(401).json({ error: 'Account no longer exists, please sign up again' });
    }
    return res.json({ user: { id: user.id, username: user.username } });
  });

  return router;
}

module.exports = { createAuthRouter, BCRYPT_COST };
