-- Additive: keep applied public-hotel migrations and existing credentials intact.
begin;
create table public.google_onboarding (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_sub text not null,
  account_email text not null,
  calendar_id text not null,
  access_token_encrypted text not null,
  refresh_token_encrypted text not null,
  expires_at bigint not null,
  scope text not null,
  valid_until timestamptz not null,
  created_at timestamptz not null default now()
);
create index google_onboarding_expiry on public.google_onboarding(valid_until);
create index google_onboarding_account on public.google_onboarding(account_sub);
alter table public.google_onboarding enable row level security;
revoke all on public.google_onboarding from anon,authenticated;
grant all on public.google_onboarding to service_role;

create function public.attach_hotel_google(p_user_id uuid,p_onboarding_id uuid,p_integration_id text) returns void
language plpgsql security definer set search_path='' as $$
declare grant_row public.google_onboarding%rowtype;
begin
  if not exists(select 1 from public.integration_members where user_id=p_user_id and integration_id=p_integration_id) then
    raise exception 'Property unavailable in this workspace';
  end if;
  perform id from public.integration_settings where id=p_integration_id for update;
  select * into grant_row from public.google_onboarding where id=p_onboarding_id and user_id=p_user_id and valid_until>now() for update;
  if not found then raise exception 'Google setup expired or already used'; end if;
  if not ('https://www.googleapis.com/auth/calendar.events'=any(string_to_array(grant_row.scope,' '))) then
    raise exception 'Calendar permission required';
  end if;
  insert into public.google_credentials(integration_id,account_sub,account_email,calendar_id,access_token_encrypted,refresh_token_encrypted,expires_at)
    values(p_integration_id,grant_row.account_sub,grant_row.account_email,grant_row.calendar_id,grant_row.access_token_encrypted,grant_row.refresh_token_encrypted,grant_row.expires_at)
  on conflict(integration_id) do update set account_sub=excluded.account_sub,account_email=excluded.account_email,calendar_id=excluded.calendar_id,
    access_token_encrypted=excluded.access_token_encrypted,refresh_token_encrypted=excluded.refresh_token_encrypted,expires_at=excluded.expires_at,updated_at=now();
  update public.integration_settings set google_calendar_id=grant_row.calendar_id,updated_at=now() where id=p_integration_id;
  insert into public.sync_logs(integration_id,source,action,success,message)
    values(p_integration_id,'oauth','connect',true,'Google Calendar connected automatically during Google sign-in.');
  delete from public.google_onboarding where id=p_onboarding_id;
end;
$$;
-- Complete both provider connections atomically. An ownership conflict or expired
-- setup rolls back ChatBeds token replacement as well as Google changes.
create function public.install_hotel_with_google(p_user_id uuid,p_property_id uuid,p_installation_id uuid,p_access text,p_refresh text,p_expiry bigint,p_scope text,p_onboarding_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare target_id text;
begin
  if not exists(select 1 from public.google_onboarding where id=p_onboarding_id and user_id=p_user_id and valid_until>now()) then
    raise exception 'Google setup expired or already used';
  end if;
  target_id := public.install_hotel_chatbeds(p_user_id,p_property_id,p_installation_id,p_access,p_refresh,p_expiry,p_scope);
  perform public.attach_hotel_google(p_user_id,p_onboarding_id,target_id);
  return target_id;
end;
$$;
create or replace function public.cleanup_integration_history(p_days integer) returns void
language plpgsql security definer set search_path='' as $$
begin
  if p_days<7 or p_days>3650 then raise exception 'Invalid retention period'; end if;
  delete from public.sync_logs where created_at<now()-make_interval(days=>p_days);
  delete from public.sync_jobs where status='completed' and updated_at<now()-make_interval(days=>p_days);
  delete from public.oauth_states where expires_at<now()-interval '1 day';
  delete from public.public_auth_attempts where window_started<now()-interval '1 day';
  delete from public.admin_login_attempts where window_started_at<now()-interval '1 day';
  delete from public.google_onboarding where valid_until<now();
end;
$$;
revoke all on function public.attach_hotel_google(uuid,uuid,text),public.install_hotel_with_google(uuid,uuid,uuid,text,text,bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.attach_hotel_google(uuid,uuid,text),public.install_hotel_with_google(uuid,uuid,uuid,text,text,bigint,text,uuid) to service_role;
commit;
