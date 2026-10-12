-- ===========================================================
-- GolfScore — Supabase schema
-- ---------------------------------------------------------
-- Rebuilt from a live inspection of the production database
-- (pg_policies, pg_proc, and an information_schema-based table
-- dump) rather than hand-maintained. The previous committed
-- version of this file had fallen out of sync with real RLS
-- policies and was missing every SECURITY DEFINER function the
-- app actually depends on — including the join-code-gated round
-- access added in this same pass. If you're setting up a new
-- Supabase project, run this whole file once in the SQL Editor.
-- ===========================================================

-- ---------- rounds ----------
create table if not exists public.rounds (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  course_name text not null,
  hole_count int not null check (hole_count in (9, 18)),
  pars int[],
  modes text[] not null default array['gross'::text],
  host_player_id uuid,
  host_user_id uuid references auth.users(id),
  started boolean not null default false,
  ended boolean not null default false,
  cancelled boolean not null default false,
  created_at timestamptz not null default now(),
  invite_expires_at timestamptz not null default (now() + interval '7 days'),
  invite_revoked boolean not null default false,
  stroke_index int[],
  match_team_a uuid[] check (match_team_a is null or array_length(match_team_a, 1) between 1 and 3),
  match_team_b uuid[] check (match_team_b is null or array_length(match_team_b, 1) between 1 and 3),
  match_use_handicap boolean not null default true,
  hole_offset int not null default 0,
  bets_enabled boolean not null default false,
  stakes jsonb not null default '{}'::jsonb,
  course_location text,
  -- Groundwork columns present in production for formats not yet
  -- wired up client-side (side matches, Nassau, sixes, tournament/team
  -- play — see the Ryder Cup / group-play item on the readiness list).
  sidematch_team_c uuid[],
  sidematch_team_d uuid[],
  sidematch_use_handicap boolean,
  nassau_format text,
  sixes_players uuid[],
  sixes_format text,
  sixes_use_handicap boolean,
  is_tournament boolean not null default false,
  team_count smallint,
  tournament_matches jsonb
);

-- ---------- players ----------
create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds(id),
  name text not null,
  handicap numeric(4,1) not null default 0,
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id),
  team smallint,
  is_captain boolean not null default false
);

create table if not exists public.scores (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id),
  hole int not null,
  strokes int not null check (strokes between 1 and 15),
  putts int check (putts is null or putts between 0 and 10),
  updated_at timestamptz not null default now(),
  unique (player_id, hole)
);

-- ---------- user_profiles ----------
create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id),
  display_name text,
  default_handicap numeric default 0,
  city text,
  state text,
  username text check (username is null or username ~ '^[a-z0-9_]{3,20}$'),
  created_at timestamptz default now()
);

-- ---------- courses (shared library) ----------
create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  name text not null,
  location text not null,
  hole_count int not null check (hole_count in (9, 18)),
  pars int[],
  stroke_index int[],
  source text not null default 'manual' check (source in ('manual', 'api')),
  external_id text unique,
  api_club_name text,
  api_location jsonb,
  created_at timestamptz not null default now()
);

-- ---------- completed_rounds (archive snapshot) ----------
create table if not exists public.completed_rounds (
  id uuid primary key default gen_random_uuid(),
  original_round_id uuid not null,
  code text not null,
  course_name text not null,
  host_user_id uuid,
  participant_user_ids uuid[] not null default '{}'::uuid[],
  ended_at timestamptz not null default now(),
  round_snapshot jsonb,
  players_snapshot jsonb,
  scores_snapshot jsonb,
  status text not null default 'completed' check (status in ('completed', 'cancelled'))
);

-- ---------- api_usage (app-wide daily counter) ----------
create table if not exists public.api_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  usage_key text not null default 'app-wide',
  call_count int not null default 0,
  date date not null default current_date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index if not exists idx_api_usage_usage_date_unique
  on public.api_usage (usage_key, date);
revoke all on table public.api_usage from anon, authenticated;

-- ---------- friendships ----------
create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id),
  addressee_id uuid not null references auth.users(id),
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  responded_at timestamptz
);

-- ---------- indexes ----------
alter table public.rounds add column if not exists invite_expires_at timestamptz
  not null default (now() + interval '7 days');
alter table public.rounds add column if not exists invite_revoked boolean not null default false;

