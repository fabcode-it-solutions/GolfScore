-- ===========================================================
-- Courses: persist forever, even after the creator's account
-- is deleted.
-- ---------------------------------------------------------
-- Run this once in the Supabase SQL Editor. Safe to re-run.
--
-- Your RLS policies on `courses` are already correct for the
-- "shared with everyone" requirement:
--   - "any logged-in user can read courses"  (SELECT, public)
--   - "owner can insert/update/delete own courses" (owner-only writes)
-- So this migration does NOT touch RLS. The one real problem is
-- the foreign key: `courses_user_id_fkey ... on delete CASCADE`
-- plus `user_id uuid not null` means deleting the creator's
-- account deletes every course they ever made, breaking it for
-- everyone else who's used it. This migration:
--   1. Allows user_id to be null (a course can outlive its creator)
--   2. Swaps the FK's ON DELETE behavior from CASCADE to SET NULL
-- ===========================================================

alter table public.courses
  alter column user_id drop not null;

alter table public.courses
  drop constraint if exists courses_user_id_fkey;

alter table public.courses
  add constraint courses_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete set null;
