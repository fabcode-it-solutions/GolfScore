# GolfScore Security Readiness Handoff

## Purpose

This document is a standalone handoff for continuing the security work on the GolfScore application. It is written so another coding agent or chat can resume implementation without needing the prior conversation.

The application is currently a static HTML/CSS/JavaScript app backed by Supabase. It is not yet an iOS project. The eventual App Store packaging decision is still open: Capacitor/WebView versus a native Swift/SwiftUI client.

## Repository Context

- Repository: `Strokes-golf-app/scores`
- Current feature branch at handoff: `feature/SecurityFixes082526`
- Default branch: `main`
- Supabase schema: `supabase_schema.sql`
- Browser code: `assets/*.js`, loaded as global scripts in `index.html`
- Scoring core: `assets/golf.js`; keep scoring logic there and do not mix it with authorization logic
- Existing automated test: `tests/golf.test.js`
- Test command: `npm test`
- Static app; no build or lint step is currently configured
- Supabase migrations are currently maintained in the root schema file, not a formal migrations directory

## Work Already Completed

The following security changes have already been implemented and applied to the Supabase project.

### Commit 1: Round membership authorization

Commit: `2fbb0a0 fix: harden round membership authorization`

Files:

- `assets/core.js`
- `assets/lobby.js`
- `supabase_schema.sql`

Changes:

- Round codes are generated with `crypto.getRandomValues()` instead of `Math.random()`.
- New round codes are 8 characters instead of 5. Existing 5-character codes remain accepted by the SQL validation for backward compatibility.
- Pre-join RPCs require an authenticated Supabase session.
- Added `join_round(p_round_code, p_name, p_handicap)` as a server-side join operation.
- Added a unique partial index preventing one authenticated user from having multiple player rows in the same round.
- Direct client self-insertion into `players` was removed from the client flow.
- Direct takeover of unclaimed player rows through the old permissive policy was closed.
- Anonymous execution of protected round RPCs was revoked.
- Realtime publication setup was made rerunnable.
- RLS policies are dropped and recreated so the schema can be reapplied to an existing project.

### Commit 2: Pre-join and invite protection

Commit: `0ed8b23 fix: secure pre-join round access`

Files:

- `assets/app.js`
- `assets/lobby.js`
- `assets/round.js`
- `index.html`
- `supabase_schema.sql`

Changes:

- `find_round_by_code` returns only `id`, `course_name`, and `joinable` instead of the full `rounds` row.
- `get_round_state` returns full state only when the authenticated user is already a member of that round.
- Added `rounds.invite_expires_at`, defaulting to 7 days for new rounds and existing rows when the column is added.
- Added `rounds.invite_revoked`.
- Added host-only `revoke_round_invite(p_round_id)` RPC and a lobby button labeled `Stop accepting joins`.
- Added `round_lookup_attempts`, protected by RLS and revoked direct client table access.
- Lookup, claim, and join attempts are limited to 20 per authenticated user per 10-minute window.
- Round-code validation accepts 5 to 32 characters from the unambiguous code alphabet.
- The pre-join UI no longer receives or displays the roster, handicaps, stakes, scores, or user IDs.
- The add-self flow now sets membership state, reloads the protected round, subscribes to realtime, and enters the lobby.

The Supabase SQL file was successfully run in the Supabase SQL console after these changes.

### Commit 3: Secure course API proxy functions

Commit: `21df0f5 fix: secure course api proxy access`

Files:

- `edge-functions/search-golf-course/search-golf-course.ts`
- `edge-functions/get-golf-course/get-golf-course.ts`
- `supabase_schema.sql`
- `tests/edge-function-security.test.js`

Changes:

- Added authenticated bearer-token validation using the Supabase auth `/user` endpoint before any course lookup proceeds.
- Replaced wildcard CORS behavior with a strict allowlist derived from deployment env vars and a safe default set for local Vercel/dev origins.
- Validated `searchQuery` and `courseId` inputs before making upstream requests, including trimming and bounded length checks.
- Added `AbortSignal.timeout` guards around upstream fetches to prevent hanging third-party calls.
- Redacted upstream error details from end users and returned generic client-safe error messages.
- Added a concurrency-safe quota gate via the atomic `public.consume_course_api_quota` RPC so request counts cannot race under load.
- Restricted direct table access to `api_usage` and enforced server-only usage tracking.
- Added regression tests covering auth rejection, CORS handling, and request validation paths.

### Commit 4: Friend history projection and session resume validation

Commit: `0febc20 fix: harden friend history and session resume`

Files:

- `sql-scripts/get-friend-completed-rounds.sql`
- `supabase_schema.sql`
- `assets/core.js`
- `assets/lobby.js`

Changes:

