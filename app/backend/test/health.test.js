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

  it('returns 200 with only status and version when the DB is up', async () => {
    const res = await t.request('GET', '/api/health');
    assert.equal(res.status, 200);
    // The endpoint is public: it must not reveal internals (database, uptime).
    assert.deepEqual(res.body, { status: 'ok', version: 'test-1.2.3' });
  });

  it('returns 503 without revealing why when the DB is down', async (ctx) => {
    t.db.state.healthy = false;
    // The reason is logged for operators; silence it in the test output.
    ctx.mock.method(console, 'error', () => {});
    try {
      const res = await t.request('GET', '/api/health');
      assert.equal(res.status, 503);
      assert.deepEqual(res.body, { status: 'error', version: 'test-1.2.3' });
      assert.equal(console.error.mock.callCount(), 1, 'the reason must be logged server-side');
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
