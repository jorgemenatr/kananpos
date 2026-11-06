-- =====================================================================
-- Pruebas de permisos: un usuario con sesión no puede escribir directo en
-- las tablas de ventas, créditos, puntos e historial; solo con las
-- funciones del servidor. Se corren en una base LOCAL con
-- supabase/tests/run.sh, nunca contra la base real.
-- =====================================================================
\set ON_ERROR_STOP 1
\set QUIET 1

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'admin@prueba.mx'),
  ('00000000-0000-0000-0000-0000000000f2', 'mostrador@prueba.mx');
update public.profiles set role = 'admin'     where id = '00000000-0000-0000-0000-0000000000f1';
update public.profiles set role = 'mostrador' where id = '00000000-0000-0000-0000-0000000000f2';
insert into public.customers (id, name) values ('00000000-0000-0000-0000-0000000000c9', 'Cliente prueba');

-- Mostrador
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2"}', false);
set role authenticated;

-- ---------- 1. Las funciones del servidor siguen funcionando ----------
do $$
declare r jsonb;
begin
  r := public.grant_credits(gen_random_uuid(), 'Premio torneo',
         '[{"customer_id":"00000000-0000-0000-0000-0000000000c9","amount":50}]'::jsonb);
  if r ->> 'status' <> 'ok' then raise exception 'FALLA 1a: grant_credits %', r; end if;
  if (select created_by from public.customer_credit_movements limit 1)
     is distinct from '00000000-0000-0000-0000-0000000000f2'::uuid then
    raise exception 'FALLA 1b: el autor del crédito no es quien lo dio';
  end if;

  r := public.grant_league_points(gen_random_uuid(), null, 'Liga',
         '[{"customer_id":"00000000-0000-0000-0000-0000000000c9","points":3}]'::jsonb);
  if r ->> 'status' <> 'ok' then raise exception 'FALLA 1c: grant_league_points %', r; end if;
end $$;

-- ---------- 2. Escritura directa: bloqueada ----------
do $$
declare
  v_ticket uuid := gen_random_uuid();
  t text;
begin
  begin
    insert into public.tickets (id, name, number, status, paid_at, item_count, subtotal, total, created_by)
    values (v_ticket, 'FALSO', 999999, 'paid', now(), 1, 0, 0, auth.uid());
    raise exception 'FALLA 2a: insertó un ticket directo';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.customer_credit_movements (customer_id, kind, amount, note, created_by)
    values ('00000000-0000-0000-0000-0000000000c9', 'grant', 5000, 'regalo', auth.uid());
    raise exception 'FALLA 2b: insertó crédito directo';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.customer_league_points (customer_id, points, created_by)
    values ('00000000-0000-0000-0000-0000000000c9', 100, auth.uid());
    raise exception 'FALLA 2c: insertó puntos directo';
  exception when insufficient_privilege then null;
  end;

  foreach t in array array['ticket_items', 'ticket_payments', 'inventory_movements'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'insert') then
      raise exception 'FALLA 2d: authenticated aún puede insertar en %', t;
    end if;
  end loop;

  begin
    perform public._next_ticket_number();
    raise exception 'FALLA 2e: pudo consumir un folio';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- ---------- 3. anon no ejecuta nada ----------
set role anon;
do $$ begin
  begin
    perform public.grant_credits(gen_random_uuid(), 'x',
      '[{"customer_id":"00000000-0000-0000-0000-0000000000c9","amount":1}]'::jsonb);
    raise exception 'FALLA 3: anon pudo dar crédito';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

\echo 'permisos_test: OK'
