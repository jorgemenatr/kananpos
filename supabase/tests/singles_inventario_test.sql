-- =====================================================================
-- Pruebas de singles en la tienda: reglas de precio, juegos activos,
-- búsqueda filtrada, alta de singles con lotes, referencia y aplicar
-- precios (20261108000100 y 20261108000200). Base LOCAL, nunca la real.
-- =====================================================================
\set ON_ERROR_STOP 1
\set QUIET 1

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'admin@prueba.mx'),
  ('00000000-0000-0000-0000-0000000000f2', 'mostrador@prueba.mx');
update public.profiles set role = 'admin', full_name = 'Ana Admin' where id = '00000000-0000-0000-0000-0000000000f1';
update public.profiles set role = 'mostrador' where id = '00000000-0000-0000-0000-0000000000f2';
insert into public.suppliers (name) values ('Proveedor Singles');
insert into public.product_categories (name, catalog_sources) values ('Singles Pokémon', array['pokemon']);

-- Catálogo copiado por el job (service_role).
set role service_role;
insert into public.tcg_games (id, slug, name, display_name, sort_order, catalog_status, prices_as_of) values
  (1, 'pokemon', 'Pokemon', 'Pokémon', 1, 'ready', '2026-11-06T20:05:28Z'),
  (2, 'magic', 'Magic', 'Magic: The Gathering', 2, 'ready', '2026-11-06T20:05:28Z'),
  (3, 'lorcana', 'Lorcana TCG', 'Disney Lorcana', 3, 'empty', null);
insert into public.tcg_sets (id, game_id, external_id, name, abbreviation, release_date) values
  (10, 1, 23237, 'SV: Scarlet & Violet 151', 'MEW', '2023-09-22'),
  (20, 2, 3000, 'Bloomburrow', 'BLB', '2024-08-02');
insert into public.tcg_products (id, game_id, set_id, tcgplayer_product_id, name, number, rarity, image_url) values
  (100, 1, 10, 1002, 'Charizard ex', '199/165', 'Special Illustration Rare', 'https://tcgplayer-cdn.tcgplayer.com/product/1002_200w.jpg'),
  (101, 1, 10, 1003, 'Pokémon Center Lady', '200/165', 'Ultra Rare', null),
  (200, 2, 20, 2001, 'Charizard Tribute', '7', 'R', null);
insert into public.tcg_prices (product_id, subtype, market_usd, mid_usd, fetched_at) values
  (100, 'Holofoil', 9.25, 10, '2026-11-06T20:05:28Z'),
  (100, 'Normal', null, 4, '2026-11-06T20:05:28Z'),
  (200, 'Foil', 3, 3, '2026-11-06T20:05:28Z');
insert into public.store_tcg_settings (game_id, enabled) values (1, true);
reset role;

-- ---------- 1. Reglas de precio y tipo de cambio ----------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2"}', false);
set role authenticated;
do $$
begin
  if (select usd_mxn_rate from public.store_pricing_rules) is not null then
    raise exception 'FALLA 1a: el tipo de cambio empieza configurado';
  end if;
  if (select condition_percentages from public.store_pricing_rules) <> '{"NM": 100, "LP": 85, "MP": 70, "HP": 50, "DMG": 30}' then
    raise exception 'FALLA 1b: porcentajes por defecto';
  end if;
  update public.store_pricing_rules set usd_mxn_rate = 25 where id;
  if (select usd_mxn_rate from public.store_pricing_rules) is not null then
    raise exception 'FALLA 1c: el mostrador cambió el tipo de cambio';
  end if;
  if exists (select 1 from public.fx_rate_history) then raise exception 'FALLA 1d: el mostrador ve el historial'; end if;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1"}', false);
