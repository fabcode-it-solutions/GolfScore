-- Apply to existing databases before deploying the updated Edge Functions.
-- Golf Course API IDs are opaque strings (for example, "pmyjyz8s").
alter table public.courses
  alter column external_id type text
  using external_id::text;