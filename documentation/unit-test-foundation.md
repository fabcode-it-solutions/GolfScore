# Unit Test Foundation Handoff

## Goal
Lay the foundation for unit tests that cover the scoring logic and critical app behavior.

## Context
The app currently has a clean separation between scoring math (`assets/golf.js`) and UI/database logic. This makes it a strong candidate for unit testing.

## Tasks
1. Add a testing framework and initial configuration:
   - Choose a lightweight JS test runner such as Jest, Vitest, or even plain Mocha.
   - Add configuration files if needed: `package.json`, `jest.config.js` or `vitest.config.js`.
   - Ensure tests can run on this project without a build tool if possible.

2. Create a test folder and sample test file:
   - Add `tests/` or `__tests__/`.
   - Create `tests/golf.test.js` or similar.

3. Write tests for core scoring functions in `assets/golf.js`:
   - `allocateStrokes()` with standard and over-handicap cases.
   - `netHoleScore()` returned values for null and numeric input.
   - `stablefordPoints()` for common score differences.
   - `summarizePlayer()` for a small sample round.
   - `rankPlayers()` ordering in `gross`, `net`, and `stableford` modes.
   - `computeSkins()` and `computeMatchPlay()` results for two-player scenarios.

4. Document how to run tests locally:
   - Add a command example such as `npm test` or `npx vitest`.

## Notes
- Keep tests focused on pure functions, not Supabase or DOM behavior.
- The goal is foundation work; one or two test files with multiple assertions is sufficient.
