-- =====================================================================
-- Pruebas de usuarios desactivados (migración 20261106000200): estado de
-- acceso solo para admin, cerrar sesiones solo con service_role,
-- check_request rechaza a un usuario desactivado y siempre queda un admin
-- activo. Se corren en una base LOCAL con supabase/tests/run.sh.
-- =====================================================================
\set ON_ERROR_STOP 1
\set QUIET 1

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'admin1@prueba.mx'),
  ('00000000-0000-0000-0000-0000000000d2', 'admin2@prueba.mx'),
  ('00000000-0000-0000-0000-0000000000d3', 'mostrador@prueba.mx');
update public.profiles set role = 'admin'
  where id in ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2');
update public.profiles set role = 'mostrador' where id = '00000000-0000-0000-0000-0000000000d3';
insert into auth.sessions (user_id) values ('00000000-0000-0000-0000-0000000000d3');
insert into auth.refresh_tokens (user_id, session_id) select user_id::text, id from auth.sessions;

-- ---------- 1. Estado de acceso: admin sí, mostrador no ----------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1"}', false);
set role authenticated;
do $$ begin
  if (select count(*) from public.user_access_status()) < 3 then
    raise exception 'FALLA 1a: el admin no ve el estado de los usuarios';
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d3"}', false);
set role authenticated;
do $$ begin
  begin
    perform public.user_access_status();
    raise exception 'FALLA 1b: el mostrador vio el estado de los usuarios';
  exception when insufficient_privilege then null;
  end;
  -- ---------- 2. Cerrar sesiones: no desde la app ----------
  begin
    perform public.revoke_user_sessions('00000000-0000-0000-0000-0000000000d3');
    raise exception 'FALLA 2a: un usuario cerró sesiones ajenas';
  exception when insufficient_privilege then null;
  end;
  perform public.check_request();  -- activo: pasa
end $$;
reset role;

set role service_role;
select public.revoke_user_sessions('00000000-0000-0000-0000-0000000000d3');
reset role;
do $$ begin
  if exists (select 1 from auth.sessions) or exists (select 1 from auth.refresh_tokens) then
    raise exception 'FALLA 2b: quedaron sesiones del usuario desactivado';
  end if;
end $$;

-- ---------- 3. check_request rechaza al desactivado; anon pasa ----------
update auth.users set banned_until = now() + interval '876000 hours'
  where id = '00000000-0000-0000-0000-0000000000d3';
set role authenticated;
do $$ begin
  begin
    perform public.check_request();
    raise exception 'FALLA 3a: un usuario desactivado pudo usar la API';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
select set_config('request.jwt.claims', '', false);
set role anon;
select public.check_request();
reset role;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator'
                 and 'pgrst.db_pre_request=public.check_request' = any (rolconfig)) then
    raise exception 'FALLA 3b: falta pgrst.db_pre_request';
  end if;
end $$;

-- ---------- 4. Siempre queda un admin activo ----------
update auth.users set banned_until = now() + interval '876000 hours'
  where id = '00000000-0000-0000-0000-0000000000d2';
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1"}', false);
set role authenticated;
do $$ begin
  begin
    update public.profiles set role = 'mostrador' where id = '00000000-0000-0000-0000-0000000000d1';
    raise exception 'FALLA 4a: se quitó el último admin activo';
  exception when invalid_parameter_value then null;
  end;
end $$;
reset role;
update auth.users set banned_until = null where id = '00000000-0000-0000-0000-0000000000d2';
set role authenticated;
update public.profiles set role = 'mostrador' where id = '00000000-0000-0000-0000-0000000000d1';
reset role;

select 'OK: usuarios desactivados';