create index if not exists idx_players_round_id on players(round_id);
create index if not exists idx_scores_player_id on scores(player_id);
create index if not exists idx_api_usage_usage_date on api_usage(usage_key, date);
create unique index if not exists idx_players_one_membership
  on players(round_id, user_id) where user_id is not null;
create index if not exists idx_rounds_invite_lookup on rounds(code, invite_expires_at)
  where invite_revoked = false;

create table if not exists public.round_lookup_attempts (
  user_id uuid not null references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  attempt_count int not null default 0,
  primary key (user_id, window_start)
);
alter table public.round_lookup_attempts enable row level security;
revoke all on table public.round_lookup_attempts from anon, authenticated;

-- ---------- realtime ----------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rounds'
  ) then
    alter publication supabase_realtime add table public.rounds;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'players'
  ) then
    alter publication supabase_realtime add table public.players;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'scores'
  ) then
    alter publication supabase_realtime add table public.scores;
  end if;
end;
$$;

-- ===========================================================
-- Helper functions (used inside RLS policies)
-- ===========================================================

create or replace function public.is_round_member(p_round_id uuid)
 returns boolean
 language sql stable security definer
 set search_path to 'public'
as $$
  select exists (
    select 1 from players where round_id = p_round_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_admin()
 returns boolean
 language sql stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean, false);
$$;

create or replace function public.consume_course_api_quota(p_usage_key text, p_daily_limit integer)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  v_usage_key text := trim(coalesce(p_usage_key, ''));
  v_daily_limit integer := coalesce(p_daily_limit, 0);
  v_call_count integer;
begin
  if v_usage_key = '' then
    raise exception 'Usage key is required';
  end if;

  if v_daily_limit <= 0 then
    raise exception 'Daily limit must be positive';
  end if;

  with upserted as (
    insert into public.api_usage (usage_key, date, call_count)
    values (v_usage_key, current_date, 1)
    on conflict (usage_key, date) do update
      set call_count = public.api_usage.call_count + 1,
          updated_at = now()
      where public.api_usage.call_count < v_daily_limit
    returning call_count
  )
  select count(*)::int into v_call_count from upserted;

  return v_call_count > 0;
exception
  when no_data_found then
    return false;
end;
$$;

-- ===========================================================
-- SECURITY DEFINER functions (bypass RLS deliberately — each one
-- enforces its own access check internally)
-- ===========================================================

-- Full state is available only to a confirmed round member. Pre-join
-- callers use find_round_by_code(), which returns a minimal preview.
create or replace function public.get_round_state(p_round_code text)
 returns json language sql security definer set search_path to 'public'
as $$
  select case when auth.uid() is not null and exists (
    select 1 from players member
    join rounds member_round on member_round.id = member.round_id
    where member_round.code = upper(trim(p_round_code))
      and member.user_id = auth.uid()
  ) then json_build_object(
    'round', (select row_to_json(r) from rounds r where r.code = upper(trim(p_round_code))),
    'players', (select coalesce(json_agg(row_to_json(p)), '[]'::json)
                from players p join rounds r on r.id = p.round_id
                where r.code = upper(trim(p_round_code))),
    'scores', (select coalesce(json_agg(row_to_json(s)), '[]'::json)
               from scores s join players p on p.id = s.player_id
               join rounds r on r.id = p.round_id
               where r.code = upper(trim(p_round_code)))
  ) end;
$$;

create or replace function public.claim_player(p_player_id uuid, p_round_code text)
 returns setof players language plpgsql security definer set search_path to 'public'
as $$
declare
  v_round_id uuid;
  v_window timestamptz := date_trunc('minute', now()) -
    (extract(minute from now())::int % 10) * interval '1 minute';
  v_attempts int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if trim(coalesce(p_round_code, '')) !~ '^[A-HJ-NP-Z2-9]{5,32}$' then
    raise exception 'Invalid round code';
  end if;

  insert into round_lookup_attempts(user_id, window_start, attempt_count)
    values (auth.uid(), v_window, 1)
  on conflict (user_id, window_start)
    do update set attempt_count = round_lookup_attempts.attempt_count + 1
  returning attempt_count into v_attempts;
  if v_attempts > 20 then
    raise exception 'Too many round attempts';
  end if;

  select id into v_round_id from rounds
    where code = upper(trim(p_round_code))
      and started = false
      and ended = false
      and cancelled = false
      and invite_revoked = false
      and invite_expires_at > now();

  if v_round_id is null then
    raise exception 'Round is not joinable';
  end if;

  if exists (select 1 from players where round_id = v_round_id and user_id = auth.uid()) then
    raise exception 'Already joined';
  end if;

  return query
    update players
    set user_id = auth.uid()
    where id = p_player_id
      and user_id is null
      and round_id = v_round_id
    returning *;