- Fixed the friend-history RPC so it no longer compares score rows to the auth user id instead of the friend’s player row id.
- Reduced returned friend-history payloads to a minimal, permissioned projection of the friend’s own player and score data instead of broad completed-round snapshots.
- Added a stored-session validation step so resume logic confirms the current authenticated user still owns the saved player row and round before trusting it.
- Cleared stale resume state when the saved round/member link no longer matches the live user context.

## Current Security Model

### Roles and actors

- Unauthenticated browser visitor
- Authenticated registered user
- Authenticated anonymous/guest Supabase user
- Round member
- Round host
- Accepted friend
- Admin, identified by `auth.jwt()` app metadata `is_admin`

### Required invite behavior

Keep guest joining. A guest must first receive an authenticated anonymous Supabase session through `signInAnonymously()`.

A round code is treated as a bearer invite. A valid code may reveal only:

- Round ID, which is needed by the client to finish the flow
- Course name
- Whether the round is currently joinable

Before membership, do not expose:

- Player roster or names
- Handicaps
- Stakes
- Scores
- User IDs
- Full round configuration

Full round state must be returned only to a confirmed member, and all authorization must be enforced in SQL/RPCs rather than by UI checks.

## Remaining Work

Implement these in order. Keep each slice focused and add direct security tests before moving to the next slice.

### 1. Finish and verify database authorization

Primary file: `supabase_schema.sql`

- Review every `SECURITY DEFINER` function for explicit `auth.uid()` checks, correct host/member ownership checks, state-transition checks, input bounds, and `set search_path to 'public'`.
- Review all `GRANT EXECUTE` and `REVOKE EXECUTE` statements. Protected functions should be executable only by the intended authenticated role; never grant protected operations to `anon`.
- Add explicit `REVOKE ALL` or equivalent protection for any server-only tables introduced later.
- Verify direct table access cannot bypass RPC controls through RLS.
- Verify authenticated guests are not accidentally treated as anonymous SQL callers. Supabase anonymous sign-in users have an authenticated role but should remain excluded from permanent-history participant lists where the product intends that behavior.
- Check that the host cannot alter `host_user_id` or transfer ownership through a normal round update.
- Check host-only score editing, ending, cancelling, and archiving operations for valid round state and authenticated host ownership.
- Check that a revoked or expired invite cannot be used through any alternate RPC path, including `claim_player`.
- Add a safe cleanup policy for old `round_lookup_attempts` rows or periodically delete stale windows in a server-side maintenance job.
- Decide whether expired rounds should be deleted or retained, and document retention behavior.

Important SQL compatibility notes:

- `find_round_by_code(text)` previously returned `setof rounds`; it now returns a table with `(id uuid, course_name text, joinable boolean)`. The schema drops the old function before recreating it.
- Existing active rounds may still use 5-character codes. Do not change the validation to require exactly 8 characters unless a migration regenerates or invalidates old invites.
- The schema contains rerunnable publication and policy setup, but production changes should ultimately be split into versioned migrations with backup/rollback procedures.
- Check for duplicate memberships before applying the unique index:

```sql
select round_id, user_id, count(*)
from public.players
where user_id is not null
group by round_id, user_id
having count(*) > 1;
```

### 2. Secure the course API Edge Functions

Status: Completed in Commit 3 (`21df0f5`), with a follow-up adjustment in `1752345`. See "Work Already Completed → Commit 3" above. The items below are recorded for context; only the residual sub-items at the end remain open.

Files:

- `edge-functions/search-golf-course/search-golf-course.ts`
- `edge-functions/get-golf-course/get-golf-course.ts`

Risks that have been resolved:

- Both functions previously behaved as public proxies with no JWT validation. They now validate the Supabase access token against the auth `/user` endpoint and reject missing, malformed, expired, or invalid tokens before any lookup.
- CORS previously allowed `*`. It is now restricted to a deployment-configured allowlist (env-derived plus a safe default set for local Vercel/dev origins), with OPTIONS still handled.
- The service-role key is used server-side and requests are now tied to an authenticated caller.
- API usage tracking was observability-only and race-prone. It is now gated by the atomic `public.consume_course_api_quota` RPC, and direct client access to `api_usage` is revoked.
- Upstream error details and exception messages are no longer returned to clients; generic client-safe messages are returned instead.
- `searchQuery` and `courseId` are validated (type, trimming, bounded length) before upstream requests.
- Upstream fetches are guarded with `AbortSignal.timeout`.

Implemented atomic quota:

```sql
create or replace function public.consume_course_api_quota(
  p_usage_key text,
  p_daily_limit integer
) returns boolean
security definer
set search_path to 'public'
...
```

