'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer } = require('./helpers');

describe('GET /api/health and generic app behaviour', () => {
  let t;
  before(async () => {
    t = await startTestServer();
  });
  after(() => t.close());

  it('returns 200 with status, db, version and uptime when the DB is up', async () => {
    const res = await t.request('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.db, 'up');
    assert.equal(res.body.version, 'test-1.2.3');
    assert.ok(Number.isInteger(res.body.uptime) && res.body.uptime >= 0);
  });

  it('returns 503 when the DB is down', async () => {
    t.db.state.healthy = false;
    try {
      const res = await t.request('GET', '/api/health');
      assert.equal(res.status, 503);
      assert.equal(res.body.status, 'error');
      assert.equal(res.body.db, 'down');
      assert.equal(res.body.version, 'test-1.2.3');
    } finally {
      t.db.state.healthy = true;
    }
  });

  it('returns JSON 404 for unknown /api routes', async () => {
    for (const path of ['/api/nope', '/api', '/api/scores/unknown/deeper']) {
      const res = await t.request('GET', path);
      assert.equal(res.status, 404, path);
      assert.deepEqual(res.body, { error: 'Not found' });
    }
  });

  it('returns 400 (not 500) for malformed JSON bodies', async () => {
    const res = await t.request('POST', '/api/auth/login', { rawBody: '{"username": "oops"' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Malformed JSON/);
  });

  it('returns 413 for oversized bodies', async () => {
    const res = await t.request('POST', '/api/auth/login', { body: { username: 'x', password: 'y'.repeat(20_000) } });
    assert.equal(res.status, 413);
  });

  it('sets security and no-cache headers on API responses', async () => {
    const res = await t.request('GET', '/api/health');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null, 'do not advertise the framework');
    assert.equal(res.headers.get('strict-transport-security'), null, 'HSTS is the TLS terminator\'s job');
  });
});