end;
$$;

create or replace function public.join_round(p_round_code text, p_name text, p_handicap numeric)
 returns players language plpgsql security definer set search_path to 'public'
as $$
declare
  me uuid := auth.uid();
  v_round_id uuid;
  v_player players;
  v_window timestamptz := date_trunc('minute', now()) -
    (extract(minute from now())::int % 10) * interval '1 minute';
  v_attempts int;
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  if trim(coalesce(p_round_code, '')) !~ '^[A-HJ-NP-Z2-9]{5,32}$' then
    raise exception 'Invalid round code';
  end if;
  insert into round_lookup_attempts(user_id, window_start, attempt_count)
    values (me, v_window, 1)
  on conflict (user_id, window_start)
    do update set attempt_count = round_lookup_attempts.attempt_count + 1
  returning attempt_count into v_attempts;
  if v_attempts > 20 then
    raise exception 'Too many round attempts';
  end if;
  if length(trim(coalesce(p_name, ''))) = 0 or length(trim(p_name)) > 80 then
    raise exception 'A valid player name is required';
  end if;
  if p_handicap is null or p_handicap < 0 or p_handicap > 54 then
    raise exception 'Handicap must be between 0 and 54';
  end if;

  select id into v_round_id from rounds
    where code = upper(trim(p_round_code))
      and started = false
      and ended = false
      and cancelled = false
      and invite_revoked = false
      and invite_expires_at > now();
  if v_round_id is null then
    raise exception 'Round is not joinable';
  end if;
  if exists (select 1 from players where round_id = v_round_id and user_id = me) then
    raise exception 'Already joined';
  end if;
  if (select count(*) from players where round_id = v_round_id) >= 16 then
    raise exception 'Round is full';
  end if;

  insert into players (round_id, name, handicap, user_id)
    values (v_round_id, trim(p_name), round(p_handicap, 1), me)
    returning * into v_player;
  return v_player;
end;
$$;

drop function if exists public.find_round_by_code(text);
create or replace function public.find_round_by_code(p_code text)
 returns table(id uuid, course_name text, joinable boolean)
 language plpgsql security definer set search_path to 'public'
as $$
declare
  me uuid := auth.uid();
  v_window timestamptz := date_trunc('minute', now()) -
    (extract(minute from now())::int % 10) * interval '1 minute';
  v_attempts int;
begin
  if me is null then
    return;
  end if;

  insert into round_lookup_attempts(user_id, window_start, attempt_count)
    values (me, v_window, 1)
  on conflict (user_id, window_start)
    do update set attempt_count = round_lookup_attempts.attempt_count + 1
  returning attempt_count into v_attempts;

  if v_attempts > 20 then
    return;
  end if;

  return query
    select r.id, r.course_name,
      (r.started = false and r.ended = false and r.cancelled = false
       and r.invite_revoked = false and r.invite_expires_at > now())
    from rounds r
    where r.code = upper(trim(p_code));
end;
$$;

create or replace function public.round_was_archived(p_code text)
 returns boolean language sql security definer set search_path to 'public'
as $$
  select auth.uid() is not null
    and exists(select 1 from completed_rounds where code = upper(trim(p_code)));
$$;