This is live in `supabase_schema.sql`. It atomically upserts the current date row, increments only when under the limit, and returns whether the caller may proceed — not an unlocked read followed by a separate update.

Residual sub-items still open:

- Per-user course-API throttling. The current limiter is an app-wide daily quota; `round_lookup_attempts` throttles round lookups, not the course proxy, so an authenticated user is not individually rate-limited on course calls.
- IP/device abuse controls, where supported by the platform.

Note: result caching already exists — imported courses are cached in the `courses` table (`source = 'api'`) and re-searches reuse the cached copy, so no additional caching work is required here.

### 3. Minimize history and friend data

Files:

- `sql-scripts/get-friend-completed-rounds.sql`
- `assets/friend-rounds.js`
- `assets/history.js`
- `assets/friends.js`
- `supabase_schema.sql`

Current risk:

Completed-round snapshots contain broad data such as all player names, handicaps, user IDs, scores, configuration, and potentially stakes. Friendship authorization exists, but authorization alone does not establish that all participants consented to sharing the full snapshot.

Required decisions and changes:

- Define whether completed rounds are private to participants, visible to accepted friends, or controlled by a round-level sharing setting.
- Treat stakes as sensitive financial information by default.
- Return explicit projections rather than `completed_rounds.*` or full JSON snapshots.
- Omit user IDs unless strictly required.
- Omit unrelated players or provide a participant-safe display projection.
- Add participant consent or a round privacy setting before friend sharing.
- Ensure rejected/removed friends immediately lose access where product policy requires it.
- Add tests proving a friend cannot read arbitrary completed rounds or hidden participant data.

### 4. Harden client session and storage behavior

Files:

- `assets/core.js`
- `assets/lobby.js`
- `assets/round.js`
- `assets/auth.js`
- `assets/app.js`

Current risk:

The app stores round codes and player IDs in `localStorage` under keys such as `fairwaylive_session` and stores pending invite/profile state there as well. This is recoverable by any same-origin script, browser profile user, or future XSS.

Required implementation:

- Treat local storage values as hints only; never as authorization.
- On resume, fetch the current authenticated user and verify that the stored player ID belongs to that user before setting `state.myPlayerId`.
- Prefer session-scoped storage for transient invite/onboarding state where possible.
- Clear pending invite state after successful use, cancellation, logout, or expiration.
- Clear stale session state when membership no longer exists.
- Avoid storing sensitive round state, scores, or access tokens in application-managed storage.
- Ensure Supabase's own auth session storage is configured appropriately for the eventual web/native packaging.
- Remove or gate production `console.error`/debug output if it can expose provider responses or identifiers.

### 5. Audit all HTML, URL, and authentication handling

Files to inspect:

- Every file under `assets/`
- `index.html`

Required implementation:

- Audit every `innerHTML` assignment. User, API, course, player, friend, and round values must use `textContent`, DOM APIs, or strict escaping.
- Review `escapeHtml` and `escapeAttr` use in attribute contexts, including URLs and `data-*` values.
- Validate user-controlled lengths and accepted characters at both client and server boundaries.
- Use safe URL construction and allow-list redirect destinations.
- Replace raw Supabase authentication messages with generic user-facing messages to reduce account/email enumeration and provider disclosure.
- Make password reset, signup, verification, and resend behavior indistinguishable where appropriate.
- Ensure feedback mailto construction cannot be abused to inject headers or uncontrolled recipients.
- Ensure deep-link query/hash parsing cannot override password recovery or redirect users to untrusted origins.

### 6. Add web deployment security controls

The app is currently static and has no checked-in deployment headers/configuration.

Required production controls:

- HTTPS-only deployment
- HSTS after HTTPS is confirmed
- Strict Content Security Policy compatible with Supabase, the chosen font sources, and the eventual iOS wrapper
- `frame-ancestors` or equivalent clickjacking protection
- `X-Content-Type-Options: nosniff`
- Appropriate `Referrer-Policy`
- Production-only Supabase auth redirect URLs
- No service-role secrets in client code
- Dependency/script pinning or SRI where practical
- Production error logging that avoids tokens, emails, full invite codes, and personal data

Decide where headers live for the deployed static host, such as Vercel configuration, and add that configuration to the repository rather than relying on undocumented dashboard settings.

### 7. Implement account deletion and data lifecycle

Required product/backend work:

- Add an authenticated account deletion operation or documented secure server workflow.
- Delete or anonymize `user_profiles`, owned courses, player membership records, friendships, and historical records according to the retention policy.
- Decide what happens to rounds hosted by a deleted account.
- Decide whether anonymous guest users' live round data is retained, deleted at archive, or anonymized.
- Ensure foreign keys and archive snapshots do not preserve more personal data than intended.
- Provide in-app account deletion, not merely an email request, for App Store readiness.
- Document data export and support procedures if required by the final jurisdictions and product policy.

