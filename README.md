# GolfScore

A live scorecard and leaderboard for golf rounds with friends. Each
player enters their own scores on their phone as they play (or the
host can enter for someone whose phone died mid-round); everyone sees
the leaderboard update in real time across Gross, Net (handicap),
Stableford, Skins, and Match play.

**New to this?** Start with [SETUP.md](./documentation/SETUP.md) — a
step-by-step guide written for zero prior coding experience, covering
GitHub, Supabase, and Vercel from scratch.

## How it works

- Plain HTML/CSS/JS — no build tools, no bundling.
- Hosted on **Vercel** and backed by **Supabase** for auth, Postgres
  storage, realtime updates, and Edge Functions.
- Players sign up or log in with email/password; joining from an
  invite link also offers a guest (anonymous) sign-in. Signed-in users
  get a saved profile (name + default handicap) that pre-fills future
  rounds.
- The host can enter scores on behalf of any player in the round from
  a dropdown on the scorecard tab — handy if someone's phone dies
  mid-round.
- Completed rounds are archived and saved to each participant's round
  history, with a read-only detail view (leaderboard by mode, plus a
  full scorecard grid) for looking back later.
- Course info (name, pars, per-hole handicap ranking) can be searched
  from a personal course library, imported from the Golf Course API,
  or entered manually. API lookups go through Supabase Edge Functions
  so the API key never reaches the browser, and results are cached
  locally to stay under a shared daily call limit.
- The app stores player handicaps as decimal values with one-place
  precision, so inputs like `10.2` are preserved and used consistently
  in scoring and UI display.
- `assets/golf.js` contains the scoring math, while the rest of the
  app handles screens, data syncing, and user interaction.
- Scoring logic is covered by a Vitest test suite (`tests/`), run
  automatically on push/PR via GitHub Actions.

## Code structure

- `index.html` — application shell, screens, and markup.
- `assets/styles.css` — layout, responsive design, and visual styling.
- `assets/supabase-config.js` — Supabase client setup and project keys.
- `assets/golf.js` — pure golf scoring logic: handicap strokes, net
  scores, Stableford points, skins, match play, and rankings.
- `assets/core.js` — shared state, session helpers, and utility
  functions.
- `assets/auth.js` — login/signup flow, guest join, email
  verification, and password reset.
- `assets/courses.js` — the saved course library: search (local +
  Golf Course API), upload/edit/delete, and API import.
- `assets/setup.js` — new round creation, player setup, pars, game
  modes, and match play team assignment.
- `assets/lobby.js` — join rounds, add players, identify yourself, and
  resume a session on reload.
- `assets/round.js` — round state loading, realtime subscriptions,
  round header, tabs, and ending/archiving a round.
- `assets/scorecard.js` — the scorecard (input) tab: hole readout,
  stroke entry, host-on-behalf-of scoring, par editor, and progress
  strip.
- `assets/leaderboard.js` — the leaderboard (output) tab: Gross/Net/
  Stableford boards plus Skins and Match play boards.
- `assets/history.js` — round history list and read-only detail view
  for completed rounds.
- `assets/app.js` — wires up DOM events; loaded last.
- `supabase_schema.sql` — database tables, realtime publication, and
  row-level security for Supabase.
- `edge-functions/search-golf-course/`, `edge-functions/get-golf-course/`
  — Supabase Edge Functions that proxy the Golf Course API, keeping
  the API key server-side and enforcing the daily call limit.
- `GolfCourseAPI.postman_collection.json` — reference collection for
  the third-party Golf Course API used by the edge functions.
- `tests/golf.test.js` — Vitest unit tests for `assets/golf.js`.
- `.github/workflows/test.yml` — CI: runs `npm test` on push/PR.

## Key details

- Player handicap values are parsed with `parseHandicap()` to one
  decimal place and clamped to the valid range `0–54`.
- `players.handicap` is stored as `numeric(4,1)` in the database to
  retain decimal precision.
- The app uses Supabase realtime events on `rounds`, `players`, and
  `scores` so leaderboard updates propagate without page refreshes.
- Each hole score is stored as its own row in `scores`, which keeps
  updates lightweight and conflict-free. The host editing on someone
  else's behalf goes through a `host_upsert_score` RPC rather than a
  direct table write.
- On signup, user profile data is saved to `user_profiles`, including
  a default handicap for future rounds.
- Saved courses live in a `courses` table, tagged by `source`
  (`manual` or `api`); API-imported courses store their external ID so
  re-searching the same course reuses the cached copy instead of
  calling the API again.
- Daily Golf Course API usage is tracked app-wide in `api_usage` and
  capped (see `edge-functions/`); once the limit is hit, search
  silently falls back to local-only results.
- Ending a round runs an `end_round` RPC (flips `rounds.ended`, which
  broadcasts to everyone live) followed by an `archive_round` RPC that
  snapshots the round into `completed_rounds` and removes the live
  row — this snapshot is what powers round history.

## Running tests

```
npm install
npm test
```
