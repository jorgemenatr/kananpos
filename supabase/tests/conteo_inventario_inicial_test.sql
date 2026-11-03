-- =====================================================================
-- Pruebas de Inventario inicial / Conteo y ajustes (initial_load_open y
-- register_scan con motivo). Se corren en una base LOCAL recién creada con
-- supabase/tests/run.sh, nunca contra la base real.
-- =====================================================================
\set ON_ERROR_STOP 1
\set QUIET 1

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'admin@prueba.mx'),
  ('00000000-0000-0000-0000-0000000000e2', 'mostrador@prueba.mx');
update public.profiles set role = 'admin'     where id = '00000000-0000-0000-0000-0000000000e1';
update public.profiles set role = 'mostrador' where id = '00000000-0000-0000-0000-0000000000e2';
insert into public.suppliers (name) values ('Proveedor A'), ('Proveedor Z');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1"}', false);
set role authenticated;

-- ---------- 1. Abierto (por defecto): escaneo libre como antes ----------
do $$
declare r jsonb;
begin
  if not (select initial_load_open from public.app_settings) then
    raise exception 'FALLA 1a: el inventario inicial no empieza abierto';
  end if;
  perform public.create_product('CONT1', 'Booster', 90, 40, null, 'Proveedor A', 3);
  r := public.register_scan('CONT1', 'add', 2);
  if r ->> 'movement_type' <> 'scan_add' then
    raise exception 'FALLA 1b: escaneo sin motivo no es scan_add: %', r;
  end if;
  if (select quantity from public.products where barcode = 'CONT1') <> 5 then
    raise exception 'FALLA 1c: no sumó';
  end if;
end $$;

-- ---------- 2. Con motivo: ajuste con el último costo, sin proveedor nuevo ----------
do $$
declare
  r   jsonb;
  v_s uuid := (select id from public.suppliers where name = 'Proveedor Z');
begin
  r := public.register_scan('CONT1', 'add', 4, null, null, 'store', v_s, 999, null, null, '  Piezas encontradas  ');
  if r ->> 'movement_type' <> 'adjustment' then
    raise exception 'FALLA 2a: con motivo no es ajuste: %', r;
  end if;
  perform set_config('prueba.movimiento', r ->> 'movement_id', false);
end $$;

reset role;
do $$
declare
  v_m   uuid := current_setting('prueba.movimiento')::uuid;
  v_p   uuid := (select id from public.products where barcode = 'CONT1');
  v_lot record;
begin
  if (select note from public.inventory_movements where id = v_m) <> 'Conteo (sumar). Motivo: Piezas encontradas' then
    raise exception 'FALLA 2b: nota del ajuste: %', (select note from public.inventory_movements where id = v_m);
  end if;
  select l.* into v_lot from public.lots l
  join public.movement_lots ml on ml.lot_id = l.id
  where ml.movement_id = v_m;
  if v_lot.origin <> 'adjustment' or v_lot.unit_cost <> 40
     or v_lot.supplier_id is distinct from (select supplier_id from public.products where id = v_p) then
    raise exception 'FALLA 2c: el lote del ajuste no usa el último costo/proveedor: % % %', v_lot.origin, v_lot.unit_cost, v_lot.supplier_id;
  end if;
  if (select cost from public.products where id = v_p) <> 40 then
    raise exception 'FALLA 2d: el ajuste cambió el costo del producto';
  end if;
end $$;

-- Deshacer un ajuste con motivo funciona igual que un escaneo.
set role authenticated;
do $$
begin
  perform public.undo_movement(current_setting('prueba.movimiento')::uuid);
  if (select quantity from public.products where barcode = 'CONT1') <> 5 then
    raise exception 'FALLA 2e: deshacer el ajuste no regresó la cantidad';
  end if;
end $$;

-- ---------- 3. El mostrador no puede cerrar el inventario inicial ----------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e2"}', false);
update public.app_settings set initial_load_open = false where id;
reset role;
do $$
begin
  if not (select initial_load_open from public.app_settings) then
    raise exception 'FALLA 3: el mostrador cerró el inventario inicial';
  end if;
end $$;

-- ---------- 4. El admin lo cierra ----------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1"}', false);
set role authenticated;
update public.app_settings set initial_load_open = false where id;

do $$
declare
  r      jsonb;
  v_p    uuid := (select id from public.products where barcode = 'CONT1');
  v_lots jsonb;
begin
  if (select initial_load_open from public.app_settings) then
    raise exception 'FALLA 4a: el admin no pudo cerrar el inventario inicial';
  end if;

  -- Sin motivo ya no se escanea (ni sumar ni fijar).
  begin
    perform public.register_scan('CONT1', 'add', 1);
    raise exception 'FALLA 4b: escaneó sin motivo con el inventario inicial cerrado';
  exception when others then
    if sqlerrm not like 'El inventario inicial ya se cerró%' then raise; end if;
  end;
  begin
    perform public.register_scan('CONT1', 'set', 1);
    raise exception 'FALLA 4c: fijó total sin motivo con el inventario inicial cerrado';
  exception when others then
    if sqlerrm not like 'El inventario inicial ya se cerró%' then raise; end if;
  end;

  -- Alta con cantidad inicial: no. Sin cantidad: sí.
  begin
    perform public.create_product('CONT2', 'Sobre', 30, 10, null, null, 2);
    raise exception 'FALLA 4d: alta con cantidad inicial con el inventario inicial cerrado';
  exception when others then
    if sqlerrm not like 'El inventario inicial ya se cerró%' then raise; end if;
  end;
  if exists (select 1 from public.products where barcode = 'CONT2') then
    raise exception 'FALLA 4e: quedó el producto del alta rechazada';
  end if;
  r := public.create_product('CONT2', 'Sobre', 30, 10, null, null, 0);
  if r ->> 'status' <> 'ok' then
    raise exception 'FALLA 4f: alta sin cantidad: %', r;
  end if;

  -- Con motivo, fijar total hacia abajo sale del lote elegido.
  select jsonb_agg(jsonb_build_object('lot_id', lot_id, 'quantity', 2)) into v_lots
  from (select lot_id from public.product_lots where product_id = v_p and location = 'store' and quantity >= 2 order by number limit 1) x;
  r := public.register_scan('CONT1', 'set', 3, null, null, 'store', null, null, null, v_lots, 'Merma');
  if r ->> 'movement_type' <> 'adjustment' or (r ->> 'delta')::int <> -2 then
    raise exception 'FALLA 4g: fijar con motivo: %', r;
  end if;

  -- La compra sigue funcionando.
  r := public.register_purchase('70000000-0000-0000-0000-000000000001', (select id from public.suppliers where name = 'Proveedor A'),
    jsonb_build_array(jsonb_build_object('product_id', (select id from public.products where barcode = 'CONT2'), 'quantity', 6, 'unit_cost', 12)));
  if r ->> 'status' <> 'ok' or (select quantity from public.products where barcode = 'CONT2') <> 6 then
    raise exception 'FALLA 4h: compra con el inventario inicial cerrado: %', r;
  end if;
end $$;

-- ---------- 5. Se vuelve a abrir ----------
update public.app_settings set initial_load_open = true where id;
do $$
begin
  perform public.register_scan('CONT2', 'add', 1);
  if (select quantity from public.products where barcode = 'CONT2') <> 7 then
    raise exception 'FALLA 5: no se pudo escanear al reabrir';
  end if;
end $$;

reset role;
do $$
begin
  if exists (select 1 from public.stock_mismatches) then
    raise exception 'FALLA 6: descuadre de inventario';
  end if;
end $$;

\echo 'OK: inventario inicial / conteo y ajustes'
