-- Apply after Phase 2. Existing connections are deliberately not auto-claimed.
begin;
create table public.integration_members (
  integration_id text not null references public.integration_settings(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check(role in ('owner','manager')),
  created_at timestamptz not null default now(),
  primary key(integration_id,user_id)
);
create index integration_members_user on public.integration_members(user_id);
create unique index integration_one_owner on public.integration_members(integration_id) where role='owner';
alter table public.integration_members enable row level security;
-- Public users access data only through authenticated, membership-checked routes.
revoke all on public.integration_members from anon,authenticated;
grant all on public.integration_members to service_role;

create table public.public_auth_attempts (
  bucket text primary key, window_started timestamptz not null default now(), attempts integer not null default 1
);
alter table public.public_auth_attempts enable row level security;
revoke all on public.public_auth_attempts from anon,authenticated;
grant all on public.public_auth_attempts to service_role;
create function public.allow_public_auth(p_bucket text,p_limit integer,p_window_seconds integer) returns boolean
language plpgsql security definer set search_path='' as $$
declare item public.public_auth_attempts%rowtype;
begin
  if p_limit<1 or p_limit>1000 or p_window_seconds<60 or p_window_seconds>86400 or length(p_bucket)>200 then raise exception 'Invalid rate limit'; end if;
  insert into public.public_auth_attempts(bucket) values(p_bucket) on conflict do nothing;
  if found then return true; end if;
  select * into item from public.public_auth_attempts where bucket=p_bucket for update;
  if item.window_started<now()-make_interval(secs=>p_window_seconds) then
    update public.public_auth_attempts set attempts=1,window_started=now() where bucket=p_bucket; return true;
  end if;
  if item.attempts>=p_limit then return false; end if;
  update public.public_auth_attempts set attempts=attempts+1 where bucket=p_bucket; return true;
end;
$$;
create function public.ensure_hotel_workspace(p_user_id uuid) returns text
language plpgsql security definer set search_path='' as $$
declare target_id text;
begin
  perform pg_advisory_xact_lock(hashtextextended('workspace:'||p_user_id::text,0));
  if not exists(select 1 from auth.users where id=p_user_id and email_confirmed_at is not null) then raise exception 'Verified hotel user required'; end if;
  select m.integration_id into target_id from public.integration_members m join public.integration_settings i on i.id=m.integration_id
    where m.user_id=p_user_id order by i.property_id nulls last,m.created_at limit 1;
  if target_id is not null then return target_id; end if;
  target_id := gen_random_uuid()::text;
  insert into public.integration_settings(id,auth_mode) values(target_id,'oauth');
  insert into public.integration_members(integration_id,user_id) values(target_id,p_user_id);
  return target_id;
end;
$$;
-- Membership is checked before touching any existing credentials. The property
-- advisory lock serializes first installation across different hotel users.
create function public.install_hotel_chatbeds(p_user_id uuid,p_property_id uuid,p_installation_id uuid,p_access text,p_refresh text,p_expiry bigint,p_scope text)
returns text language plpgsql security definer set search_path='' as $$
declare target_id text;
begin
  if not exists(select 1 from auth.users where id=p_user_id and email_confirmed_at is not null) then raise exception 'Verified hotel user required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('property:'||p_property_id::text,0));
  select id into target_id from public.integration_settings where property_id=p_property_id for update;
  if target_id is not null and not exists(select 1 from public.integration_members where integration_id=target_id and user_id=p_user_id) then
    raise exception 'Property unavailable in this workspace';
  end if;
  target_id := public.install_chatbeds(p_property_id,p_installation_id,p_access,p_refresh,p_expiry,p_scope);
  insert into public.integration_members(integration_id,user_id) values(target_id,p_user_id) on conflict do nothing;
  return target_id;
end;
$$;
create function public.cleanup_integration_history(p_days integer) returns void
language plpgsql security definer set search_path='' as $$
begin
  if p_days<7 or p_days>3650 then raise exception 'Invalid retention period'; end if;
  delete from public.sync_logs where created_at<now()-make_interval(days=>p_days);
  delete from public.sync_jobs where status='completed' and updated_at<now()-make_interval(days=>p_days);
  -- Delivery IDs/mappings remain to protect idempotency until operator deletion.
  delete from public.oauth_states where expires_at<now()-interval '1 day';
  delete from public.public_auth_attempts where window_started<now()-interval '1 day';
  delete from public.admin_login_attempts where window_started_at<now()-interval '1 day';
end;
$$;
revoke all on function public.allow_public_auth(text,integer,integer),public.ensure_hotel_workspace(uuid),
  public.install_hotel_chatbeds(uuid,uuid,uuid,text,text,bigint,text),public.cleanup_integration_history(integer) from public,anon,authenticated;
grant execute on function public.allow_public_auth(text,integer,integer),public.ensure_hotel_workspace(uuid),
  public.install_hotel_chatbeds(uuid,uuid,uuid,text,text,bigint,text),public.cleanup_integration_history(integer) to service_role;
commit;
