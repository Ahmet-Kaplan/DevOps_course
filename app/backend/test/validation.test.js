'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_SCORE,
  validateCredentials,
  validateLoginInput,
  validateScore,
} = require('../src/validation');

describe('validateCredentials (sign-up rules)', () => {
  const ok = (username, password = 'password123') => validateCredentials({ username, password });

  it('accepts a valid username/password', () => {
    assert.deepEqual(ok('bug_hunter_42'), { value: { username: 'bug_hunter_42', password: 'password123' } });
  });

  it('enforces username length 3-20', () => {
    assert.equal(ok('ab').status, 400);
    assert.ok(ok('abc').value);
    assert.ok(ok('a'.repeat(20)).value);
    assert.equal(ok('a'.repeat(21)).status, 400);
  });

  it('only allows letters, digits and underscores in usernames', () => {
    for (const bad of ['has space', 'dash-name', 'dot.name', 'tab\tname', "o'neil", 'şeker']) {
      assert.equal(ok(bad).status, 400, `expected "${bad}" to be rejected`);
    }
  });

  it('enforces password length 8-72', () => {
    assert.equal(ok('alice', 'short').status, 400);
    assert.ok(ok('alice', 'x'.repeat(8)).value);
    assert.ok(ok('alice', 'x'.repeat(72)).value);
    assert.equal(ok('alice', 'x'.repeat(73)).status, 400);
  });

  it('rejects passwords over 72 BYTES even if under 72 characters (bcrypt limit)', () => {
    const turkish = 'ğ'.repeat(40); // 40 characters, but 80 bytes in UTF-8
    const result = ok('alice', turkish);
    assert.equal(result.status, 400);
    assert.match(result.error, /bytes/);
  });

  it('rejects missing fields, wrong types and non-object bodies', () => {
    for (const body of [undefined, null, 'text', [], {}, { username: 'alice' }, { username: 123, password: 'password123' }]) {
      assert.equal(validateCredentials(body).status, 400, `body ${JSON.stringify(body)}`);
    }
  });
});

describe('validateLoginInput (shape only)', () => {
  it('accepts any non-empty strings', () => {
    assert.ok(validateLoginInput({ username: 'x', password: 'y' }).value);
  });

  it('rejects empty or missing values with 400', () => {
    assert.equal(validateLoginInput({ username: '', password: 'y' }).status, 400);
    assert.equal(validateLoginInput({ username: 'x' }).status, 400);
    assert.equal(validateLoginInput(undefined).status, 400);
  });
});

describe('validateScore (anti-cheat)', () => {
  it('accepts integers from 0 to MAX_SCORE', () => {
    assert.equal(MAX_SCORE, 200);
    for (const score of [0, 1, 57, MAX_SCORE]) {
      assert.deepEqual(validateScore({ score }), { value: { score } });
    }
  });

  it('returns 400 for anything that is not a non-negative integer', () => {
    for (const score of [-1, 1.5, '42', null, undefined, NaN, Infinity, true, [5], { n: 5 }]) {
      assert.equal(validateScore({ score }).status, 400, `score ${String(score)}`);
    }
    assert.equal(validateScore(undefined).status, 400);
  });

  it('returns 422 with a funny message above MAX_SCORE', () => {
    const result = validateScore({ score: MAX_SCORE + 1 });
    assert.equal(result.status, 422);
    assert.match(result.error, /anti-cheat/i);
  });
});
