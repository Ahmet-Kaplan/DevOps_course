'use strict';

/**
 * /api/scores — submit a round, read your stats, read the public leaderboard.
 */

const { Router } = require('express');
const { validateScore } = require('../validation');

const LEADERBOARD_SIZE = 10;

function createScoresRouter({ db, requireAuth }) {
  const router = Router();

  // Public: anyone may look at the leaderboard (the landing page shows it).
  router.get('/leaderboard', async (req, res) => {
    const leaderboard = await db.getLeaderboard(LEADERBOARD_SIZE);
    res.json({ leaderboard });
  });

  // Everything below needs a logged-in user. The user id ALWAYS comes from
  // the verified token (req.user), never from the request body — otherwise
  // anyone could post scores in someone else's name.
  router.get('/me', requireAuth, async (req, res) => {
    const stats = await db.getUserStats(req.user.id);
    res.json(stats);
  });

  router.post('/', requireAuth, async (req, res) => {
    // Server-side anti-cheat. The game runs in the browser, so a player can
    // send any number they like with curl or DevTools; the server decides
    // what is plausible.
    const result = validateScore(req.body);
    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    const score = await db.insertScore(req.user.id, result.value.score);
    if (!score) {
      // Valid token, but the user row is gone (database was reset).
      return res.status(401).json({ error: 'Account no longer exists, please sign up again' });
    }
    return res.status(201).json({ score });
  });

  return router;
}

module.exports = { createScoresRouter, LEADERBOARD_SIZE };