set role authenticated;
do $$
begin
  update public.store_pricing_rules set usd_mxn_rate = 20 where id;
  update public.store_pricing_rules set multiplier = 1.1, rounding = '5' where id;  -- sin cambio de tipo de cambio
  update public.store_pricing_rules set usd_mxn_rate = 19.5 where id;
  if (select count(*) from public.fx_rate_history) <> 2 then raise exception 'FALLA 1e: historial'; end if;
  if not exists (select 1 from public.fx_rate_history where old_rate is null and new_rate = 20 and changed_by_name = 'Ana Admin')
     or not exists (select 1 from public.fx_rate_history where old_rate = 20 and new_rate = 19.5) then
    raise exception 'FALLA 1f: valores del historial';
  end if;
  if (select rate_updated_by from public.store_pricing_rules) <> '00000000-0000-0000-0000-0000000000f1'
     or (select rate_updated_at from public.store_pricing_rules) is null then
    raise exception 'FALLA 1g: quién y cuándo';
  end if;
  begin
    update public.store_pricing_rules set condition_percentages = '{"NM": 100}' where id;
    raise exception 'FALLA 1h: aceptó porcentajes incompletos';
  exception when check_violation then null;
  end;
  begin
    update public.store_pricing_rules set usd_mxn_rate = 0 where id;
    raise exception 'FALLA 1i: aceptó tipo de cambio 0';
  exception when check_violation then null;
  end;
  update public.store_pricing_rules set multiplier = 1, rounding = 'peso' where id;
end $$;

-- ---------- 2. Búsqueda filtrada por juegos activos ----------
do $$
begin
  -- Solo Pokémon activo: "charizard" no trae la de Magic.
  if (select array_agg(id order by id) from public.search_singles('charizard')) <> array[100::bigint] then
    raise exception 'FALLA 2a: trajo cartas de un juego inactivo';
  end if;
  -- Por número, por set y sin acentos.
  if (select id from public.search_singles('199/165') limit 1) <> 100 then raise exception 'FALLA 2b: número'; end if;
  if (select count(*) from public.search_singles('151 mew')) <> 2 then raise exception 'FALLA 2c: set'; end if;
  if (select id from public.search_singles('pokemon center LADY') limit 1) <> 101 then raise exception 'FALLA 2d: acentos'; end if;
  if (select prices from public.search_singles('199/165') limit 1) -> 0 ->> 'subtype' <> 'Normal' then
    raise exception 'FALLA 2e: precios de la carta';
  end if;
  if exists (select 1 from public.search_singles('   ')) then raise exception 'FALLA 2f: búsqueda vacía'; end if;

  -- Activar Magic: ya aparece. Desactivar: desaparece otra vez.
  perform public.set_tcg_game_enabled(2::smallint, true);
  if (select count(*) from public.search_singles('charizard')) <> 2 then raise exception 'FALLA 2g: al activar'; end if;
  if (select count(*) from public.search_singles('charizard', 2::smallint)) <> 1 then raise exception 'FALLA 2h: filtro por juego'; end if;
  perform public.set_tcg_game_enabled(2::smallint, false);
  if (select count(*) from public.search_singles('charizard')) <> 1 then raise exception 'FALLA 2i: al desactivar'; end if;

  -- Activar uno sin copiar: queda pendiente de la carga inicial.
  if (public.set_tcg_game_enabled(3::smallint, true)) ->> 'catalog_status' <> 'pending' then
    raise exception 'FALLA 2j: carga inicial pendiente';
  end if;
  if not (select enabled from public.tcg_game_settings where slug = 'lorcana') then raise exception 'FALLA 2k: vista'; end if;
end $$;
reset role;

-- El mostrador busca (POS) pero no activa juegos ni lee precios directo.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2"}', false);
set role authenticated;
do $$
begin
  if (select count(*) from public.search_singles('charizard')) <> 1 then raise exception 'FALLA 2l: mostrador busca'; end if;
  begin
    perform public.set_tcg_game_enabled(2::smallint, true);
    raise exception 'FALLA 2m: el mostrador activó un juego';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ---------- 3. Alta de singles: variantes, lotes y compras ----------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1"}', false);
set role authenticated;
do $$
declare
  v_sup uuid := (select id from public.suppliers where name = 'Proveedor Singles');
  v_r   jsonb;
  v_id  uuid;