create or replace function public.revoke_round_invite(p_round_id uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  update rounds set invite_revoked = true
    where id = p_round_id and host_user_id = auth.uid();
  if not found then
    raise exception 'Only the round host can revoke this invite';
  end if;
end;
$$;

create or replace function public.host_upsert_score(
  p_player_id uuid, p_hole integer, p_strokes integer, p_putts integer default null
) returns scores language plpgsql security definer set search_path to 'public'
as $$
declare
  v_round_id uuid;
  v_host_user_id uuid;
  v_result scores;
begin
  select round_id into v_round_id from players where id = p_player_id;
  if v_round_id is null then
    raise exception 'Player not found';
  end if;

  select host_user_id into v_host_user_id from rounds where id = v_round_id;
  if v_host_user_id is null or v_host_user_id <> auth.uid() then
    raise exception 'Only the round host can edit another player''s score';
  end if;

  if p_strokes < 1 or p_strokes > 15 then
    raise exception 'Strokes must be between 1 and 15';
  end if;
  if p_putts is not null and (p_putts < 0 or p_putts > 10) then
    raise exception 'Putts must be between 0 and 10';
  end if;

  insert into scores (player_id, hole, strokes, putts)
  values (p_player_id, p_hole, p_strokes, p_putts)
  on conflict (player_id, hole)
  do update set strokes = excluded.strokes,
                putts = coalesce(excluded.putts, scores.putts),
                updated_at = now()
  returning * into v_result;

  return v_result;
end;
$$;

create or replace function public.end_round(p_round_id uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare
  v_host_user_id uuid;
  v_hole_count int;
  v_missing int;
begin
  select host_user_id, hole_count into v_host_user_id, v_hole_count
  from rounds where id = p_round_id;

  if v_host_user_id is null then
    raise exception 'Round not found';
  end if;
  if v_host_user_id is distinct from auth.uid() then
    raise exception 'Only the host can end this round';
  end if;

  select count(*) into v_missing
  from players p
  cross join generate_series(1, v_hole_count) as h
  where p.round_id = p_round_id
    and not exists (select 1 from scores s where s.player_id = p.id and s.hole = h);

  if v_missing > 0 then
    raise exception 'Not all scores have been entered yet';
  end if;

  update rounds set ended = true where id = p_round_id;
end;
$$;

create or replace function public.archive_round(p_round_id uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare
  v_round rounds;
  v_all_user_ids uuid[];
  v_real_user_ids uuid[];
begin
  select * into v_round from rounds where id = p_round_id;
  if v_round is null then
    raise exception 'Round not found';
  end if;
  if v_round.host_user_id is distinct from auth.uid() then
    raise exception 'Only the host can end this round';
  end if;

  select coalesce(array_agg(distinct user_id), '{}') into v_all_user_ids
    from players where round_id = p_round_id and user_id is not null;
  select coalesce(array_agg(id), '{}') into v_real_user_ids
    from auth.users where id = any(v_all_user_ids) and is_anonymous is not true;

  insert into completed_rounds (
    original_round_id, code, course_name, host_user_id, participant_user_ids,
    round_snapshot, players_snapshot, scores_snapshot
  )
  select
    v_round.id, v_round.code, v_round.course_name, v_round.host_user_id, v_real_user_ids,
    to_jsonb(v_round),
    coalesce((select jsonb_agg(to_jsonb(p)) from players p where p.round_id = p_round_id), '[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(s)) from scores s
              join players p on p.id = s.player_id where p.round_id = p_round_id), '[]'::jsonb);

  delete from rounds where id = p_round_id;
end;
$$;

create or replace function public.cancel_round(p_round_id uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare
  v_round rounds;
  v_all_user_ids uuid[];
  v_real_user_ids uuid[];
begin
  select * into v_round from rounds where id = p_round_id;
  if v_round is null then
    raise exception 'Round not found';
  end if;
  if v_round.host_user_id is distinct from auth.uid() then
    raise exception 'Only the host can cancel this round';
  end if;

  -- No missing-scores check (unlike end_round) — cancelling is
  -- explicitly for rounds that won't be finished. No `started` check
  -- either, so a lobby-stage round can be cancelled the same way.
  update rounds set cancelled = true, ended = true where id = p_round_id;

  select coalesce(array_agg(distinct user_id), '{}') into v_all_user_ids
    from players where round_id = p_round_id and user_id is not null;
  select coalesce(array_agg(id), '{}') into v_real_user_ids
    from auth.users where id = any(v_all_user_ids) and is_anonymous is not true;

  insert into completed_rounds (
    original_round_id, code, course_name, host_user_id, participant_user_ids,
    round_snapshot, players_snapshot, scores_snapshot, status
  )
  select
    v_round.id, v_round.code, v_round.course_name, v_round.host_user_id, v_real_user_ids,
    to_jsonb(v_round),
    coalesce((select jsonb_agg(to_jsonb(p)) from players p where p.round_id = p_round_id), '[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(s)) from scores s
              join players p on p.id = s.player_id where p.round_id = p_round_id), '[]'::jsonb),
    'cancelled';

  delete from rounds where id = p_round_id;
end;
$$;

create or replace function public.get_incoming_requests()
 returns table(requester_id uuid, username text, display_name text, created_at timestamptz)
 language sql security definer set search_path to 'public'
as $$
  select f.requester_id, p.username, p.display_name, f.created_at
  from public.friendships f
  join public.user_profiles p on p.id = f.requester_id
  where auth.uid() is not null and f.addressee_id = auth.uid() and f.status = 'pending'
  order by f.created_at desc;
$$;

create or replace function public.get_friend_completed_rounds(p_friend_id uuid)
 returns table (
   id uuid,
   code text,
   course_name text,
   ended_at timestamptz,
   status text,
   participant_user_ids uuid[],
   round_snapshot jsonb,
   players_snapshot jsonb,
   scores_snapshot jsonb
 )
 language sql
 security definer
 set search_path to 'public'
as $$
  with allowed_rounds as (
    select cr.*
    from public.completed_rounds cr
    where exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and ((f.requester_id = auth.uid() and f.addressee_id = p_friend_id)
          or (f.requester_id = p_friend_id and f.addressee_id = auth.uid()))
    )
      and p_friend_id = any(cr.participant_user_ids)
  )
  select
    cr.id,
    cr.code,
    cr.course_name,
    cr.ended_at,
    cr.status,
    array(
      select u
      from unnest(cr.participant_user_ids) as u
      where u = auth.uid() or u = p_friend_id
    ) as participant_user_ids,
    jsonb_build_object(
      'course_name', cr.course_name,
      'hole_count', coalesce((cr.round_snapshot->>'hole_count')::int, 18),
      'hole_offset', coalesce((cr.round_snapshot->>'hole_offset')::int, 0),
      'pars', coalesce(cr.round_snapshot->'pars', '[]'::jsonb),
      'stroke_index', cr.round_snapshot->'stroke_index',
      'modes', coalesce(cr.round_snapshot->'modes', '["gross"]'::jsonb)
    ) as round_snapshot,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', player->>'id',
            'name', player->>'name',
            'handicap', (player->>'handicap')::numeric,
            'user_id', (player->>'user_id')::uuid,
            'team', (player->>'team')::smallint,
            'is_captain', (player->>'is_captain')::boolean
          )
        )
        from jsonb_array_elements(cr.players_snapshot) as player
        where (player->>'user_id')::uuid = p_friend_id
      ),
      '[]'::jsonb
    ) as players_snapshot,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', score->>'id',
            'player_id', (score->>'player_id')::uuid,
            'hole', (score->>'hole')::int,
            'strokes', (score->>'strokes')::int,
            'putts', (score->>'putts')::int
          )
        )
        from jsonb_array_elements(cr.scores_snapshot) as score
        where (score->>'player_id')::uuid = p_friend_id
      ),
      '[]'::jsonb
    ) as scores_snapshot
  from allowed_rounds cr
  order by cr.ended_at desc;
