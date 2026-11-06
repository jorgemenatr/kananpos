-- =====================================================================
-- Stub mínimo de Supabase para correr las migraciones y las pruebas en un
-- Postgres local (NO se aplica en Supabase).
--   auth.uid() lee el claim 'sub' de request.jwt.claims, igual que Supabase.
--   Para actuar como un usuario en una prueba:
--     select set_config('request.jwt.claims', '{"sub":"<uuid>"}', true);
--     set local role authenticated;
-- =====================================================================
-- Los roles son de todo el servidor: solo se crean la primera vez.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit;
  end if;
end $$;

create extension if not exists pgcrypto;

create schema auth;
create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  banned_until       timestamptz,
  last_sign_in_at    timestamptz
);
create table auth.sessions (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null
);
create table auth.refresh_tokens (
  id         bigserial primary key,
  user_id    varchar(255),
  session_id uuid references auth.sessions (id) on delete cascade
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated;

create schema storage;
create table storage.buckets (
  id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;

grant usage on schema public to anon, authenticated, service_role;
-- Como en Supabase: las tablas nuevas dan privilegios por defecto (las migraciones los quitan).
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- Realtime (lo usa 20261031000100_preventas_tickets_compartidos.sql).
create publication supabase_realtime;