begin
  v_r := public.add_single_stock('a0000000-0000-0000-0000-000000000001', 100, 'Holofoil', 'NM', 'en', 3, 90, v_sup, 'store', 185);
  v_id := (v_r -> 'product' ->> 'id')::uuid;
  if v_r ->> 'status' <> 'ok' or not (v_r ->> 'created')::boolean then raise exception 'FALLA 3a: %', v_r; end if;
  if (select (name, price, quantity, category, is_internal_code, image_url)
      from public.products where id = v_id)
     is distinct from ('Charizard ex (199/165) · MEW · Holofoil · NM'::text, 185::numeric(12,2), 3, 'Singles Pokémon'::text, true,
                       'https://tcgplayer-cdn.tcgplayer.com/product/1002_200w.jpg'::text) then
    raise exception 'FALLA 3b: producto creado %', (select to_jsonb(p) from public.products p where id = v_id);
  end if;
  -- Entró como compra: lote con proveedor y costo.
  if not exists (select 1 from public.lots where product_id = v_id and origin = 'purchase' and unit_cost = 90
                 and supplier_id = v_sup and received_quantity = 3) then
    raise exception 'FALLA 3c: lote';
  end if;

  -- Reintento de la misma operación: no duplica.
  v_r := public.add_single_stock('a0000000-0000-0000-0000-000000000001', 100, 'Holofoil', 'NM', 'en', 3, 90, v_sup, 'store', 185);
  if v_r ->> 'status' <> 'duplicate' or (select quantity from public.products where id = v_id) <> 3 then
    raise exception 'FALLA 3d: reintento %', v_r;
  end if;

  -- Otra compra de la misma variante: suma, otro lote, el precio NO cambia.
  v_r := public.add_single_stock('a0000000-0000-0000-0000-000000000002', 100, 'Holofoil', 'NM', 'en', 2, 120, v_sup, 'warehouse', 999);
  if (v_r ->> 'created')::boolean or (v_r -> 'product' ->> 'id')::uuid <> v_id then raise exception 'FALLA 3e: %', v_r; end if;
  if (select (price, quantity, warehouse_quantity) from public.products where id = v_id) is distinct from (185::numeric(12,2), 3, 2) then
    raise exception 'FALLA 3f: suma de piezas o precio';
  end if;
  if (select count(*) from public.lots where product_id = v_id) <> 2 then raise exception 'FALLA 3g: lotes'; end if;

  -- Otra condición o idioma = otra variante.
  v_r := public.add_single_stock('a0000000-0000-0000-0000-000000000003', 100, 'Holofoil', 'LP', 'en', 1, 60, v_sup, 'store', 150);
  if not (v_r ->> 'created')::boolean then raise exception 'FALLA 3h: variante LP'; end if;
  v_r := public.add_single_stock('a0000000-0000-0000-0000-000000000004', 100, 'Holofoil', 'NM', 'ja', 0, null, null, 'store', 140);
  if not (v_r ->> 'created')::boolean or (select quantity from public.products where id = (v_r -> 'product' ->> 'id')::uuid) <> 0 then
    raise exception 'FALLA 3i: variante sin piezas';
  end if;
  if (select count(*) from public.single_variants(100)) <> 3 then raise exception 'FALLA 3j: variantes'; end if;

  -- Validaciones.
  begin
    perform public.add_single_stock(gen_random_uuid(), 200, 'Foil', 'NM', 'en', 1, 10, v_sup, 'store', 50);
    raise exception 'FALLA 3k: alta de un juego inactivo';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.add_single_stock(gen_random_uuid(), 101, 'Normal', 'NM', 'en', 1, 10, null, 'store', 50);
    raise exception 'FALLA 3l: sin proveedor';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.add_single_stock(gen_random_uuid(), 101, 'Normal', 'XX', 'en', 1, 10, v_sup, 'store', 50);
    raise exception 'FALLA 3m: estado inválido';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.add_single_stock(gen_random_uuid(), 101, 'Normal', 'NM', 'en', 1, 10, v_sup, 'store', null);
    raise exception 'FALLA 3n: variante nueva sin precio';
  exception when invalid_parameter_value then null;
  end;
  if exists (select 1 from public.stock_mismatches) then raise exception 'FALLA 3o: descuadre de stock'; end if;
  if public.tcg_game_stock(1::smallint) <> 6 then raise exception 'FALLA 3p: piezas del juego %', public.tcg_game_stock(1::smallint); end if;
