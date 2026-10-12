/* ===========================================================
   supabase-config.js
   ---------------------------------------------------------
   Fill in the two values below with your own Supabase project's
   credentials. See SETUP.md for the step-by-step walkthrough of
   where to find them.

   The "anon key" is meant to be public — it's safe to commit to
   a public GitHub repo. Supabase's security model relies on
   Row Level Security policies (set up by supabase_schema.sql),
   not on keeping this key secret.
=========================================================== */

const SUPABASE_URL = "https://vtjvifkvvqtwbvjjxbcn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_RIWPwkL7AErDZI64R4ikXA_CuRh1SFp";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
