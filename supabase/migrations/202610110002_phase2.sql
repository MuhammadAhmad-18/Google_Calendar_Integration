-- Additive migration: preserve sandbox Google credentials, mappings and jobs.
begin;
alter table public.integration_settings drop constraint integration_settings_id_check;
alter table public.integration_settings
  add column auth_mode text not null default 'api_key' check(auth_mode in ('api_key','oauth')),
  add column installation_id uuid unique,
  add column chatbeds_scope text,
  add column chatbeds_retry_at timestamptz,
  add column chatbeds_rate_window timestamptz,
  add column chatbeds_rate_count integer not null default 0,
  add column last_worker_at timestamptz;
create table public.chatbeds_credentials (
  integration_id text primary key references public.integration_settings(id),
  installation_id uuid not null unique,
  property_id uuid not null unique,
  access_token_encrypted text not null,
  refresh_token_encrypted text not null,
  expires_at bigint not null,
  scope text not null,
  refresh_started boolean not null default false,
  refresh_lock_owner uuid,
  refresh_lock_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.chatbeds_credentials enable row level security;
revoke all on public.chatbeds_credentials from anon,authenticated;
grant all on public.chatbeds_credentials to service_role;
create index sync_jobs_installation_pending on public.sync_jobs(integration_id,status,next_attempt_at,created_at);
create index sync_logs_installation_recent on public.sync_logs(integration_id,created_at desc);
-- Google's app grant is account-wide; serializing Google requests/account
-- changes prevents another property's refresh from restoring revoked tokens.
create table public.provider_locks (
  id text primary key, owner uuid, expires_at timestamptz
);
insert into public.provider_locks(id) values('google');
alter table public.provider_locks enable row level security;
revoke all on public.provider_locks from anon,authenticated;
grant all on public.provider_locks to service_role;
create function public.acquire_google_grant_lock(p_owner uuid) returns boolean
language sql security definer set search_path='' as $$
  with claimed as (
    update public.provider_locks set owner=p_owner,expires_at=now()+interval '120 seconds'
    where id='google' and (expires_at is null or expires_at<now()) returning id
  ) select exists(select 1 from claimed);
$$;
create function public.release_google_grant_lock(p_owner uuid) returns void
language sql security definer set search_path='' as $$
  update public.provider_locks set owner=null,expires_at=null where id='google' and owner=p_owner;
$$;
revoke all on function public.acquire_google_grant_lock(uuid),public.release_google_grant_lock(uuid) from public,anon,authenticated;
grant execute on function public.acquire_google_grant_lock(uuid),public.release_google_grant_lock(uuid) to service_role;

create function public.acquire_installation_lock(p_integration_id text,owner_id uuid) returns boolean
language sql security definer set search_path='' as $$
  with claimed as (
    update public.integration_settings set lock_owner=owner_id,lock_until=now()+interval '120 seconds'
    where id=p_integration_id and (lock_until is null or lock_until<now()) returning id
  ) select exists(select 1 from claimed);
$$;
create function public.release_installation_lock(p_integration_id text,owner_id uuid) returns void
language sql security definer set search_path='' as $$
  update public.integration_settings set lock_owner=null,lock_until=null
  where id=p_integration_id and lock_owner=owner_id;
$$;
-- Refresh has its own lease, usable inside the sync lease. The durable marker
-- prevents reuse of a single-use refresh token after a crash or uncertain result.
create function public.acquire_chatbeds_refresh(p_integration_id text,p_owner uuid) returns boolean
language sql security definer set search_path='' as $$
  with claimed as (
    update public.chatbeds_credentials set refresh_lock_owner=p_owner,refresh_lock_until=now()+interval '120 seconds'
    where integration_id=p_integration_id and (refresh_lock_until is null or refresh_lock_until<now()) returning integration_id
  ) select exists(select 1 from claimed);
$$;
create function public.release_chatbeds_refresh(p_integration_id text,p_owner uuid) returns void
language sql security definer set search_path='' as $$
  update public.chatbeds_credentials set refresh_lock_owner=null,refresh_lock_until=null
  where integration_id=p_integration_id and refresh_lock_owner=p_owner;
$$;
create function public.begin_chatbeds_refresh(p_integration_id text,p_owner uuid) returns boolean
language sql security definer set search_path='' as $$
  with started as (
    update public.chatbeds_credentials set refresh_started=true,updated_at=now()
    where integration_id=p_integration_id and refresh_lock_owner=p_owner and refresh_lock_until>now()
      and not refresh_started returning integration_id
  ) select exists(select 1 from started);
$$;
create function public.finish_chatbeds_refresh(p_integration_id text,p_owner uuid,p_access text,p_refresh text,p_expiry bigint,p_scope text) returns boolean
language sql security definer set search_path='' as $$
  with saved as (
    update public.chatbeds_credentials set access_token_encrypted=p_access,refresh_token_encrypted=p_refresh,
      expires_at=p_expiry,scope=p_scope,refresh_started=false,updated_at=now()
    where integration_id=p_integration_id and refresh_lock_owner=p_owner and refresh_lock_until>now()
      and refresh_started returning integration_id
  ) select exists(select 1 from saved);
$$;
create function public.cancel_chatbeds_refresh(p_integration_id text,p_owner uuid) returns void
language sql security definer set search_path='' as $$
  update public.chatbeds_credentials set refresh_started=false
  where integration_id=p_integration_id and refresh_lock_owner=p_owner and refresh_lock_until>now();
$$;

-- Reconnecting the same property preserves its integration ID and Google maps.
create function public.install_chatbeds(p_property_id uuid,p_installation_id uuid,p_access text,p_refresh text,p_expiry bigint,p_scope text)
returns text language plpgsql security definer set search_path='' as $$
declare target_id text;
begin
  insert into public.integration_settings(id,property_id,auth_mode,installation_id,chatbeds_scope,chatbeds_status)
  values(p_installation_id::text,p_property_id,'oauth',p_installation_id,p_scope,'connected')
  on conflict(property_id) do nothing;
  select id into target_id from public.integration_settings where property_id=p_property_id for update;
  perform integration_id from public.chatbeds_credentials where integration_id=target_id for update;
  if exists(select 1 from public.integration_settings where id=target_id and lock_until>now())
    or exists(select 1 from public.chatbeds_credentials where integration_id=target_id and refresh_lock_until>now()) then
    raise exception 'Installation busy';
  end if;
  update public.integration_settings set auth_mode='oauth',installation_id=p_installation_id,chatbeds_scope=p_scope,
    chatbeds_status='connected',chatbeds_error=null,updated_at=now() where id=target_id;
  insert into public.chatbeds_credentials(integration_id,installation_id,property_id,access_token_encrypted,refresh_token_encrypted,expires_at,scope)
  values(target_id,p_installation_id,p_property_id,p_access,p_refresh,p_expiry,p_scope)
  on conflict(integration_id) do update set installation_id=excluded.installation_id,property_id=excluded.property_id,
    access_token_encrypted=excluded.access_token_encrypted,refresh_token_encrypted=excluded.refresh_token_encrypted,
    expires_at=excluded.expires_at,scope=excluded.scope,refresh_started=false,refresh_lock_owner=null,refresh_lock_until=null,updated_at=now();
  return target_id;
end;
$$;
create function public.enqueue_installation_webhook(p_integration_id text,p_delivery_id uuid,p_event_type text,p_property_id uuid,p_reservation_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.integration_settings where id=p_integration_id and property_id=p_property_id) then
    raise exception 'Property does not match installation';
  end if;
  insert into public.webhook_deliveries(delivery_id,integration_id,event_type,property_id,reservation_id,status,processed_at)
  values(p_delivery_id,p_integration_id,p_event_type,p_property_id,p_reservation_id,
    case when p_reservation_id is null then 'ignored' else 'received' end,
    case when p_reservation_id is null then now() else null end) on conflict(delivery_id) do nothing;
  if not found then return false; end if;
  if p_reservation_id is not null then
    insert into public.sync_jobs(integration_id,kind,delivery_id,reservation_id,event_type)
    values(p_integration_id,'webhook',p_delivery_id,p_reservation_id,p_event_type);
  end if;
  return true;
end;
$$;
-- Keep below the documented 120/minute across ALL concurrent requests.
create function public.claim_chatbeds_request(p_integration_id text) returns integer
language plpgsql security definer set search_path='' as $$
declare item public.integration_settings%rowtype;
begin
  select * into item from public.integration_settings where id=p_integration_id for update;
  if not found then raise exception 'Unknown installation'; end if;
  if item.chatbeds_retry_at>now() then return greatest(1,ceil(extract(epoch from item.chatbeds_retry_at-now()))::integer); end if;
  if item.chatbeds_rate_window is null or item.chatbeds_rate_window<now()-interval '60 seconds' then
    update public.integration_settings set chatbeds_rate_window=now(),chatbeds_rate_count=1 where id=p_integration_id;
    return 0;
  end if;
  if item.chatbeds_rate_count>=100 then return greatest(1,ceil(extract(epoch from item.chatbeds_rate_window+interval '60 seconds'-now()))::integer); end if;
  update public.integration_settings set chatbeds_rate_count=chatbeds_rate_count+1 where id=p_integration_id;
  return 0;
end;
$$;
create function public.retry_installation_jobs(p_integration_id text) returns boolean
language plpgsql security definer set search_path='' as $$
declare owner_id uuid := gen_random_uuid();
begin
  if not public.acquire_installation_lock(p_integration_id,owner_id) then return false; end if;
  update public.sync_jobs set status='queued',error=null,next_attempt_at=now(),
    cursor=case when kind='manual' then '{}'::jsonb else cursor end,
    summary=case when kind='manual' then '{"created":0,"updated":0,"deleted":0,"skipped":0,"failed":0}'::jsonb else summary end,updated_at=now()
    where integration_id=p_integration_id and status='failed';
  perform public.release_installation_lock(p_integration_id,owner_id);
  return true;
end;
$$;
create function public.ready_chatbeds_installations() returns table(integration_id text)
language sql security definer set search_path='' as $$
  select installation.id from public.integration_settings installation
  where installation.chatbeds_status='connected'
    and exists(select 1 from public.google_credentials credentials where credentials.integration_id=installation.id)
    and exists(select 1 from public.sync_jobs job where job.integration_id=installation.id
      and (job.status in ('queued','processing') or (job.status='failed' and job.kind='webhook')) and job.next_attempt_at<=now())
  order by installation.last_worker_at nulls first,installation.id limit 4;
$$;
revoke all on function public.ready_chatbeds_installations() from public,anon,authenticated;
grant execute on function public.ready_chatbeds_installations() to service_role;
revoke all on function public.acquire_installation_lock(text,uuid),public.release_installation_lock(text,uuid),
  public.acquire_chatbeds_refresh(text,uuid),public.release_chatbeds_refresh(text,uuid),public.begin_chatbeds_refresh(text,uuid),
  public.finish_chatbeds_refresh(text,uuid,text,text,bigint,text),public.install_chatbeds(uuid,uuid,text,text,bigint,text),
  public.enqueue_installation_webhook(text,uuid,text,uuid,uuid),public.retry_installation_jobs(text),public.claim_chatbeds_request(text),public.cancel_chatbeds_refresh(text,uuid) from public,anon,authenticated;
grant execute on function public.acquire_installation_lock(text,uuid),public.release_installation_lock(text,uuid),
  public.acquire_chatbeds_refresh(text,uuid),public.release_chatbeds_refresh(text,uuid),public.begin_chatbeds_refresh(text,uuid),
  public.finish_chatbeds_refresh(text,uuid,text,text,bigint,text),public.install_chatbeds(uuid,uuid,text,text,bigint,text),
  public.enqueue_installation_webhook(text,uuid,text,uuid,uuid),public.retry_installation_jobs(text),public.claim_chatbeds_request(text),public.cancel_chatbeds_refresh(text,uuid) to service_role;
commit;
