# Decimal Handicap Support Handoff

## Goal
Update the database and application to support decimal handicap values consistently.

## Context
The app currently accepts handicaps like `10.2` in the UI and parsing logic, but the database schema defines `players.handicap` as `int`.

## Tasks
1. Update the database schema:
   - Change `players.handicap` from `int` to a decimal-compatible type such as `numeric` or `real`.
   - Update any existing sample data or documentation to reflect the new type.

2. Validate the app-side usage:
   - Ensure `parseHandicap()` continues to accept one decimal place and clamp values appropriately.
   - Confirm `players.handicap` is stored and retrieved correctly as a decimal number.
   - Verify `Golf.allocateStrokes()` and score summaries behave correctly with decimal handicaps.

3. Update any SQL or client code assumptions:
   - If there are any checks or casting assumptions in Supabase policies or queries, ensure they accept decimal values.

4. Add documentation or migration notes for the schema update.

## Notes
- Prefer `numeric(4,1)` or `real` if the goal is to store handicaps with one decimal precision.
- Keep the range clamping behavior from the app logic.
