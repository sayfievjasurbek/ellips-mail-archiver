create table if not exists app_state (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
create table if not exists forwarded_emails (
  gmail_message_id text primary key,
  thread_id text,
  forwarded_at timestamptz,
  status text not null default 'processing',
  sent_steps jsonb not null default '[]'::jsonb,
  lease_until timestamptz,
  error text
);
create table if not exists archived_chats (
  chat_id text primary key,
  title text not null,
  username text,
  last_message_id bigint not null default 0,
  added_at timestamptz not null default now(),
  active boolean not null default true,
  drive_folder_id text,
  sheet_tab_id integer
);
create table if not exists archived_files (
  chat_id text not null references archived_chats(chat_id),
  message_id bigint not null,
  file_unique_id text,
  drive_file_id text,
  archived_at timestamptz,
  status text not null default 'processing',
  lease_until timestamptz,
  error text,
  primary key (chat_id, message_id)
);
create table if not exists message_log (
  id bigint generated always as identity primary key,
  action text not null,
  status text not null,
  source_id text,
  details jsonb,
  created_at timestamptz not null default now()
);
create index if not exists message_log_created_at_idx on message_log(created_at desc);

create or replace function claim_email(p_id text, p_thread text)
returns boolean language plpgsql security definer as $$
begin
  insert into forwarded_emails(gmail_message_id, thread_id, lease_until)
    values (p_id, p_thread, now() + interval '10 minutes')
  on conflict (gmail_message_id) do update
    set status = 'processing', lease_until = now() + interval '10 minutes', error = null
    where forwarded_emails.status = 'failed'
       or (forwarded_emails.status = 'processing' and forwarded_emails.lease_until < now());
  return found;
end $$;

create or replace function claim_file(p_chat text, p_message bigint, p_unique text)
returns boolean language plpgsql security definer as $$
begin
  insert into archived_files(chat_id, message_id, file_unique_id, lease_until)
    values (p_chat, p_message, p_unique, now() + interval '10 minutes')
  on conflict (chat_id, message_id) do update
    set status = 'processing', lease_until = now() + interval '10 minutes', error = null
    where archived_files.status = 'failed'
       or (archived_files.status = 'processing' and archived_files.lease_until < now());
  return found;
end $$;

create or replace function claim_job(p_key text, p_seconds integer)
returns boolean language plpgsql security definer as $$
begin
  insert into app_state(key, value) values (p_key, (now() + make_interval(secs => p_seconds))::text)
  on conflict (key) do update set value = excluded.value, updated_at = now()
    where app_state.value::timestamptz < now();
  return found;
end $$;

alter table app_state enable row level security;
alter table forwarded_emails enable row level security;
alter table archived_chats enable row level security;
alter table archived_files enable row level security;
alter table message_log enable row level security;
revoke all on function claim_email(text,text) from public, anon, authenticated;
revoke all on function claim_file(text,bigint,text) from public, anon, authenticated;
revoke all on function claim_job(text,integer) from public, anon, authenticated;
grant execute on function claim_email(text,text) to service_role;
grant execute on function claim_file(text,bigint,text) to service_role;
grant execute on function claim_job(text,integer) to service_role;