$$;

create or replace function public.get_my_friends()
 returns table(id uuid, username text, display_name text, city text, state text, default_handicap numeric)
 language sql security definer set search_path to 'public'
as $$
  select p.id, p.username, p.display_name, p.city, p.state, p.default_handicap::numeric
  from public.friendships f
  join public.user_profiles p
    on p.id = case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end
  where auth.uid() is not null and f.status = 'accepted'
    and (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
  order by lower(p.display_name);
$$;

create or replace function public.search_users_by_username(q text)
 returns table(id uuid, username text, display_name text, city text, state text, relationship text)
 language sql security definer set search_path to 'public'
as $$
  select
    p.id, p.username, p.display_name, p.city, p.state,
    case
      when f.status = 'accepted' then 'accepted'
      when f.status = 'pending' and f.requester_id = auth.uid() then 'outgoing'
      when f.status = 'pending' and f.addressee_id = auth.uid() then 'incoming'
      else 'none'
    end as relationship
  from public.user_profiles p
  left join lateral (
    select status, requester_id, addressee_id
    from public.friendships
    where (requester_id = auth.uid() and addressee_id = p.id)
       or (addressee_id = auth.uid() and requester_id = p.id)
    limit 1
  ) f on true
  where auth.uid() is not null
    and p.id <> auth.uid()
    and p.username is not null
    and length(trim(q)) >= 2
    and (p.username like lower(trim(q)) || '%' or p.display_name ilike '%' || trim(q) || '%')
  order by
    (p.username = lower(trim(q))) desc,
    (p.username like lower(trim(q)) || '%') desc,
    p.username
  limit 20;
$$;

create or replace function public.send_friend_request(p_target_id uuid)
 returns text language plpgsql security definer set search_path to 'public'
as $$
declare
  me uuid := auth.uid();
  existing public.friendships%rowtype;
begin
  if me is null then raise exception 'Not authenticated'; end if;
  if p_target_id = me then raise exception 'You cannot friend yourself'; end if;

  select * into existing from public.friendships
  where (requester_id = me and addressee_id = p_target_id)
     or (requester_id = p_target_id and addressee_id = me)
  limit 1;

  if found then
    if existing.status = 'accepted' then
      return 'accepted';
    elsif existing.requester_id = me then
      return 'outgoing';
    else
      update public.friendships set status = 'accepted', responded_at = now() where id = existing.id;
      return 'accepted';
    end if;
  end if;

  begin
    insert into public.friendships (requester_id, addressee_id, status) values (me, p_target_id, 'pending');
  exception when unique_violation then
    return 'outgoing';
  end;
  return 'outgoing';
end;
$$;

create or replace function public.respond_friend_request(p_requester_id uuid, p_accept boolean)
 returns text language plpgsql security definer set search_path to 'public'
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Not authenticated'; end if;

  if p_accept then
    update public.friendships set status = 'accepted', responded_at = now()
      where requester_id = p_requester_id and addressee_id = me and status = 'pending';
    if not found then raise exception 'No pending request from that user'; end if;
    delete from public.friendships where requester_id = me and addressee_id = p_requester_id;
    return 'accepted';
  else
    delete from public.friendships
      where requester_id = p_requester_id and addressee_id = me and status = 'pending';
    return 'declined';
  end if;
end;
$$;

create or replace function public.remove_friend(p_other_id uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Not authenticated'; end if;
  delete from public.friendships
    where (requester_id = me and addressee_id = p_other_id)
       or (requester_id = p_other_id and addressee_id = me);
end;
$$;

revoke execute on function public.get_round_state(text) from anon;
revoke execute on function public.claim_player(uuid, text) from anon;
revoke execute on function public.find_round_by_code(text) from anon;
revoke execute on function public.round_was_archived(text) from anon;
revoke execute on function public.join_round(text, text, numeric) from anon;
revoke execute on function public.consume_course_api_quota(text, integer) from anon;
grant execute on function public.get_round_state(text) to authenticated;
grant execute on function public.claim_player(uuid, text) to authenticated;
grant execute on function public.find_round_by_code(text) to authenticated;
grant execute on function public.round_was_archived(text) to authenticated;
grant execute on function public.join_round(text, text, numeric) to authenticated;
grant execute on function public.consume_course_api_quota(text, integer) to authenticated;
grant execute on function public.revoke_round_invite(uuid) to authenticated;

-- ===========================================================
-- Row-level security
-- ===========================================================
alter table rounds enable row level security;
alter table players enable row level security;
alter table scores enable row level security;
alter table user_profiles enable row level security;
alter table courses enable row level security;
alter table completed_rounds enable row level security;
alter table api_usage enable row level security;
alter table friendships enable row level security;

-- ---------- rounds ----------
drop policy if exists "members can read their round" on public.rounds;
drop policy if exists "you can create a round as its host" on public.rounds;
drop policy if exists "only the host can update their round" on public.rounds;
drop policy if exists "members can read players in their round" on public.players;
drop policy if exists "host can pre-add players" on public.players;
drop policy if exists "add yourself, or host can pre-add a placeholder" on public.players;
drop policy if exists "update your own row, or host-managed placeholders" on public.players;
drop policy if exists "update your own row, or claim an unclaimed one" on public.players;
drop policy if exists "members can read scores in their round" on public.scores;
drop policy if exists "you can only write your own scores" on public.scores;
drop policy if exists "you can only update your own scores" on public.scores;
drop policy if exists "users read own profile" on public.user_profiles;
drop policy if exists "users write own profile" on public.user_profiles;
drop policy if exists "users update own profile" on public.user_profiles;
drop policy if exists "any logged-in user can read courses" on public.courses;
drop policy if exists "owner can insert own courses" on public.courses;
drop policy if exists "admins can update any course" on public.courses;
drop policy if exists "admins can delete any course" on public.courses;
drop policy if exists "participants can read their completed rounds" on public.completed_rounds;
drop policy if exists "read own friendships" on public.friendships;
drop policy if exists "send own requests" on public.friendships;
drop policy if exists "delete own friendships" on public.friendships;

create policy "members can read their round" on rounds
  for select using (is_round_member(id));
create policy "you can create a round as its host" on rounds
  for insert with check (host_user_id = auth.uid());
create policy "only the host can update their round" on rounds
  for update using (host_user_id = auth.uid()) with check (host_user_id = auth.uid());

-- ---------- players ----------
create policy "members can read players in their round" on players
  for select using (is_round_member(round_id));
create policy "host can pre-add players" on players
  for insert with check (
    exists (
      select 1 from rounds r where r.id = players.round_id and r.host_user_id = auth.uid()
    )
  );
create policy "update your own row, or host-managed placeholders" on players
  for update using (
    user_id = auth.uid()
    or exists (select 1 from rounds r where r.id = players.round_id and r.host_user_id = auth.uid())
  ) with check (
    user_id = auth.uid()
    or (user_id is null and exists (
      select 1 from rounds r where r.id = players.round_id and r.host_user_id = auth.uid()
    ))
  );

-- ---------- scores ----------
create policy "members can read scores in their round" on scores
  for select using (
    exists (select 1 from players p where p.id = scores.player_id and is_round_member(p.round_id))
  );
create policy "you can only write your own scores" on scores
  for insert with check (
    exists (select 1 from players p where p.id = scores.player_id and p.user_id = auth.uid())
  );
create policy "you can only update your own scores" on scores
  for update using (
    exists (select 1 from players p where p.id = scores.player_id and p.user_id = auth.uid())
  ) with check (
    exists (select 1 from players p where p.id = scores.player_id and p.user_id = auth.uid())
  );

-- ---------- user_profiles ----------
create policy "users read own profile" on user_profiles for select using (auth.uid() = id);
create policy "users write own profile" on user_profiles for insert with check (auth.uid() = id);
create policy "users update own profile" on user_profiles for update using (auth.uid() = id);

-- ---------- courses (shared library; admin-gated edit/delete) ----------
create policy "any logged-in user can read courses" on courses
  for select using (auth.role() = 'authenticated');
create policy "owner can insert own courses" on courses
  for insert with check (auth.uid() = user_id);
create policy "admins can update any course" on courses
  for update using (is_admin()) with check (is_admin());
create policy "admins can delete any course" on courses
  for delete using (is_admin());

alter table public.courses alter column user_id drop not null;
alter table public.courses drop constraint if exists courses_user_id_fkey;
alter table public.courses
  add constraint courses_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

-- ---------- completed_rounds ----------
-- No client-facing INSERT/UPDATE/DELETE policy on purpose: the only
-- writes come from end_round/archive_round/cancel_round, which are
-- SECURITY DEFINER and bypass RLS entirely.
create policy "participants can read their completed rounds" on completed_rounds
  for select using (auth.uid() = any(participant_user_ids));

-- ---------- friendships ----------
create policy "read own friendships" on friendships
  for select using (auth.uid() = requester_id or auth.uid() = addressee_id);
create policy "send own requests" on friendships
  for insert with check (auth.uid() = requester_id);
create policy "delete own friendships" on friendships
  for delete using (auth.uid() = requester_id or auth.uid() = addressee_id);
-- Deliberately no UPDATE policy — responding to a request goes through
-- respond_friend_request() (SECURITY DEFINER) only. See
-- migration_round_access_fix.sql for why the old direct-update
-- policy was removed.

-- ---------- api_usage ----------
-- No client-facing policies at all: only the search-golf-course /
-- get-golf-course Edge Functions touch this table, using the
-- service_role key, which bypasses RLS. Enabled here only so it's
-- never accidentally left open if a policy is added later.
-- Fix for RLS circular dependency: allows host to insert first player
-- without needing to already exist as a player to read the round.
create or replace function public.is_round_host(p_round_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from rounds where id = p_round_id and host_user_id = auth.uid()
  );
$$;

drop policy if exists "host can pre-add players" on players;

create policy "host can pre-add players" on players
  for insert
  with check (
    public.is_round_host(round_id)
  );

