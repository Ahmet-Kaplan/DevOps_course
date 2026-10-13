'use strict';

/**
 * Authentication: stateless JWTs stored in an httpOnly cookie.
 *
 * Why a cookie and not localStorage?
 *   - httpOnly: page JavaScript cannot read the token, so an XSS bug cannot
 *     steal it.
 *   - SameSite=Lax: the browser does not attach the cookie to cross-site
 *     POSTs, which blocks classic CSRF against our JSON API.
 *   - Secure (production): only ever sent over HTTPS.
 *   - The frontend and the API share one origin (nginx proxies /api/), so the
 *     browser sends the cookie automatically and no CORS setup is needed.
 *
 * Why a JWT? The token is signed with JWT_SECRET, so the server can verify it
 * without a session table. Any backend replica holding the same secret can
 * check it — handy when scaling horizontally.
 */

const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'bugsquash_token';

// Pin the algorithm. Accepting whatever "alg" the token header claims is a
// classic JWT vulnerability (e.g. "alg": "none").
const JWT_ALGORITHM = 'HS256';

function baseCookieOptions(config) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
  };
}

/** Sign a token for `user` and attach it to the response as the auth cookie. */
function setAuthCookie(res, user, config) {
  // "sub" (subject) is a standard JWT claim; the spec says it is a string.
  const token = jwt.sign({ username: user.username }, config.jwtSecret, {
    subject: String(user.id),
    expiresIn: config.jwtExpiresIn,
    algorithm: JWT_ALGORITHM,
  });

  // Derive the cookie lifetime from the token itself, so cookie and token
  // always expire together whatever format JWT_EXPIRES_IN uses ("7d", "12h", 3600).
  const { iat, exp } = jwt.decode(token);
  res.cookie(COOKIE_NAME, token, { ...baseCookieOptions(config), maxAge: (exp - iat) * 1000 });
}

function clearAuthCookie(res, config) {
  // The browser only deletes a cookie if path/domain/flags match how it was set.
  res.clearCookie(COOKIE_NAME, baseCookieOptions(config));
}

/**
 * Middleware factory. Verifies the cookie and exposes `req.user = { id, username }`
 * to the route, or answers 401 itself.
 */
function createRequireAuth(config) {
  return function requireAuth(req, res, next) {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    try {
      const payload = jwt.verify(token, config.jwtSecret, { algorithms: [JWT_ALGORITHM] });
      const id = Number(payload.sub);
      if (!Number.isInteger(id) || typeof payload.username !== 'string') {
        throw new Error('malformed payload');
      }
      req.user = { id, username: payload.username };
      return next();
    } catch {
      // Expired, tampered with, or signed with another secret (e.g. after
      // JWT_SECRET was rotated): drop the stale cookie so the client starts clean.
      clearAuthCookie(res, config);
      return res.status(401).json({ error: 'Session expired or invalid, please log in again' });
    }
  };
}

module.exports = { COOKIE_NAME, setAuthCookie, clearAuthCookie, createRequireAuth };
