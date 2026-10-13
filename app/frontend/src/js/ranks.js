/**
 * ranks.js: the jokes, kept as pure data and pure functions.
 *
 * Nothing in here touches the DOM or the network, which makes it trivial to
 * reason about (and to unit-test if you want to add a test runner later).
 *
 * Calibration: a person clicking a bug that teleports every second lands
 * roughly 15-35 hits in 10 seconds. The thresholds are spread around that.
 */

/** Ordered by `min` (best score needed). */
export const RANKS = [
  { min: 0, title: 'Intern', motto: 'Has sudo. Nobody remembers granting it.' },
  { min: 5, title: 'Junior Dev', motto: 'Writes the tests right after the bug report.' },
  { min: 15, title: 'Works on My Machine', motto: 'Ready to ship the laptop if anyone complains.' },
  { min: 25, title: 'Senior Dev', motto: "Answers every question with 'it depends'." },
  { min: 35, title: 'DevOps Wizard', motto: 'Turns YAML into uptime.' },
  { min: 45, title: 'Kernel Hacker', motto: 'Reads strace output for fun.' },
  { min: 60, title: '10x Engineer', motto: 'Also produces 10x the merge conflicts.' },
];

/**
 * Rank for a best score, plus what it takes to reach the next one.
 * `progress` is 0..1 within the current rank band (1 at the top rank).
 */
export function rankFor(best) {
  const score = Math.max(0, Number(best) || 0);
  let index = 0;
  for (let i = 0; i < RANKS.length; i += 1) {
    if (score >= RANKS[i].min) index = i;
  }
  const current = RANKS[index];
  const next = RANKS[index + 1] ?? null;
  const progress = next ? (score - current.min) / (next.min - current.min) : 1;
  return { current, next, toNext: next ? next.min - score : 0, progress };
}

/** End-of-round verdicts, by score band. */
const VERDICTS = [
  { min: 0, text: 'Bold strategy: ship it and let the users find them.' },
  { min: 1, text: "The bugs have filed this under 'minor inconvenience'." },
  { min: 10, text: 'A respectable sprint. The backlog barely noticed.' },
  { min: 20, text: 'Pull request approved with only mildly passive-aggressive comments.' },
  { min: 30, text: 'The pager went quiet. Suspiciously quiet.' },
  { min: 40, text: 'QA would like to know what you had for breakfast.' },
  { min: 55, text: 'Congratulations, you are now the entire on-call rotation.' },
  { min: 80, text: 'Production is spotless. Nobody believes you.' },
];

export function roundVerdict(score) {
  let verdict = VERDICTS[0].text;
  for (const band of VERDICTS) {
    if (score >= band.min) verdict = band.text;
  }
  return verdict;
}

/** "1 bug" / "12 bugs". */
export function bugs(count) {
  return `${count} ${count === 1 ? 'bug' : 'bugs'}`;
}
