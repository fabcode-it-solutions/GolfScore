# Course import script (Python, stdlib only)

Ad hoc local script that pulls golf courses from GolfCourseAPI and
upserts them into Supabase's `courses` table, so the app can find
them without spending API calls at runtime later. No dependencies
beyond a normal Python 3 install (`urllib`, `json`, `argparse` — all
standard library).

## How it behaves

- **Flat seed list of search terms.** GolfCourseAPI's `/v1/search`
  matches on course/club name, not location — there's no "courses
  near Charlotte" query. `course_seed_list.json` is just a JSON array
  of terms, e.g. `["Quail Hollow Club", "East Lake Golf Club"]`.
  Specific course names match reliably; broad city-style terms will
  only catch courses whose name happens to contain that word.
  Entries starting with `//` or `#` are treated as comments and
  skipped, so you can still label groups within the flat array if you
  want (see the example file).
- **One search call can import several courses.** Every course
  returned by a search is processed, not just a "best match" — so a
  single call against a term that returns multiple hits gets you
  multiple courses. If a search result already includes full
  hole-level detail (`tees`/`holes`), it's used directly with **zero**
  extra calls. Only when that detail is missing does the script spend
  a second call on `GET /v1/courses/{id}`.
- **No local usage tracking.** The script doesn't check or maintain
  any Supabase usage table. If the API responds `429`, it stops
  immediately, saves progress, and exits non-zero — just re-run once
  your quota resets. `--limit` (default 50) is only a self-imposed
  safety cap, separate from that.
- **Resumable.** `scripts/.import_courses_progress.json` tracks which
  search terms and which individual courses have already been
  resolved, so re-running skips work that's already done (use
  `--retry-failed` to force a retry of anything that errored or came
  back empty).

## One-time setup

1. Copy the example seed list and edit it with the courses you want:
   ```bash
   cp scripts/course_seed_list.example.json scripts/course_seed_list.json
   ```
2. Provide credentials — either:
   - **Environment variables** (recommended, keeps secrets out of files you might commit), or
   - Open `scripts/import_courses.py` and fill in the `HARDCODED_*` constants marked
     `>>> INPUT YOUR VALUES HERE <<<` near the top of the file — useful for a quick one-off
     run without exporting anything. **Don't commit the file with real values filled in.**

   Either way you need:
   - `GOLF_COURSE_API_KEY` — same key given to Supabase as a secret for the Edge Functions.
   - `SUPABASE_URL` — Project Settings → API → Project URL.
   - `SUPABASE_SERVICE_ROLE_KEY` — Project Settings → API → **service_role** key (not the anon key). This bypasses RLS so the script can write regardless of your `courses` table policies. **Never use this key in frontend code.**

## Running it

```bash
SUPABASE_URL=https://yourproject.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=eyJ... \
GOLF_COURSE_API_KEY=your-golfcourseapi-key \
python3 scripts/import_courses.py
```

Or, if you filled in the `HARDCODED_*` constants in the script:
```bash
python3 scripts/import_courses.py
```

Useful flags:

```bash
# Preview what would happen without writing anything
python3 scripts/import_courses.py --dry-run

# Lower your own self-imposed cap for this run
python3 scripts/import_courses.py --limit 10

# Re-attempt entries previously marked "not found" or "error"
python3 scripts/import_courses.py --retry-failed

# Use a different seed file
python3 scripts/import_courses.py --seed path/to/other_list.json
```

## What it does, per search term

1. `GET /v1/search?search_query=<term>` (1 call).
2. For each course in the results:
   - If it already has embedded `tees`/`holes` data → use it as-is.
   - Otherwise, `GET /v1/courses/{id}` (1 more call) to get par/handicap
     per hole.
3. Skip (and log) anything that doesn't come back with 9 or 18 holes,
   since that violates the `courses.hole_count` check constraint.
4. Upsert into `courses`:
   - Existing row with the same `external_id` → update it.
   - Else existing row with the same name + location (e.g. entered
     manually before) → attach the API metadata to that row instead
     of creating a duplicate.
   - Else insert a new row with `source: 'api'`.

## After a run

The console prints a summary (imported / updated / no-results terms /
skipped / errors) and how many calls were used. If it stops early
because of `--limit` or an actual `429`, just run it again later —
already-resolved terms and courses are skipped automatically.
