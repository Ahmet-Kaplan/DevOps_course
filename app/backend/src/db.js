'use strict';

/**
 * Data access layer (a small "repository").
 *
 * Routes never write SQL themselves; they call the methods returned by
 * createDb(). This keeps SQL in one file AND gives us a seam for testing:
 * unit tests pass an in-memory object with the same methods to createApp(),
 * so they run in milliseconds without a Postgres container.
 *
 * Every query uses placeholders ($1, $2 ...). The driver sends values
 * separately from the SQL text, which makes SQL injection impossible here.
 * Never build SQL with string concatenation of user input.
 */

const { Pool } = require('pg');

// Postgres error codes we translate into domain results.
// Full list: https://www.postgresql.org/docs/current/errcodes-appendix.html
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

// Arbitrary constant used as the advisory lock id for migrations (see below).
const MIGRATION_LOCK_ID = 727_001;

/**
 * Idempotent schema: safe to run on every start-up. `IF NOT EXISTS` turns a
 * second run into a no-op, so we need no separate migration tool for a
 * schema this small. (Bigger projects use versioned migrations instead,
 * e.g. node-pg-migrate, Flyway or Prisma Migrate.)
 */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(20) NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Uniqueness is enforced on LOWER(username) so "Alice" and "alice" cannot
  -- both exist. The database, not application code, is the source of truth:
  -- two simultaneous sign-ups cannot both win a race against this index.
  CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_key
    ON users (LOWER(username));

  CREATE TABLE IF NOT EXISTS scores (
    id         SERIAL PRIMARY KEY,
    user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    score      INT NOT NULL CHECK (score >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Every dashboard/leaderboard query filters or groups by user_id.
  CREATE INDEX IF NOT EXISTS scores_user_id_idx ON scores (user_id);
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Map a DB row to the JSON shape promised by the API contract. */
const toScore = (row) => ({ id: row.id, score: row.score, createdAt: row.created_at });

/**
 * @param {object} dbConfig  config.db from loadConfig()
 * @param {object} [logger]  anything with info/warn/error (defaults to console)
 */
function createDb(dbConfig, logger = console) {
  // A Pool keeps a handful of open TCP connections to Postgres and lends them
  // out per query. Opening a connection costs a TCP + auth handshake, so
  // reusing them is much faster than connecting for every HTTP request.
  const pool = new Pool({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    max: 10, // the backend container is memory-limited; 10 is plenty here
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000, // fail fast instead of hanging forever
  });

  // An idle client can die if Postgres restarts. Without this listener the
  // 'error' event would be unhandled and crash the whole process.
  pool.on('error', (err) => logger.error(`[db] idle client error: ${err.message}`));

  return {
    pool,

    /**
     * Create the schema, retrying while Postgres is still starting.
     *
     * Even with compose's `depends_on: condition: service_healthy`, the
     * database can be briefly unreachable (first-boot initialisation, a
     * restart, DNS for the "db" service not ready yet). Retrying with a delay
     * makes start-up robust instead of order-dependent.
     */
    async migrate({ attempts = 10, delayMs = 2_000 } = {}) {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const client = await pool.connect();
          let failure;
          try {
            await client.query('BEGIN');
            // If several backend replicas start together, they would all run
            // CREATE TABLE at once and could collide. A transaction-scoped
            // advisory lock makes them take turns; it is released on COMMIT.
            await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
            await client.query(SCHEMA_SQL);
            await client.query('COMMIT');
          } catch (err) {
            failure = err;
            await client.query('ROLLBACK').catch(() => {});
            throw err;
          } finally {
            // Passing an error to release() destroys the connection instead of
            // returning a possibly broken one to the pool.
            client.release(failure);
          }
          logger.info(`[db] schema ready (attempt ${attempt}/${attempts})`);
          return;
        } catch (err) {
          if (attempt === attempts) {
            throw new Error(`Database not reachable after ${attempts} attempts: ${err.message}`, { cause: err });
          }
          logger.warn(`[db] not ready (attempt ${attempt}/${attempts}): ${err.message} - retrying in ${delayMs} ms`);
          await sleep(delayMs);
        }
      }
    },

    /**
     * Cheap probe for /api/health. The whole check (getting a connection AND
     * running the query) is capped, so an unreachable DB yields a fast 503
     * instead of outlasting the Docker HEALTHCHECK timeout (5 s).
     */
    async ping(timeoutMs = 2_000) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`DB ping timed out after ${timeoutMs} ms`)), timeoutMs);
      });
      try {
        await Promise.race([pool.query({ text: 'SELECT 1', query_timeout: timeoutMs }), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },

    /** @returns {{id, username} | null} null when the username is taken. */
    async createUser(username, passwordHash) {
      try {
        const { rows } = await pool.query(
          'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
          [username, passwordHash],
        );
        return rows[0];
      } catch (err) {
        if (err.code === PG_UNIQUE_VIOLATION) return null;
        throw err;
      }
    },

    /** Case-insensitive lookup; `LOWER(username)` matches the unique index, so it is an index scan. */
    async findUserByUsername(username) {
      const { rows } = await pool.query(
        'SELECT id, username, password_hash FROM users WHERE LOWER(username) = LOWER($1)',
        [username],
      );
      if (rows.length === 0) return null;
      return { id: rows[0].id, username: rows[0].username, passwordHash: rows[0].password_hash };
    },

    async findUserById(id) {
      const { rows } = await pool.query('SELECT id, username FROM users WHERE id = $1', [id]);
      return rows[0] || null;
    },

    /** @returns {{id, score, createdAt} | null} null when the user no longer exists. */
    async insertScore(userId, score) {
      try {
        const { rows } = await pool.query(
          'INSERT INTO scores (user_id, score) VALUES ($1, $2) RETURNING id, score, created_at',
          [userId, score],
        );
        return toScore(rows[0]);
      } catch (err) {
        if (err.code === PG_FOREIGN_KEY_VIOLATION) return null;
        throw err;
      }
    },

    async getUserStats(userId) {
      // COUNT() returns BIGINT, which node-postgres hands back as a *string*
      // (JS numbers cannot hold every 64-bit integer). ::int keeps it a number.
      const [summary, recent] = await Promise.all([
        pool.query(
          'SELECT COALESCE(MAX(score), 0)::int AS best, COUNT(*)::int AS games_played FROM scores WHERE user_id = $1',
          [userId],
        ),
        pool.query(
          'SELECT id, score, created_at FROM scores WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 10',
          [userId],
        ),
      ]);
      return {
        best: summary.rows[0].best,
        gamesPlayed: summary.rows[0].games_played,
        recent: recent.rows.map(toScore),
      };
    },

    /** Top players by personal best. RANK() gives tied players the same rank (1, 1, 3 ...). */
    async getLeaderboard(limit = 10) {
      const { rows } = await pool.query(
        `SELECT RANK() OVER (ORDER BY MAX(s.score) DESC)::int AS rank,
                u.username,
                MAX(s.score) AS best
           FROM scores s
           JOIN users u ON u.id = s.user_id
          GROUP BY u.id, u.username
          ORDER BY best DESC, u.username ASC
          LIMIT $1`,
        [limit],
      );
      return rows.map((row) => ({ rank: row.rank, username: row.username, best: row.best }));
    },

    /** Close all pooled connections (used during graceful shutdown). */
    async close() {
      await pool.end();
    },
  };
}

module.exports = { createDb, SCHEMA_SQL };
