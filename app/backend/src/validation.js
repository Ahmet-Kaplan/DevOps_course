'use strict';

/**
 * Input validation — pure functions with no Express or database imports, so
 * they are trivial to unit test and reuse.
 *
 * Rule of thumb: never trust the client. The browser form has its own checks
 * for nice UX, but anyone can `curl` the API directly, so the server is the
 * only place where validation actually counts.
 *
 * Each validator returns either { value } on success or { status, error } on
 * failure. The route just forwards status + error to the client; we do not
 * throw exceptions for ordinary, expected bad input.
 */

const USERNAME_MIN = 3;
const USERNAME_MAX = 20;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;

const PASSWORD_MIN = 8;
// bcrypt only looks at the first 72 BYTES of a password and silently ignores
// the rest. We reject longer input instead of pretending it matters.
// Note bytes != characters: "ş" or "ğ" take 2 bytes in UTF-8.
const PASSWORD_MAX = 72;

// Anti-cheat: a human cannot click more than ~20 times per second, so 200
// squashes in a 10-second round is a generous upper bound.
const MAX_SCORE = 200;

function isPlainObject(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body);
}

/** Full rules, used at sign-up when an account is created. */
function validateCredentials(body) {
  if (!isPlainObject(body)) {
    return { status: 400, error: 'Request body must be a JSON object with "username" and "password"' };
  }
  const { username, password } = body;

  if (typeof username !== 'string' || typeof password !== 'string') {
    return { status: 400, error: 'Username and password are required' };
  }
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return { status: 400, error: `Username must be ${USERNAME_MIN}-${USERNAME_MAX} characters long` };
  }
  if (!USERNAME_PATTERN.test(username)) {
    return { status: 400, error: 'Username may only contain letters, digits and underscores' };
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return { status: 400, error: `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters long` };
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX) {
    return { status: 400, error: `Password is too long (bcrypt accepts at most ${PASSWORD_MAX} bytes)` };
  }
  return { value: { username, password } };
}

/**
 * Login only checks the *shape* of the input. Running the sign-up rules here
 * would reveal which rules an existing account satisfies; anything that is
 * well-formed but wrong simply gets the generic 401 from the route.
 */
function validateLoginInput(body) {
  if (!isPlainObject(body)) {
    return { status: 400, error: 'Request body must be a JSON object with "username" and "password"' };
  }
  const { username, password } = body;
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return { status: 400, error: 'Username and password are required' };
  }
  return { value: { username, password } };
}

/**
 * A score must be a non-negative integer (400 otherwise) and at most
 * MAX_SCORE (422 otherwise). 422 "Unprocessable Content" fits the second case:
 * the request is well-formed, it just fails a business rule.
 */
function validateScore(body) {
  const score = isPlainObject(body) ? body.score : undefined;

  // typeof check first: Number.isInteger("5") is false anyway, but being
  // explicit documents that we do NOT coerce strings like "5" or "1e2".
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0) {
    return { status: 400, error: 'Score must be a non-negative integer' };
  }
  if (score > MAX_SCORE) {
    return {
      status: 422,
      error:
        `Nice try, speedrunner! ${score} squashes in 10 seconds? Our anti-cheat ` +
        `exterminator only believes in ${MAX_SCORE} or fewer. Put down the auto-clicker.`,
    };
  }
  return { value: { score } };
}

module.exports = {
  USERNAME_MIN,
  USERNAME_MAX,
  USERNAME_PATTERN,
  PASSWORD_MIN,
  PASSWORD_MAX,
  MAX_SCORE,
  validateCredentials,
  validateLoginInput,
  validateScore,
};
