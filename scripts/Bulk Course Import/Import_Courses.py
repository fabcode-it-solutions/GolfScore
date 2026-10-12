#!/usr/bin/env python3
"""
scripts/import_courses.py
---------------------------------------------------------
Ad hoc local script: looks up golf courses via the GolfCourseAPI
search endpoint and upserts them into the Supabase `courses` table,
so the app can find them locally without spending API calls at
runtime.

WHY A SEED LIST OF SEARCH TERMS
---------------------------------------------------------
GolfCourseAPI's /v1/search matches on course name or club name
(per its own docs) -- there's no "courses near Charlotte" query.
So this script works off a seed list you maintain
(course_seed_list.json): a flat JSON array of search terms. Specific
course/club names will match reliably; broader terms may or may not
surface much, since matching is name-based, not location-based.

Entries in the seed array starting with "//" or "#" are treated as
comments and skipped -- handy for labeling groups of terms even
though the file itself is just a flat array (JSON has no native
comment syntax).

LEVERAGING SEARCH RESULTS DIRECTLY WHEN POSSIBLE
---------------------------------------------------------
Every course returned by a single search call is imported, not just
the top match -- so one call can load several courses at once. In
practice, GolfCourseAPI's /v1/search response already includes full
hole-level detail (tees/holes) for each result, so the script uses
that directly with zero extra calls. Only if a specific result is
missing that detail does it fall back to a second call on
GET /v1/courses/{id}.

ERROR HANDLING
---------------------------------------------------------
Failed requests are never silently treated as "no results." If a
search or detail call returns a non-200 status, the script prints the
actual HTTP status and response body, and marks that term/course as
"error" (not "done") in the progress file -- so it's automatically
retried on the next run without needing --retry-failed. Only a
genuine zero-result search gets marked "done" with found: 0.

RATE LIMITING
---------------------------------------------------------
No local budget bookkeeping or shared-usage table involved. If the
API responds with 429 (rate limited), the script stops immediately,
saves its progress, and exits -- run it again once your quota resets.
A --limit flag still exists as your own optional self-imposed cap.
As an extra precaution against tripping rate limits in the first
place, the script sleeps 5 seconds between each course it processes
(configurable via DELAY_BETWEEN_COURSES_SECONDS near the top of the
file).

USAGE
---------------------------------------------------------
  cp scripts/course_seed_list.example.json scripts/course_seed_list.json
  # edit course_seed_list.json with the search terms you want

  SUPABASE_URL=... \
  SUPABASE_SERVICE_ROLE_KEY=... \
  GOLF_COURSE_API_KEY=... \
  python3 scripts/import_courses.py [options]

  (Or fill in the HARDCODED_* constants below instead of using env
  vars -- see the "INPUT YOUR VALUES HERE" section.)

OPTIONS
  --limit N          Optional cap on real API calls to make this run.
                      Omit it to run uncapped -- the script relies on
                      an actual 429 response from the API to know
                      when to stop, and bails immediately when that
                      happens.
  --seed path         Path to the seed JSON file
                      (default: scripts/course_seed_list.json).
  --dry-run           Look everything up and print what would happen,
                      but don't write to Supabase.
  --retry-failed      Re-attempt search terms and courses previously
                      marked "not found" / "error" instead of skipping.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_SEED_PATH = SCRIPT_DIR / "course_seed_list.json"
PROGRESS_PATH = SCRIPT_DIR / ".import_courses_progress.json"
DELAY_BETWEEN_COURSES_SECONDS = 5


class RateLimited(Exception):
    """Raised when the GolfCourseAPI returns 429. Always bails the run."""


# ============================================================
# >>> INPUT YOUR VALUES HERE (optional) <<<
# ------------------------------------------------------------
# By default this script reads credentials from environment
# variables (recommended -- keeps secrets out of files you might
# commit). If you'd rather just run this ad hoc without exporting
# env vars each time, fill in the values below instead.
#
#   HARDCODED_SUPABASE_URL               e.g. "https://yourproject.supabase.co"
#   HARDCODED_SUPABASE_SERVICE_ROLE_KEY  Project Settings -> API -> service_role key
#   HARDCODED_GOLF_COURSE_API_KEY        your GolfCourseAPI key
#
# DO NOT COMMIT THIS FILE WITH REAL VALUES FILLED IN.
# Leave any of these as None to fall back to the matching env var.
# ============================================================
HARDCODED_SUPABASE_URL = None
HARDCODED_SUPABASE_SERVICE_ROLE_KEY = None
HARDCODED_GOLF_COURSE_API_KEY = None
# ============================================================


# ---------------------------------------------------------
# Config
# ---------------------------------------------------------
def parse_args():
    p = argparse.ArgumentParser(description="Import golf courses from GolfCourseAPI into Supabase.")
    p.add_argument("--limit", type=int, default=None, help="Optional cap on API calls this run. Omit to run uncapped and rely on 429 to stop.")
    p.add_argument("--seed", type=str, default=None, help="Path to seed JSON file.")
    p.add_argument("--dry-run", action="store_true", help="Don't write to Supabase.")
    p.add_argument("--retry-failed", action="store_true", help="Re-attempt previously failed/not-found entries.")
    return p.parse_args()


def env(name, hardcoded=None, required=True, default=None):
    v = hardcoded or os.environ.get(name, default)
    if required and not v:
        print(f"Missing required value: set the {name} environment variable, "
              f"or fill in the matching HARDCODED_* constant near the top of this file.", file=sys.stderr)
        sys.exit(1)
    return v


ARGS = parse_args()
SUPABASE_URL = env("SUPABASE_URL", hardcoded=HARDCODED_SUPABASE_URL).rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY", hardcoded=HARDCODED_SUPABASE_SERVICE_ROLE_KEY)
GOLF_COURSE_API_KEY = env("GOLF_COURSE_API_KEY", hardcoded=HARDCODED_GOLF_COURSE_API_KEY)
API_BASE_URL = env(
    "GOLF_COURSE_API_BASE_URL", required=False, default="https://api.golfcourseapi.com"
).rstrip("/")

SEED_PATH = Path(ARGS.seed).resolve() if ARGS.seed else DEFAULT_SEED_PATH
DRY_RUN = ARGS.dry_run
RETRY_FAILED = ARGS.retry_failed
CALL_LIMIT = ARGS.limit  # None means uncapped -- only an actual 429 stops the run


def limit_reached(calls_used):
    return CALL_LIMIT is not None and calls_used >= CALL_LIMIT


# ---------------------------------------------------------
# Minimal HTTP helper (stdlib only)
# ---------------------------------------------------------
def http_json(url, headers=None, method="GET", body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            parsed = json.loads(raw) if raw else None
            return resp.status, parsed
    except urllib.error.HTTPError as e:
        raw = e.read()
        if e.code == 429:
            raise RateLimited(f"{url} -> 429: {raw[:300]!r}")
        try:
            parsed = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            parsed = raw.decode("utf-8", errors="replace")
        return e.code, parsed


# ---------------------------------------------------------
# GolfCourseAPI calls
# ---------------------------------------------------------
def api_search(term):
    url = f"{API_BASE_URL}/v1/search?search_query={urllib.parse.quote(term)}"
    headers = {"Authorization": f"Key {GOLF_COURSE_API_KEY}", "Accept": "application/json"}
    status, data = http_json(url, headers=headers)
    if status != 200:
        return None, f"HTTP {status}: {data}"
    if not isinstance(data, dict):
        return None, f"unexpected response shape: {data!r}"
    return data.get("courses") or data.get("results") or [], None


def api_get_course(course_id):
    url = f"{API_BASE_URL}/v1/courses/{course_id}"
    headers = {"Authorization": f"Key {GOLF_COURSE_API_KEY}", "Accept": "application/json"}
    status, data = http_json(url, headers=headers)
    if status != 200:
        return None, f"HTTP {status}: {data}"
    if not isinstance(data, dict):
        return None, f"unexpected response shape: {data!r}"
    # Some responses wrap the course in a "course" key; handle both shapes.
    detail = data.get("course") if isinstance(data.get("course"), dict) else data
    return detail, None


# Mirrors edge-functions/get-golf-course.ts: walk the nested `tees`
# object and return the first non-empty `holes` array found. We don't
# care which tee/gender it came from -- par & handicap rank are
# consistent across tee sets for a given course.
def extract_holes(tees):
    found = []

    def visit(val):
        nonlocal found
        if found or val is None:
            return
        if isinstance(val, list):
            for item in val:
                visit(item)
            return
        if isinstance(val, dict):
            holes = val.get("holes")
            if isinstance(holes, list) and len(holes) > 0:
                found = holes
                return
            for nested in val.values():
                visit(nested)

    visit(tees)
    return found


def format_location(location):
    if not isinstance(location, dict):
        return ""
    parts = [location.get("city"), location.get("state")]
    return ", ".join(p for p in parts if p)


def normalize(s):
    return re.sub(r"\s+", " ", (s or "").strip().lower())


# ---------------------------------------------------------
# Supabase REST helpers (service role key, bypasses RLS)
# ---------------------------------------------------------
def supabase_headers(extra=None):
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    if extra:
        headers.update(extra)
    return headers


def supabase_get(table, query):
    url = f"{SUPABASE_URL}/rest/v1/{table}{query}"
    status, data = http_json(url, headers=supabase_headers())
    if status >= 300:
        raise RuntimeError(f"Supabase GET {table} failed ({status}): {data}")
    return data or []


def supabase_post(table, row):
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    status, data = http_json(url, headers=supabase_headers({"Prefer": "return=representation"}), method="POST", body=row)
    if status >= 300:
        raise RuntimeError(f"Supabase POST {table} failed ({status}): {data}")
    return data


def supabase_patch(table, query, row):
    url = f"{SUPABASE_URL}/rest/v1/{table}{query}"
    status, data = http_json(url, headers=supabase_headers({"Prefer": "return=representation"}), method="PATCH", body=row)
    if status >= 300:
        raise RuntimeError(f"Supabase PATCH {table} failed ({status}): {data}")
    return data


def upsert_course(row):
    if DRY_RUN:
        print(f"   [dry-run] would upsert: {row['name']} — {row['location']} ({row['hole_count']} holes)")
        return "dry-run"

    if row.get("external_id") is not None:
        existing = supabase_get("courses", f"?select=id&external_id=eq.{row['external_id']}")
        if existing:
            supabase_patch("courses", f"?id=eq.{existing[0]['id']}", row)
            return "updated-by-external-id"

    name_q = urllib.parse.quote(row["name"])
    loc_q = urllib.parse.quote(row["location"])
    existing = supabase_get("courses", f"?select=id&name=ilike.{name_q}&location=ilike.{loc_q}")
    if existing:
        supabase_patch("courses", f"?id=eq.{existing[0]['id']}", row)
        return "updated-by-name-location"

    supabase_post("courses", row)
    return "inserted"


# ---------------------------------------------------------
# Progress tracking (resumable across runs, no wasted calls
# re-processing terms/courses already resolved)
# ---------------------------------------------------------
def load_progress():
    try:
        return json.loads(PROGRESS_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"terms": {}, "courses": {}}
    except json.JSONDecodeError:
        print(f"Warning: could not parse {PROGRESS_PATH}, starting fresh.", file=sys.stderr)
        return {"terms": {}, "courses": {}}


def save_progress(progress):
    PROGRESS_PATH.write_text(json.dumps(progress, indent=2) + "\n", encoding="utf-8")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def course_key(external_id, name, location):
    if external_id is not None:
        return f"ext:{external_id}"
    return f"nl:{normalize(name)}|{normalize(location)}"


def is_comment(term):
    return isinstance(term, str) and term.strip().startswith(("//", "#"))


# ---------------------------------------------------------
# Main
# ---------------------------------------------------------
def main():
    if not SEED_PATH.exists():
        print(f"Could not find seed file at {SEED_PATH}.", file=sys.stderr)
        print("Copy scripts/course_seed_list.example.json to scripts/course_seed_list.json and edit it, "
              "or pass --seed path/to/file.json", file=sys.stderr)
        sys.exit(1)

    raw_seed = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    if not isinstance(raw_seed, list):
        print(f"{SEED_PATH} must be a flat JSON array of search-term strings, e.g. "
              '["Quail Hollow Club", "East Lake Golf Club"].', file=sys.stderr)
        sys.exit(1)

    terms = [t for t in raw_seed if isinstance(t, str) and t.strip() and not is_comment(t)]

    progress = load_progress()
    progress.setdefault("terms", {})
    progress.setdefault("courses", {})

    calls_used = 0
    summary = {"imported": 0, "updated": 0, "not_found": 0, "skipped_terms": 0, "skipped_courses": 0, "errors": 0}

    cap_msg = f"Call cap this run: {CALL_LIMIT}" if CALL_LIMIT is not None else "No call cap this run — will run until done or the API returns 429"
    print(f"{cap_msg}{' (dry run — nothing will be written)' if DRY_RUN else ''}\n")

    try:
        for term in terms:
            term_key = normalize(term)
            prior = progress["terms"].get(term_key)
            if prior and prior.get("status") == "done" and not RETRY_FAILED:
                summary["skipped_terms"] += 1
                continue

            if limit_reached(calls_used):
                print(f"\nCall cap reached ({calls_used}/{CALL_LIMIT}) — stopping. Re-run later to continue.")
                save_progress(progress)
                print_summary(calls_used, summary)
                return

            print(f'"{term}" ... ', end="")
            results, err = api_search(term)
            calls_used += 1

            if err is not None:
                print(f"REQUEST FAILED — {err}")
                progress["terms"][term_key] = {"status": "error", "reason": err, "at": now_iso()}
                summary["errors"] += 1
                save_progress(progress)
                continue

            if not results:
                print("no results")
                progress["terms"][term_key] = {"status": "done", "found": 0, "at": now_iso()}
                summary["not_found"] += 1
                save_progress(progress)
                continue

            print(f"{len(results)} result(s)")

            for course in results:
                ext_id = course.get("id")
                name = course.get("course_name") or course.get("club_name") or term
                loc_text = course.get("location_text") or format_location(course.get("location"))
                key = course_key(ext_id, name, loc_text)

                prior_course = progress["courses"].get(key)
                if prior_course and prior_course.get("status") == "imported" and not RETRY_FAILED:
                    summary["skipped_courses"] += 1
                    continue

                try:
                    # Use embedded hole data if the search result already has it;
                    # otherwise spend a second call to fetch full detail.
                    holes = extract_holes(course.get("tees")) if "tees" in course else []
                    detail = course

                    if not holes:
                        if limit_reached(calls_used):
                            print(f"    (skipping detail fetch for \"{name}\" — call cap reached)")
                            continue
                        detail, err = api_get_course(ext_id)
                        calls_used += 1
                        if err is not None:
                            print(f"    \"{name}\": detail request failed — {err}")
                            progress["courses"][key] = {"status": "error", "reason": err, "at": now_iso()}
                            summary["errors"] += 1
                            save_progress(progress)
                            continue
                        holes = extract_holes(detail.get("tees"))

                    if not holes:
                        print(f"    \"{name}\": no hole data available — skipping")
                        progress["courses"][key] = {"status": "error", "reason": "no hole data", "at": now_iso()}
                        summary["errors"] += 1
                        save_progress(progress)
                        continue

                    if len(holes) not in (9, 18):
                        print(f"    \"{name}\": returned {len(holes)} holes (need 9 or 18) — skipping")
                        progress["courses"][key] = {"status": "error", "reason": f"{len(holes)} holes", "at": now_iso()}
                        summary["errors"] += 1
                        save_progress(progress)
                        continue

                    course_name = detail.get("course_name") or detail.get("club_name") or name
                    location = format_location(detail.get("location")) or loc_text or "Unknown"

                    row = {
                        "name": course_name,
                        "location": location,
                        "hole_count": len(holes),
                        "pars": [int(h.get("par") or 0) for h in holes],
                        "stroke_index": [int(h.get("handicap") or h.get("stroke_index") or 0) for h in holes],
                        "source": "api",
                        "external_id": detail.get("id", ext_id),
                        "api_club_name": detail.get("club_name"),
                        "api_location": detail.get("location"),
                    }

                    try:
                        action = upsert_course(row)
                    except Exception as e:
                        print(f"    \"{course_name}\": Supabase write failed — {e}")
                        progress["courses"][key] = {"status": "error", "reason": str(e), "at": now_iso()}
                        summary["errors"] += 1
                        save_progress(progress)
                        continue

                    print(f"    {action} — {course_name} ({location}), {row['hole_count']} holes")
                    progress["courses"][key] = {"status": "imported", "externalId": row["external_id"], "at": now_iso()}
                    if action == "inserted":
                        summary["imported"] += 1
                    else:
                        summary["updated"] += 1
                    save_progress(progress)
                finally:
                    # Rate-limiting precaution: pause between courses regardless
                    # of how this one turned out (success, error, or skip due
                    # to a spent call budget).
                    time.sleep(DELAY_BETWEEN_COURSES_SECONDS)

            progress["terms"][term_key] = {"status": "done", "found": len(results), "at": now_iso()}
            save_progress(progress)

    except RateLimited as e:
        print(f"\nRate limited by the API: {e}")
        print("Bailing out immediately — progress saved, re-run once your quota resets.")
        save_progress(progress)
        print_summary(calls_used, summary)
        sys.exit(1)

    save_progress(progress)
    print_summary(calls_used, summary)


def print_summary(calls_used, summary):
    print("---------------------------------------------")
    print(f"Calls used this run: {calls_used}")
    print(
        f"Imported: {summary['imported']}  Updated: {summary['updated']}  "
        f"Search terms with no results: {summary['not_found']}  "
        f"Skipped terms (already done): {summary['skipped_terms']}  "
        f"Skipped courses (already imported): {summary['skipped_courses']}  "
        f"Errors: {summary['errors']}"
    )
    print(f"Progress saved to {PROGRESS_PATH} — re-run anytime to continue where this left off.")


if __name__ == "__main__":
    main()