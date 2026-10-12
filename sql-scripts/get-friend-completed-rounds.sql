-- ===========================================================
-- get_friend_completed_rounds — let an accepted friend read
-- another friend's full completed-round history.
-- ---------------------------------------------------------
-- Run this once in the Supabase SQL Editor. Safe to re-run.
--
-- Powers the friend-rounds screen (assets/friend-rounds.js).
-- The `completed_rounds` RLS SELECT policy is
-- `auth.uid() = ANY(participant_user_ids)`, so a plain client
-- query only ever returns rounds the caller played in. That
-- covers "Rounds with me" but not "All rounds" — rounds the
-- friend played that the caller wasn't in.
--
-- This SECURITY DEFINER function bypasses that policy, but only
-- returns rows when the caller and p_friend_id are accepted
-- friends (mirroring get_my_friends' friendship check). A
-- non-friend id returns nothing.
-- ===========================================================

drop function if exists public.get_friend_completed_rounds(uuid);

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
      select 1
      from public.friendships f
      where f.status = 'accepted'
        and (
          (f.requester_id = auth.uid() and f.addressee_id = p_friend_id)
          or
          (f.requester_id = p_friend_id and f.addressee_id = auth.uid())
        )
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
        where (score->>'player_id')::uuid in (
          select (player->>'id')::uuid
          from jsonb_array_elements(cr.players_snapshot) as player
          where (player->>'user_id')::uuid = p_friend_id
        )
      ),
      '[]'::jsonb
    ) as scores_snapshot
  from allowed_rounds cr
  order by cr.ended_at desc;
$$;

grant execute on function public.get_friend_completed_rounds(uuid) to authenticated;
