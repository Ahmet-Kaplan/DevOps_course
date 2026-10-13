'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { startTestServer, testConfig, cookiePair, signupAndGetCookie } = require('./helpers');

const PASSWORD = 'correct-horse-battery';

describe('auth routes', () => {
  let t;
  before(async () => {
    t = await startTestServer();
  });
  after(() => t.close());

  describe('POST /api/auth/signup', () => {
    it('creates a user, returns 201 and sets a hardened auth cookie', async () => {
      const res = await t.request('POST', '/api/auth/signup', { body: { username: 'Squasher', password: PASSWORD } });
      assert.equal(res.status, 201);
      assert.deepEqual(Object.keys(res.body.user).sort(), ['id', 'username']);
      assert.equal(res.body.user.username, 'Squasher');

      assert.ok(res.cookie, 'Set-Cookie bugsquash_token expected');
      assert.match(res.cookie, /HttpOnly/i);
      assert.match(res.cookie, /SameSite=Lax/i);
      assert.match(res.cookie, /Path=\//);
      assert.match(res.cookie, /Max-Age=604800/, '7 days, matching the JWT lifetime');
      assert.doesNotMatch(res.cookie, /Secure/i, 'not Secure unless COOKIE_SECURE');
    });

    it('stores a bcrypt hash, never the password', async () => {
      const stored = t.db.state.users.find((u) => u.username === 'Squasher');
      assert.notEqual(stored.passwordHash, PASSWORD);
      assert.match(stored.passwordHash, /^\$2[aby]\$10\$/, 'bcrypt, cost 10');
    });

    it('returns 409 when the username is taken (case-insensitively)', async () => {
      const res = await t.request('POST', '/api/auth/signup', { body: { username: 'sQuAsHeR', password: PASSWORD } });
      assert.equal(res.status, 409);
      assert.ok(res.body.error);
      assert.equal(res.cookie, undefined);
    });

    it('returns 400 for invalid input', async () => {
      for (const body of [{ username: 'ab', password: PASSWORD }, { username: 'bad name', password: PASSWORD }, { username: 'valid_name', password: 'short' }, {}]) {
        const res = await t.request('POST', '/api/auth/signup', { body });
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(typeof res.body.error, 'string');
      }
    });
  });

  describe('POST /api/auth/login', () => {
    it('logs in with correct credentials (username is case-insensitive)', async () => {
      const res = await t.request('POST', '/api/auth/login', { body: { username: 'squasher', password: PASSWORD } });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.username, 'Squasher', 'returns the name as registered');
      assert.ok(res.cookie);
    });

    it('returns the same 401 for a wrong password and an unknown user', async () => {
      const wrongPassword = await t.request('POST', '/api/auth/login', { body: { username: 'Squasher', password: 'nope-nope-nope' } });
      const unknownUser = await t.request('POST', '/api/auth/login', { body: { username: 'ghost_user', password: PASSWORD } });
      for (const res of [wrongPassword, unknownUser]) {
        assert.equal(res.status, 401);
        assert.deepEqual(res.body, { error: 'Invalid username or password' });
        assert.equal(res.cookie, undefined);
      }
    });

    it('rejects a correct password with extra bytes past bcrypt\'s 72-byte limit', async () => {
      const longPassword = 'p'.repeat(72);
      await signupAndGetCookie(t.request, 'longpass', longPassword);
      const ok = await t.request('POST', '/api/auth/login', { body: { username: 'longpass', password: longPassword } });
      const padded = await t.request('POST', '/api/auth/login', { body: { username: 'longpass', password: `${longPassword}EXTRA` } });
      assert.equal(ok.status, 200);
      assert.equal(padded.status, 401);
    });

    it('returns 400 when fields are missing', async () => {
      const res = await t.request('POST', '/api/auth/login', { body: { username: 'Squasher' } });
      assert.equal(res.status, 400);
    });
  });

  describe('GET /api/auth/me and POST /api/auth/logout', () => {
    it('returns 401 without a cookie', async () => {
      const res = await t.request('GET', '/api/auth/me');
      assert.equal(res.status, 401);
      assert.ok(res.body.error);
    });

    it('returns the current user with a valid cookie', async () => {
      const cookie = await signupAndGetCookie(t.request, 'me_tester');
      const res = await t.request('GET', '/api/auth/me', { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.username, 'me_tester');
      assert.equal(typeof res.body.user.id, 'number');
    });

    it('rejects tokens that are tampered with, forged, alg=none or expired', async () => {
      const { jwtSecret } = t.config;
      const real = cookiePair((await t.request('POST', '/api/auth/login', { body: { username: 'Squasher', password: PASSWORD } })).cookie);
      const [header, payload, signature] = real.split('=')[1].split('.');
      const evilPayload = Buffer.from(JSON.stringify({ sub: '1', username: 'admin' })).toString('base64url');

      const tokens = {
        tampered: `${header}.${evilPayload}.${signature}`,
        wrongSecret: jwt.sign({ username: 'Squasher' }, 'attacker-guess', { subject: '1' }),
        algNone: `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${payload}.`,
        expired: jwt.sign({ username: 'Squasher' }, jwtSecret, { subject: '1', expiresIn: -10 }),
      };
      for (const [name, token] of Object.entries(tokens)) {
        const res = await t.request('GET', '/api/auth/me', { cookie: `bugsquash_token=${token}` });
        assert.equal(res.status, 401, name);
        assert.match(res.cookie ?? '', /bugsquash_token=;/, `${name}: stale cookie should be cleared`);
      }
    });

    it('returns 401 when the account behind a valid token no longer exists', async () => {
      const cookie = await signupAndGetCookie(t.request, 'soon_gone');
      t.db.state.users = t.db.state.users.filter((u) => u.username !== 'soon_gone');
      const res = await t.request('GET', '/api/auth/me', { cookie });
      assert.equal(res.status, 401);
    });

    it('logout returns 204 and expires the cookie', async () => {
      const res = await t.request('POST', '/api/auth/logout');
      assert.equal(res.status, 204);
      assert.match(res.cookie, /bugsquash_token=;/);
      assert.match(res.cookie, /Expires=Thu, 01 Jan 1970/);
    });
  });
});

describe('auth cookie and rate-limit configuration', () => {
  it('marks the cookie Secure when COOKIE_SECURE=true and honours JWT_EXPIRES_IN', async () => {
    const t = await startTestServer({ config: testConfig({ COOKIE_SECURE: 'true', JWT_EXPIRES_IN: '2h' }) });
    try {
      const res = await t.request('POST', '/api/auth/signup', { body: { username: 'secure_one', password: PASSWORD } });
      assert.equal(res.status, 201);
      assert.match(res.cookie, /; Secure/);
      assert.match(res.cookie, /Max-Age=7200/);
    } finally {
      await t.close();
    }
  });

  it('limits signup+login attempts per client IP with 429', async () => {
    const t = await startTestServer({ config: testConfig({ AUTH_RATE_LIMIT_MAX: '3' }) });
    try {
      // We connect from 127.0.0.1, a trusted proxy address, so the app
      // believes X-Forwarded-For — exactly like behind nginx in production.
      const attempt = (ip) =>
        t.request('POST', '/api/auth/login', {
          body: { username: 'nobody', password: 'whatever1' },
          headers: { 'x-forwarded-for': ip },
        });

      for (let i = 0; i < 3; i += 1) assert.equal((await attempt('203.0.113.7')).status, 401);
      const blocked = await attempt('203.0.113.7');
      assert.equal(blocked.status, 429);
      assert.match(blocked.body.error, /Too many attempts/);
      assert.ok(blocked.headers.get('ratelimit'), 'standard RateLimit header present');

      // A different client is unaffected: limits are per IP.
      assert.equal((await attempt('198.51.100.20')).status, 401);
      // Logout and /me are not rate limited.
      assert.equal((await t.request('POST', '/api/auth/logout', { headers: { 'x-forwarded-for': '203.0.113.7' } })).status, 204);
    } finally {
      await t.close();
    }
  });
});
