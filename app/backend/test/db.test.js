'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db');
const { silentLogger } = require('./helpers');

describe('createDb().migrate retry loop', () => {
  it('retries the configured number of times, then fails with a clear error', async () => {
    const warnings = [];
    const logger = { ...silentLogger, warn: (msg) => warnings.push(msg) };
    // Port 1 on localhost refuses connections immediately: a stand-in for
    // "Postgres is not up yet" that needs no real database.
    const db = createDb({ host: '127.0.0.1', port: 1, database: 'x', user: 'x', password: 'x' }, logger);

    const started = Date.now();
    try {
      await assert.rejects(db.migrate({ attempts: 3, delayMs: 20 }), /not reachable after 3 attempts/);
      assert.equal(warnings.length, 2, 'warns before each retry, not after the final failure');
      assert.ok(Date.now() - started >= 40, 'waits between attempts');
    } finally {
      await db.close();
    }
  });
});
