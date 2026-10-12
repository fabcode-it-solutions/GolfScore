-- ===========================================================
-- Tournament teams: host picks team COUNT, not team size.
-- ---------------------------------------------------------
-- Run this once in the Supabase SQL Editor.
--
-- `rounds.team_size` (players-per-team) becomes `rounds.team_count`
-- (number of teams) now that the setup screen lets the host pick an
-- explicit team count and splits players as evenly as possible across
-- it, rather than deriving the team count from a fixed size.
--
-- A straight rename would misrepresent any in-progress tournament:
-- team_size was a max-per-team, so e.g. team_size=2 with 8 players
-- actually means 4 real teams, not 2. Backfill team_count from the
-- real data instead — the highest team number actually assigned to a
-- player in that round — falling back to the old team_size only for a
-- tournament with no team assignments yet (still mid-setup).
-- ===========================================================

alter table public.rounds add column team_count smallint;

update public.rounds r
set team_count = coalesce(
  (select max(p.team) from public.players p where p.round_id = r.id),
  r.team_size
)
where r.is_tournament;

alter table public.rounds drop column team_size;
