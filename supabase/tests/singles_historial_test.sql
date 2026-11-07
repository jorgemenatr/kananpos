-- =====================================================================
-- Singles: orden de la búsqueda (lo más nuevo primero) e historial de
-- precios en la tienda (20261109000100_singles_historial.sql).
-- Base LOCAL, nunca la real.
-- =====================================================================
\set ON_ERROR_STOP 1
\set QUIET 1

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@prueba.mx'),
  ('00000000-0000-0000-0000-0000000000a2', 'mostrador@prueba.mx');
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000a1';
update public.profiles set role = 'mostrador' where id = '00000000-0000-0000-0000-0000000000a2';
insert into public.suppliers (name) values ('Proveedor H');

set role service_role;
insert into public.tcg_games (id, slug, name, display_name, catalog_status) values (1, 'pokemon', 'Pokemon', 'Pokémon', 'ready');
insert into public.tcg_sets (id, game_id, external_id, name, abbreviation, release_date) values
  (1, 1, 1, 'Base Set', 'BS', '1999-01-09'),
  (2, 1, 2, 'Obsidian Flames', 'OBF', '2023-08-11'),
  (3, 1, 3, 'Phantasmal Flames', 'PFL', '2025-11-14'),
  (4, 1, 4, 'Sin fecha', null, null);
insert into public.tcg_products (id, game_id, set_id, tcgplayer_product_id, name, number) values
  (10, 1, 1, 10, 'Charizard', '4/102'),
  (20, 1, 2, 20, 'Charizard ex', '125/197'),
  (30, 1, 3, 30, 'Mega Charizard X ex', '013/094'),
  (40, 1, 4, 40, 'Charizard (promo)', 'SWSH050'),
  (50, 1, 1, 50, 'Blastoise', '2/102');
insert into public.tcg_prices (product_id, subtype, market_usd, fetched_at) values (20, 'Holofoil', 30, now());
insert into public.store_tcg_settings (game_id, enabled) values (1, true);
reset role;

-- ---------- 1. Búsqueda: lo más nuevo primero ----------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1"}', false);
set role authenticated;
do $$
begin
  if (select array_agg(id) from public.search_singles('charizard')) <> array[30, 20, 10, 40]::bigint[] then
    raise exception 'FALLA 1a: orden %', (select array_agg(id) from public.search_singles('charizard'));
  end if;
  -- El número exacto sigue arriba aunque sea viejo.
  if (select id from public.search_singles('4/102') limit 1) <> 10 then raise exception 'FALLA 1b'; end if;
  if (select array_agg(id) from public.search_singles('charizard', null, 2)) <> array[30, 20]::bigint[] then
    raise exception 'FALLA 1c: el límite debe cortar después de ordenar por fecha';
  end if;
end $$;

-- Una variante en inventario.
do $$
begin
  perform public.add_single_stock('b0000000-0000-0000-0000-000000000001', 20, 'Holofoil', 'NM', 'en', 1, 300,
                                  (select id from public.suppliers limit 1), 'store', 650);
end $$;
reset role;

-- ---------- 2. Historial: el job copia, la app lee solo por producto ----------
set role service_role;
do $$
begin
  if (select array_agg(tcg_product_id || ':' || has_history) from public.tcg_history_targets()) <> array['20:false'] then
    raise exception 'FALLA 2a: cartas del inventario %', (select array_agg(tcg_product_id || ':' || has_history) from public.tcg_history_targets());
  end if;
end $$;
insert into public.tcg_price_history (product_id, subtype, price_date, market_usd, mid_usd) values
  (20, 'Holofoil', '2026-11-07', 30, 32),
  (20, 'Holofoil', '2026-11-09', 31.5, 33),
  (20, 'Reverse Holofoil', '2026-11-07', 5, 6)
  on conflict (product_id, subtype, price_date) do update set market_usd = excluded.market_usd;
insert into public.tcg_price_history (product_id, subtype, price_date, market_usd, mid_usd) values
  (20, 'Holofoil', '2026-11-09', 31.5, 33)
  on conflict (product_id, subtype, price_date) do update set market_usd = excluded.market_usd;
do $$
begin
  if (select count(*) from public.tcg_price_history) <> 3 then raise exception 'FALLA 2b: upsert duplicó'; end if;
  if not (select has_history from public.tcg_history_targets() where tcg_product_id = 20) then raise exception 'FALLA 2c'; end if;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2"}', false);
set role authenticated;
do $$
declare v_id uuid := (select id from public.products where tcg_product_id = 20);
begin
  -- Solo el subtipo de la variante, lo más reciente primero.
  if (select array_agg(market_usd) from public.product_price_history(v_id)) <> array[31.5, 30]::numeric[] then
    raise exception 'FALLA 2d: %', (select array_agg(market_usd) from public.product_price_history(v_id));
  end if;
  begin
    perform 1 from public.tcg_price_history;
    raise exception 'FALLA 2e: la app leyó el historial completo';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.tcg_history_targets();
    raise exception 'FALLA 2f: la app llamó tcg_history_targets';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select 'OK: historial y orden de la búsqueda';
