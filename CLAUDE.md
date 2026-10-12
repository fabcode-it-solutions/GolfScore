# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # install dev deps (vitest only)
npm test           # run the Vitest scoring suite (tests/golf.test.js)
```

Run a single test by name or file:

```bash
npx vitest run -t "gives one stroke to the hardest"   # by test name
npx vitest run tests/golf.test.js                      # by file
npx vitest                                             # watch mode
```

There is **no build, bundler, or lint step** — the app is plain HTML/CSS/JS served as static files. To run it locally, serve the repo root over HTTP (fonts and Supabase calls won't work from `file://`):

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

Deployment is Vercel (static hosting) + Supabase (auth, Postgres, realtime, Edge Functions). See `documentation/SETUP.md` for the full from-scratch setup.

## Architecture

**No modules, no bundler — a single global namespace.** Every `assets/*.js` file runs at the top level and shares state through globals. There are no `import`/`export` statements in the browser code. This has two hard consequences:

- **Script load order in `index.html` is the dependency graph** (`<script>` tags near line 817). Order is: `supabase-config.js` → `golf.js` → `core.js` → feature files → `app.js` (last). A file may only rely on globals defined by a file loaded before it. If you add a file, insert its tag in the right position.
- **Shared state lives in the `state` object** defined in `assets/core.js`. Feature files read and mutate `state.round`, `state.myPlayerId`, `state.roundCode`, etc. directly. `core.js` also owns the cross-cutting helpers (`showScreen`, `showToast`, `escapeHtml`, session persistence). The Supabase client is the global `supabaseClient` from `supabase-config.js`.

**`assets/golf.js` is the pure scoring core** — no DOM, no network. It's an IIFE assigned to the global `Golf`, and its functions (`summarizePlayer`, `rankPlayers`, `computeSkins`, `computeMatchPlay`, `computeMoney`, `allocateStrokes`, …) take plain data and return plain data. It also does `module.exports = Golf` at the bottom so Vitest can import it in Node. **This is the only file with test coverage, and the only one that should carry scoring logic** — keep DOM/Supabase concerns out of it so the tests stay meaningful. Everything else (leaderboards, scorecard) calls `Golf.*` for the math and only handles rendering and sync.

**Data model and realtime.** Each hole score is its own row in the `scores` table, which keeps concurrent updates conflict-free. The leaderboard stays live via Supabase realtime subscriptions on `rounds`, `players`, and `scores` — mutations propagate without page refresh, so UI code generally writes to Supabase and lets the subscription drive the re-render, rather than updating the DOM directly. Server-authoritative operations go through RPCs, not direct table writes:

- `host_upsert_score` — host entering a score on another player's behalf
- `end_round` — flips `rounds.ended` (broadcasts live to all clients)
- `archive_round` — snapshots the finished round into `completed_rounds` and deletes the live row; this snapshot is what `history.js` reads

The schema, realtime publication, and row-level security are all in `supabase_schema.sql`.

**Golf Course API is proxied, never called from the browser.** `edge-functions/search-golf-course/` and `edge-functions/get-golf-course/` are Supabase Edge Functions that hold the API key server-side and enforce an app-wide daily call cap tracked in `api_usage`. Imported courses are cached in the `courses` table (tagged `source = 'api'` with their external ID); re-searching reuses the cached copy. When the daily cap is hit, search silently falls back to local-only results. `courses.js` is the client side of this.

**Handicaps are decimal.** Parse user input through `parseHandicap()` — one decimal place, clamped to `0–54`. The DB column `players.handicap` is `numeric(4,1)` to preserve that precision. Don't round to integers anywhere in the scoring path.

## Conventions

- Each feature file starts with a header comment stating what it does, what it depends on, and where it sits in the load order — keep that up to date when moving code between files.
- All user-supplied strings rendered into HTML go through `escapeHtml` (from `core.js`).
- `index.html` is a single-page shell of hidden `.screen` divs; navigation is `showScreen(id)`, not routing.
- `assets/styles.css` is fully tokenized — fonts are the CSS variables `--font-display` / `--font-body` / `--font-mono` (defined once in `:root`), never hardcoded family names.

## Repo workflow

Code changes go through `feature/*` branches and pull requests into `main`, not direct commits to `main`. CI (`.github/workflows/test.yml`) runs `npm test` on every push and PR.
