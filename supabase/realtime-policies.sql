-- CareerOS private Realtime authorisation. Run once in the Supabase SQL editor.
create table if not exists public.careeros_workspace_members (
  workspace_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null default '',
  role text not null check (role in ('owner', 'editor', 'viewer')),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

alter table public.careeros_workspace_members enable row level security;

revoke insert, update, delete on public.careeros_workspace_members from authenticated;
grant select on public.careeros_workspace_members to authenticated;

drop policy if exists "members can read own CareerOS membership" on public.careeros_workspace_members;
create policy "members can read own CareerOS membership"
on public.careeros_workspace_members
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "CareerOS members can receive private broadcasts" on realtime.messages;
create policy "CareerOS members can receive private broadcasts"
on realtime.messages
for select
to authenticated
using (
  realtime.topic() like 'careeros:%'
  and exists (
    select 1 from public.careeros_workspace_members member
    where member.user_id = auth.uid()
      and member.workspace_id = split_part(realtime.topic(), ':', 2)
  )
);

drop policy if exists "CareerOS members can send private broadcasts" on realtime.messages;
create policy "CareerOS members can send private broadcasts"
on realtime.messages
for insert
to authenticated
with check (
  realtime.topic() like 'careeros:%'
  and exists (
    select 1 from public.careeros_workspace_members member
    where member.user_id = auth.uid()
      and member.workspace_id = split_part(realtime.topic(), ':', 2)
  )
);