end $$;
reset role;

-- ---------- 4. Referencia de precio y costo FIFO ----------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1"}', false);
set role authenticated;
do $$
declare
  v_id uuid := (select id from public.products where tcg_product_id = 100 and card_condition = 'NM' and language = 'en');
  r    record;
begin
  select * into r from public.singles_reference(array[v_id]);
  if (r.market_usd, r.mid_usd, r.tcg_subtype, r.card_condition, r.fifo_cost, r.game_name)
     is distinct from (9.25::numeric, 10::numeric, 'Holofoil'::text, 'NM'::text, 90::numeric, 'Pokémon'::text) then
    raise exception 'FALLA 4a: %', to_jsonb(r);
  end if;
  -- Todos los singles (Revisar precios): las 3 variantes.
  if (select count(*) from public.singles_reference()) <> 3 then raise exception 'FALLA 4b'; end if;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2"}', false);
set role authenticated;
do $$
declare
  v_id uuid := (select id from public.products where tcg_product_id = 100 and card_condition = 'NM' and language = 'en');
begin
  -- El mostrador ve la referencia (POS) pero no el costo, ni la lista completa.
  if (select fifo_cost from public.singles_reference(array[v_id])) is not null then raise exception 'FALLA 4c: costo al mostrador'; end if;
  if (select market_usd from public.singles_reference(array[v_id])) <> 9.25 then raise exception 'FALLA 4d'; end if;
  begin
    perform public.singles_reference();
    raise exception 'FALLA 4e: el mostrador leyó todos los precios';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.apply_single_prices(jsonb_build_array(jsonb_build_object('product_id', v_id, 'price', 1)));
    raise exception 'FALLA 4f: el mostrador aplicó un precio';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.add_single_stock(gen_random_uuid(), 101, 'Normal', 'NM', 'en', 0, null, null, 'store', 10);
    raise exception 'FALLA 4g: el mostrador dio de alta un single';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ---------- 5. Aplicar precios ----------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1"}', false);
set role authenticated;
do $$
declare
  v_nm uuid := (select id from public.products where tcg_product_id = 100 and card_condition = 'NM' and language = 'en');
  v_lp uuid := (select id from public.products where tcg_product_id = 100 and card_condition = 'LP');
  v_r  jsonb;
begin
  v_r := public.apply_single_prices(jsonb_build_array(
    jsonb_build_object('product_id', v_nm, 'price', 190, 'expected_price', 185),
    jsonb_build_object('product_id', v_lp, 'price', 160, 'expected_price', 999)));  -- ya no vale 999: se salta
  if (v_r ->> 'applied')::int <> 1 or jsonb_array_length(v_r -> 'skipped') <> 1 then raise exception 'FALLA 5a: %', v_r; end if;
  if (select price from public.products where id = v_nm) <> 190 or (select price from public.products where id = v_lp) <> 150 then
    raise exception 'FALLA 5b';
  end if;
  if not exists (select 1 from public.product_price_changes where product_id = v_nm and old_price = 185 and new_price = 190) then
    raise exception 'FALLA 5c: historial de precios';
  end if;

  -- Desactivar un juego con stock NO borra nada.
  if (public.set_tcg_game_enabled(1::smallint, false)) ->> 'stock' <> '6' then raise exception 'FALLA 5d'; end if;
  if (select count(*) from public.products where tcg_product_id is not null) <> 3 then raise exception 'FALLA 5e'; end if;
  if exists (select 1 from public.search_singles('charizard')) then raise exception 'FALLA 5f'; end if;
  perform public.set_tcg_game_enabled(1::smallint, true);
end $$;
reset role;

select 'OK: singles en la tienda';
