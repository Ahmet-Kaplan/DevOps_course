'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig, DEV_JWT_SECRET } = require('../src/config');

describe('loadConfig', () => {
  it('works with an empty environment (local dev defaults)', () => {
    const config = loadConfig({});
    assert.equal(config.nodeEnv, 'development');
    assert.equal(config.port, 3000);
    assert.equal(config.appVersion, 'dev');
    assert.equal(config.jwtSecret, DEV_JWT_SECRET);
    assert.equal(config.jwtExpiresIn, '7d');
    assert.equal(config.cookieSecure, false);
    assert.equal(config.authRateLimitMax, 30);
    assert.deepEqual(config.db, {
      host: 'localhost',
      port: 5432,
      database: 'bugsquash',
      user: 'bugsquash',
      password: undefined,
    });
  });

  it('fails fast in production without JWT_SECRET', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /JWT_SECRET is required/);
  });

  it('defaults to Secure cookies in production, overridable with COOKIE_SECURE', () => {
    assert.equal(loadConfig({ NODE_ENV: 'production', JWT_SECRET: 's' }).cookieSecure, true);
    assert.equal(loadConfig({ NODE_ENV: 'production', JWT_SECRET: 's', COOKIE_SECURE: 'false' }).cookieSecure, false);
    assert.equal(loadConfig({ COOKIE_SECURE: 'TRUE' }).cookieSecure, true);
    assert.throws(() => loadConfig({ COOKIE_SECURE: 'yes' }), /COOKIE_SECURE/);
  });

  it('reads the standard PG* variables', () => {
    const { db } = loadConfig({ PGHOST: 'db', PGPORT: '6543', PGDATABASE: 'd', PGUSER: 'u', PGPASSWORD: 'p' });
    assert.deepEqual(db, { host: 'db', port: 6543, database: 'd', user: 'u', password: 'p' });
  });

  it('treats a unit-less JWT_EXPIRES_IN as seconds, not milliseconds', () => {
    assert.equal(loadConfig({ JWT_EXPIRES_IN: '3600' }).jwtExpiresIn, 3600);
    assert.equal(loadConfig({ JWT_EXPIRES_IN: '12h' }).jwtExpiresIn, '12h');
    assert.throws(() => loadConfig({ JWT_EXPIRES_IN: 'forever' }), /JWT_EXPIRES_IN/);
  });

  it('rejects invalid numbers instead of silently using NaN', () => {
    assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
    assert.throws(() => loadConfig({ AUTH_RATE_LIMIT_MAX: '0' }), /AUTH_RATE_LIMIT_MAX/);
  });

  it('returns a frozen object', () => {
    assert.ok(Object.isFrozen(loadConfig({})));
  });
});