### 8. Add a real security test suite

The existing `tests/golf.test.js` covers scoring only. Add a separate security suite that uses a disposable Supabase project or a controlled integration environment.

Test through direct REST/RPC calls, not just the UI:

- Anonymous caller cannot invoke protected round RPCs.
- Authenticated non-member receives only minimal preview data.
- Non-member receives no roster, handicaps, stakes, scores, or user IDs.
- Member receives full state only for their own round.
- Invalid, expired, revoked, started, cancelled, and archived invite behavior is correct.
- Lookup throttle stops repeated attempts at the configured limit.
- Direct `players` insert by a non-host fails.
- `join_round` accepts valid guest/authenticated users and rejects invalid names, handicaps, duplicate memberships, full rounds, and late joins.
- `claim_player` cannot claim a row from another round or after joining a different row.
- A user cannot read or update another player's scores.
- A non-host cannot edit, end, cancel, archive, or revoke another host's round.
- Realtime subscriptions do not expose another round's changes.
- Friend/history RPCs return only authorized and minimized data.
- Edge Functions reject missing/invalid JWTs and unrestricted origins.
- Edge Function quota remains correct under concurrent requests.
- Upstream error details are not returned to clients.
- Course ownership and admin-only operations are enforced by RLS.

Add these tests to CI and keep `npm test` passing.

## Manual Test Matrix

Use at least two registered accounts, one guest account, two separate browsers/devices, and a staging Supabase project.

1. Host creates a round and copies the invite link.
2. Unauthenticated visitor opens the link and is sent through the intended auth/guest flow.
3. Guest joins by adding themselves.
4. A second authenticated user joins successfully.
5. Before joining, verify the network response contains only preview fields.
6. Verify a member sees the full lobby and live scores.
7. Verify a non-member cannot read the round by UUID, player UUID, REST table query, or RPC.
8. Verify a non-host cannot change scores, round settings, host identity, or lifecycle state.
9. Host revokes the invite; a new user cannot join, while existing members continue to view the round.
10. Wait or simulate expiry; verify the invite cannot be used.
11. Attempt more than 20 lookups in one 10-minute window; verify throttling.
12. Verify realtime updates are visible only to members of the same round.
13. Complete/archive a round and verify history/friend views obey the selected privacy policy.
14. Log out, clear browser storage, reload, and verify resume requires current server membership.
15. Test password reset and signup errors for generic user-facing messaging.

## Important Caveats Before More Changes

- Do not treat the Supabase publishable/anon key in `assets/supabase-config.js` as a secret. Security depends on RLS, RPC authorization, and Edge Function controls.
- Do not put the Supabase service-role key in browser code, static hosting variables exposed to the client, or an iOS app bundle.
- Do not apply experimental security SQL directly to production without a backup and a staging run.
- The current schema is a broad setup file and is only partially migration-safe. Prefer a new versioned migration for future production changes.
- Do not weaken server policies to make an existing UI flow work. Change the flow to use a narrowly scoped RPC.
- Preserve the existing scoring behavior and `tests/golf.test.js` while changing authorization.
- The current branch may differ from the branch names in the commit history. Always inspect `git status`, `git branch --show-current`, and `git log -3 --oneline` before editing.

## Recommended Next Task

Edge Function authentication and error redaction (Remaining Work #2) are done and merged, so the next isolated slice is **history and friend data minimization plus privacy controls** (Remaining Work #3). Commit 4 already fixed the friend-history RPC comparison and reduced its payload, but the broader decisions remain open: define whether completed rounds are private to participants, friend-visible, or governed by a round-level sharing setting; treat stakes as sensitive by default; return explicit projections instead of full snapshots; and add tests proving a friend cannot read arbitrary completed rounds or hidden participant data.

After that, proceed in order: local session and storage hardening (#4), then the remaining database authorization review (#1), web deployment security headers (#6), in-app account deletion and data lifecycle (#7), and the complete security test suite (#8).

## Completion Criteria

Do not describe the application as App Store security-ready until all of the following are true:

- Server-side authorization tests pass against a staging Supabase project.
- Edge Functions require verified authentication and enforce atomic quotas.
- Pre-join, live-round, friend, and history responses are data-minimized.
- Account deletion works in-app and its data effects are documented.
- Client storage is not treated as authorization and sensitive state is minimized.
- Production headers and Supabase redirect settings are verified.
- Privacy policy, terms, retention, App Privacy declarations, and support/deletion workflows match actual behavior.
- The iOS packaging approach has been selected and its secure-storage, ATS/HTTPS, deep-link, and App Store review behavior has been tested.
