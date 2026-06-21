-- 0026_practice_grants.sql
-- FIX: "permission denied for table song_markers" (SQLSTATE 42501) when an Ar adds
-- a marker. This project was created WITHOUT default Supabase grants to the
-- `authenticated` role (see 0001 / 0017), so every new table needs an explicit
-- GRANT — the Practice Mode tables (0023/0024) were missing theirs. RLS still
-- governs row access; these grants just give the role table-level privileges.
grant select, insert, update, delete on public.song_markers        to authenticated;
grant select, insert, update, delete on public.practice_logs       to authenticated;
grant select, insert, update, delete on public.practice_runs       to authenticated;
grant select, insert, update, delete on public.practice_attendance to authenticated;

-- service_role already inherits via 0017's default privileges; be explicit + idempotent.
grant all on public.song_markers        to service_role;
grant all on public.practice_logs       to service_role;
grant all on public.practice_runs       to service_role;
grant all on public.practice_attendance to service_role;

-- Safety net so FUTURE tables created in this schema don't hit the same 42501.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
