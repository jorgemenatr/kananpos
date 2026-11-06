-- =====================================================================
-- Desactivar / reactivar usuarios (solo admin)
--
-- La Edge Function `desactivar-usuario` bloquea al usuario en Auth
-- (ban_duration) y cierra sus sesiones con revoke_user_sessions. Aquí:
--   · user_access_status(): estado de acceso de cada usuario (lee
--     auth.users.banned_until), solo para admin.
--   · revoke_user_sessions(): borra las sesiones (y sus refresh tokens) de un
--     usuario. Solo la service_role (la Edge Function).
--   · check_request(): se corre antes de cada petición a la API (PostgREST,
--     pgrst.db_pre_request). Rechaza a un usuario desactivado aunque su token
--     de acceso todavía no venza (dura hasta 1 hora).
--   · keep_one_admin: debe quedar al menos un administrador ACTIVO.
--
-- Se puede aplicar antes o después de publicar la app nueva.
-- =====================================================================

-- ---------- estado de acceso (pantalla Usuarios) ----------
create function public.user_access_status()
returns table (id uuid, banned_until timestamptz, last_sign_in_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador puede ver el estado de los usuarios' using errcode = '42501';
  end if;
  return query
    select u.id, u.banned_until, u.last_sign_in_at
    from auth.users u
    join public.profiles p on p.id = u.id;
end;
$$;

revoke all on function public.user_access_status() from public, anon;
grant execute on function public.user_access_status() to authenticated;

-- ---------- cerrar las sesiones de un usuario ----------
create function public.revoke_user_sessions(p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  -- Los refresh tokens se borran en cascada con la sesión; los que no tengan
  -- sesión (versiones viejas de Auth) se borran aparte.
  delete from auth.refresh_tokens where user_id = p_user_id::text;
  delete from auth.sessions where user_id = p_user_id;
$$;

revoke all on function public.revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid) to service_role;

-- ---------- rechazar peticiones de usuarios desactivados ----------
create function public.check_request()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is not null and exists (
    select 1 from auth.users where id = v_uid and banned_until is not null and banned_until > now()
  ) then
    raise exception 'Tu usuario está desactivado. Habla con un administrador.'
      using errcode = '42501', hint = 'usuario_desactivado';
  end if;
end;
$$;

revoke all on function public.check_request() from public;
grant execute on function public.check_request() to anon, authenticated, service_role;

alter role authenticator set pgrst.db_pre_request = 'public.check_request';
notify pgrst, 'reload config';

-- ---------- siempre debe quedar un administrador activo ----------
-- SECURITY DEFINER para poder leer auth.users (quién está desactivado).
create or replace function public.keep_one_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'admin' and new.role <> 'admin'
     and not exists (
       select 1
       from public.profiles p
       join auth.users u on u.id = p.id
       where p.role = 'admin' and p.id <> old.id
         and (u.banned_until is null or u.banned_until <= now())
     ) then
    raise exception 'Debe quedar al menos un administrador activo' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function public.keep_one_admin() from public, anon, authenticated;
