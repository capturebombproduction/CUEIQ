-- ---------------------------------------------------------------------------
-- 0017 — grant table privileges to service_role
--
-- This project was created without the default Supabase grants to `service_role`
-- (the same quirk that forced explicit `grant ... to authenticated` in 0001 —
-- "newer Supabase projects don't auto-grant table privileges"). The admin
-- account-provisioning route (lib/supabase/admin.ts → /api/admin/users) uses the
-- service-role key to write tenant_members / group_roles / profiles, and was
-- failing with `permission denied for table tenant_members` (SQLSTATE 42501)
-- even though service_role bypasses RLS — because it lacked the table GRANT.
--
-- service_role is the server-only secret key (never shipped to the browser); it
-- is meant to have full access and bypass RLS. Restore the standard grants.
-- Idempotent + safe to re-run.
-- ---------------------------------------------------------------------------
grant usage on schema public to service_role;

grant all privileges on all tables    in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant execute on all functions        in schema public to service_role;

-- future tables/sequences created in this schema inherit the grant too
alter default privileges in schema public grant all on tables    to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;
