-- 0019_event_template.sql
-- Phase 4 template support. A template is a normal event flagged is_template=true
-- that serves as the "create from template" source + the completeness baseline
-- reference. Templates are hidden from the dashboard / overview event lists and
-- are not run through the completeness auto-transition (they stay as-is). RLS is
-- unchanged — a template is owned by a band like any event, so the existing
-- per-band policies already govern who can read/clone/edit it.
alter table public.events
  add column if not exists is_template boolean not null default false;
