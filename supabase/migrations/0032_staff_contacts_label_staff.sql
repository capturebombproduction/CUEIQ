-- 0032_staff_contacts_label_staff.sql
-- Let approvers (admin + label_staff) MANAGE the label crew directory, not just
-- admins. Rationale: label_staff owns the Overview schedule + its "บันทึกเป็นรูป"
-- export, which pulls in this crew list — so they maintain it. ceo stays
-- read-only (an observer, not an approver). The SELECT policy is unchanged (any
-- tenant member, so the export can read it). `can_approve(tid)` = admin OR
-- label_staff (see 0016).
drop policy if exists staff_contacts_insert on public.staff_contacts;
create policy staff_contacts_insert on public.staff_contacts
  for insert with check (public.can_approve(tenant_id));

drop policy if exists staff_contacts_update on public.staff_contacts;
create policy staff_contacts_update on public.staff_contacts
  for update using (public.can_approve(tenant_id))
  with check (public.can_approve(tenant_id));

drop policy if exists staff_contacts_delete on public.staff_contacts;
create policy staff_contacts_delete on public.staff_contacts
  for delete using (public.can_approve(tenant_id));
