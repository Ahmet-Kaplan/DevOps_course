'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, signupAndGetCookie } = require('./helpers');

describe('score routes', () => {
  let t;
  let alice;
  let bob;

  before(async () => {
    t = await startTestServer();
    alice = await signupAndGetCookie(t.request, 'alice');
    bob = await signupAndGetCookie(t.request, 'bob');
  });
  after(() => t.close());

  const submit = (cookie, score) => t.request('POST', '/api/scores', { cookie, body: { score } });

  it('requires authentication to submit or read personal scores', async () => {
    assert.equal((await t.request('POST', '/api/scores', { body: { score: 10 } })).status, 401);
    assert.equal((await t.request('GET', '/api/scores/me')).status, 401);
  });

  it('starts with empty stats', async () => {
    const res = await t.request('GET', '/api/scores/me', { cookie: alice });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { best: 0, gamesPlayed: 0, recent: [] });
  });

  it('saves a valid score and returns 201 with id, score and createdAt', async () => {
    const res = await submit(alice, 42);
    assert.equal(res.status, 201);
    assert.equal(res.body.score.score, 42);
    assert.equal(typeof res.body.score.id, 'number');
    assert.ok(!Number.isNaN(Date.parse(res.body.score.createdAt)), 'createdAt is an ISO date');
  });

  it('accepts exactly MAX_SCORE (200) but answers 422 above it', async () => {
    assert.equal((await submit(alice, 200)).status, 201);
    const cheat = await submit(alice, 201);
    assert.equal(cheat.status, 422);
    assert.match(cheat.body.error, /anti-cheat/i);
  });

  it('returns 400 for scores that are not non-negative integers', async () => {
    for (const score of [-1, 3.14, '50', null]) {
      assert.equal((await submit(alice, score)).status, 400, `score ${JSON.stringify(score)}`);
    }
  });

  it('reports best, games played and the latest 10 games newest-first', async () => {
    for (let i = 1; i <= 10; i += 1) await submit(bob, i);
    const res = await t.request('GET', '/api/scores/me', { cookie: bob });
    assert.equal(res.status, 200);
    assert.equal(res.body.best, 10);
    assert.equal(res.body.gamesPlayed, 10);
    assert.equal(res.body.recent.length, 10);
    assert.deepEqual(
      res.body.recent.map((r) => r.score),
      [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    );

    await submit(bob, 11);
    const after11 = await t.request('GET', '/api/scores/me', { cookie: bob });
    assert.equal(after11.body.gamesPlayed, 11);
    assert.equal(after11.body.recent.length, 10, 'capped at 10');
    assert.equal(after11.body.recent[0].score, 11);
  });

  it('only counts the caller\'s own scores', async () => {
    const res = await t.request('GET', '/api/scores/me', { cookie: alice });
    assert.equal(res.body.best, 200);
    assert.equal(res.body.gamesPlayed, 2);
  });

  it('serves a public leaderboard ranked by personal best', async () => {
    const res = await t.request('GET', '/api/scores/leaderboard'); // no cookie
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.leaderboard, [
      { rank: 1, username: 'alice', best: 200 },
      { rank: 2, username: 'bob', best: 11 },
    ]);
  });

  it('returns 401 when a valid token belongs to a deleted account', async () => {
    const cookie = await signupAndGetCookie(t.request, 'vanished');
    t.db.state.users = t.db.state.users.filter((u) => u.username !== 'vanished');
    assert.equal((await submit(cookie, 5)).status, 401);
  });
});
