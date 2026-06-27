-- =====================================================================
-- CueIQ — split "G-D!" back out as its own band/group (user-confirmed 2026-06-27).
--   G-D! is HatoBito's unit; seed_angevil_fixups had folded it INTO HatoBito's
--   group so the Overview showed "HatoBito" twice. พี่ now wants the 12:30 slot
--   billed as "G-D!" everywhere (matches the official ANGeVIL timetable). G-D!
--   already performed today, so reassigning the slot's group mid-day is safe.
--
--   To avoid the RBAC downside of a split (HatoBito's members losing edit access
--   to the slot), the HatoBito users are granted the SAME roles on G-D! → "user
--   ฮาโตะ" can view/edit BOTH bands.
--
--   Idempotent: fixed group id, on-conflict upsert, anti-join role copy. The
--   events UPDATE trips events_guard_update on a null auth.uid() → disable around it.
-- =====================================================================

-- 1) (Re)create the G-D! group. Amber (distinct from HatoBito's pink so the two
--    Overview dots don't look identical); change in the band manager any time.
insert into public.groups (id, tenant_id, name, color, self_photo, exempt_from_deadline)
values ('0000000a-0000-0000-0000-000000000d01','00000000-0000-0000-0000-000000000001',
        'G-D!','#F59E0B', false, false)
on conflict (id) do update set name = excluded.name, color = excluded.color;

-- 2) Move the G-D! slot event (…2e01) from HatoBito's group to the G-D! group.
alter table public.events disable trigger events_guard_update;
update public.events
   set group_id = '0000000a-0000-0000-0000-000000000d01'
 where id = '0000000a-0000-0000-0000-0000000a2e01';
alter table public.events enable trigger events_guard_update;

-- 3) Give every HatoBito user the same role on G-D! (so they access both bands).
insert into public.group_roles (id, tenant_id, group_id, user_id, role)
select gen_random_uuid(), src.tenant_id,
       '0000000a-0000-0000-0000-000000000d01', src.user_id, src.role
  from public.group_roles src
 where src.group_id = '4a7ae06f-ac32-40ad-8d10-5bc7418dd323'
   and not exists (
     select 1 from public.group_roles dst
      where dst.group_id = '0000000a-0000-0000-0000-000000000d01'
        and dst.user_id = src.user_id);
