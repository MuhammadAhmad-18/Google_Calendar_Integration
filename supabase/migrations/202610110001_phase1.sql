-- Run once in Supabase SQL Editor, or apply with `supabase db push`.
begin;
create table public.integration_settings (
  id text primary key check (id = 'sandbox'),
  property_id uuid unique,
  property_name text,
  chatbeds_status text not null default 'not_checked',
  chatbeds_error text,
  google_calendar_id text,
  lock_owner uuid,
  lock_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.integration_settings(id) values ('sandbox');

create table public.google_credentials (
  integration_id text primary key references public.integration_settings(id),
  account_sub text not null,
  account_email text,
  calendar_id text not null,
  access_token_encrypted text not null,
  refresh_token_encrypted text not null,
  expires_at bigint not null,
  updated_at timestamptz not null default now()
);

create table public.reservation_calendar_maps (
  id uuid primary key default gen_random_uuid(),
  integration_id text not null references public.integration_settings(id),
  property_id uuid not null,
  reservation_id uuid not null,
  reservation_ref text not null,
  account_sub text not null,
  calendar_id text not null,
  google_event_id text not null,
  generation integer not null default 0,
  active boolean not null default false,
  content_hash text,
  arrival date not null,
  departure date not null,
  reservation_status text not null,
  reservation_updated_at timestamptz not null,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(integration_id, property_id, reservation_id, account_sub, calendar_id),
  unique(account_sub, calendar_id, google_event_id)
);

create table public.webhook_deliveries (
  delivery_id uuid primary key,
  integration_id text not null references public.integration_settings(id),
  event_type text not null,
  property_id uuid not null,
  reservation_id uuid,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received' check(status in ('received','processed','failed','ignored')),
  error text
);

create table public.sync_jobs (
  id uuid primary key default gen_random_uuid(),
  integration_id text not null references public.integration_settings(id),
  kind text not null check(kind in ('manual','webhook')),
  delivery_id uuid unique references public.webhook_deliveries(delivery_id),
  reservation_id uuid,
  event_type text,
  date_from date,
  date_to date,
  cursor jsonb not null default '{}',
  summary jsonb not null default '{"created":0,"updated":0,"deleted":0,"skipped":0,"failed":0}',
  status text not null default 'queued' check(status in ('queued','processing','completed','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sync_jobs_pending on public.sync_jobs(status, next_attempt_at, created_at);
create table public.sync_logs (
  id bigint generated always as identity primary key,
  integration_id text not null references public.integration_settings(id),
  source text not null,
  event_type text,
  reservation_id uuid,
  reservation_ref text,
  google_event_id text,
  action text not null,
  success boolean not null,
  message text not null,
  created_at timestamptz not null default now()
);
create index sync_logs_recent on public.sync_logs(created_at desc);

-- Each lease outlives the 60-second Vercel invocation. No local mutex is used.
create function public.acquire_integration_lock(owner_id uuid) returns boolean
language sql security definer set search_path = '' as $$
  with claimed as (
    update public.integration_settings
    set lock_owner = owner_id, lock_until = now() + interval '120 seconds'
    where id = 'sandbox' and (lock_until is null or lock_until < now()) returning id
  ) select exists(select 1 from claimed);
$$;
create function public.release_integration_lock(owner_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.integration_settings set lock_owner = null, lock_until = null
  where id = 'sandbox' and lock_owner = owner_id;
$$;

-- Acknowledgment is only safe once BOTH delivery and job are committed.
create function public.retry_failed_jobs() returns boolean
language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := gen_random_uuid();
begin
  if not public.acquire_integration_lock(owner_id) then return false; end if;
  update public.sync_jobs set status='queued', error=null, next_attempt_at=now(),
    cursor=case when kind='manual' then '{}'::jsonb else cursor end,
    summary=case when kind='manual' then '{"created":0,"updated":0,"deleted":0,"skipped":0,"failed":0}'::jsonb else summary end,
    updated_at=now()
    where status='failed';
  perform public.release_integration_lock(owner_id);
  return true;
end;
$$;

create function public.enqueue_webhook(p_delivery_id uuid, p_event_type text, p_property_id uuid, p_reservation_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  insert into public.webhook_deliveries(delivery_id,integration_id,event_type,property_id,reservation_id,status,processed_at)
  values(p_delivery_id,'sandbox',p_event_type,p_property_id,p_reservation_id,
    case when p_reservation_id is null then 'ignored' else 'received' end,
    case when p_reservation_id is null then now() else null end)
  on conflict(delivery_id) do nothing;
  if not found then return false; end if;
  if p_reservation_id is not null then
    insert into public.sync_jobs(integration_id,kind,delivery_id,reservation_id,event_type)
    values('sandbox','webhook',p_delivery_id,p_reservation_id,p_event_type);
  end if;
  return true;
end;
$$;

create table public.admin_login_attempts (
  bucket text primary key,
  window_started_at timestamptz not null,
  attempts integer not null
);
create table public.oauth_states (
  state_hash text primary key,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create function public.consume_oauth_state(p_hash text) returns boolean
language sql security definer set search_path = '' as $$
  with consumed as (
    update public.oauth_states set consumed_at = now()
    where state_hash = p_hash and consumed_at is null and expires_at > now() returning state_hash
  ) select exists(select 1 from consumed);
$$;
create function public.allow_admin_login(p_bucket text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare count_now integer;
begin
  insert into public.admin_login_attempts values(p_bucket,now(),1)
  on conflict(bucket) do update set
    attempts = case when public.admin_login_attempts.window_started_at < now() - interval '15 minutes' then 1 else public.admin_login_attempts.attempts + 1 end,
    window_started_at = case when public.admin_login_attempts.window_started_at < now() - interval '15 minutes' then now() else public.admin_login_attempts.window_started_at end
  returning attempts into count_now;
  return count_now <= 10;
end;
$$;

alter table public.integration_settings enable row level security;
alter table public.google_credentials enable row level security;
alter table public.reservation_calendar_maps enable row level security;
alter table public.webhook_deliveries enable row level security;
alter table public.sync_jobs enable row level security;
alter table public.sync_logs enable row level security;
alter table public.admin_login_attempts enable row level security;
alter table public.oauth_states enable row level security;
revoke all on public.integration_settings, public.google_credentials, public.reservation_calendar_maps,
  public.webhook_deliveries, public.sync_jobs, public.sync_logs, public.admin_login_attempts, public.oauth_states from anon, authenticated;
revoke all on function public.acquire_integration_lock(uuid), public.release_integration_lock(uuid),
  public.enqueue_webhook(uuid,text,uuid,uuid), public.allow_admin_login(text), public.consume_oauth_state(text), public.retry_failed_jobs() from public, anon, authenticated;
grant execute on function public.acquire_integration_lock(uuid), public.release_integration_lock(uuid),
  public.enqueue_webhook(uuid,text,uuid,uuid), public.allow_admin_login(text), public.consume_oauth_state(text), public.retry_failed_jobs() to service_role;
grant all on public.integration_settings, public.google_credentials, public.reservation_calendar_maps,
  public.webhook_deliveries, public.sync_jobs, public.sync_logs, public.admin_login_attempts, public.oauth_states to service_role;
grant usage, select on sequence public.sync_logs_id_seq to service_role;
commit;
