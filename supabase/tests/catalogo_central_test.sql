-- =====================================================================
-- Pruebas del catálogo CENTRAL de singles (supabase/catalogo/migrations).
-- Se corren en una base LOCAL recién creada con supabase/tests/run.sh,
-- nunca contra la base real.
-- =====================================================================
\set ON_ERROR_STOP 1
\set QUIET 1

set role service_role;

do $$
declare
  v_game   smallint;
  v_set    integer;
  v_r      jsonb;
  v_upd    timestamptz;
  v_rows   jsonb := '[
    {"tcgplayer_product_id": 1001, "name": "Victini", "number": "013/128", "rarity": "Common",
     "is_single": true, "extended_data": {"Number": "013/128", "Rarity": "Common"}},
    {"tcgplayer_product_id": 1002, "name": "Charizard ex", "number": "199/165", "rarity": "SIR",
     "is_single": true, "extended_data": {"Number": "199/165"}}
  ]';
  v_prices jsonb := '[
    {"tcgplayer_product_id": 1001, "subtype": "Normal", "market_usd": 0.25, "mid_usd": 0.30},
    {"tcgplayer_product_id": 1001, "subtype": "Reverse Holofoil", "market_usd": 1.10},
    {"tcgplayer_product_id": 1002, "subtype": "Holofoil", "market_usd": 9.25, "mid_usd": 10},
    {"tcgplayer_product_id": 9999, "subtype": "Normal", "market_usd": 120}
  ]';
begin
  -- ---------- 1. Juegos ----------
  perform public.catalog_upsert_games('[
    {"slug": "pokemon", "provider": "tcgcsv", "external_id": 3, "name": "Pokemon", "display_name": "Pokémon", "sort_order": 1},
    {"slug": "magic", "provider": "tcgcsv", "external_id": 1, "name": "Magic", "display_name": "Magic: The Gathering", "sort_order": 2}
  ]');
  perform public.catalog_upsert_games('[
    {"slug": "pokemon", "provider": "tcgcsv", "external_id": 3, "name": "Pokemon", "display_name": "Pokémon", "sort_order": 1}
  ]');
  if (select count(*) from public.tcg_games) <> 2 then raise exception 'FALLA 1a: juegos duplicados'; end if;
  if (select is_supported from public.tcg_games where slug = 'magic') then
    raise exception 'FALLA 1b: un juego que salió de la lista sigue soportado';
  end if;
  select id into v_game from public.tcg_games where slug = 'pokemon';

  -- ---------- 2. Sets ----------
  perform public.catalog_upsert_sets(v_game, '[{"external_id": 23237, "name": "SV 151", "abbreviation": "MEW",
    "release_date": "2023-09-22", "source_modified_on": "2025-12-12T22:37:34Z"}]');
  perform public.catalog_upsert_sets(v_game, '[{"external_id": 23237, "name": "SV 151", "abbreviation": "MEW",
    "release_date": "2023-09-22", "source_modified_on": "2025-12-12T22:37:34Z"}]');
  if (select count(*) from public.tcg_sets) <> 1 then raise exception 'FALLA 2: sets duplicados'; end if;
  select id into v_set from public.tcg_sets where external_id = 23237;

  -- ---------- 3. Productos: idempotente ----------
  v_r := public.catalog_upsert_products(v_set, v_rows, '2025-12-12T22:37:34Z');
  if v_r <> '{"inserted": 2, "updated": 0, "unchanged": 0}' then raise exception 'FALLA 3a: %', v_r; end if;
  select updated_at into v_upd from public.tcg_products where tcgplayer_product_id = 1001;

  v_r := public.catalog_upsert_products(v_set, v_rows, '2025-12-12T22:37:34Z');
  if v_r <> '{"inserted": 0, "updated": 0, "unchanged": 2}' then raise exception 'FALLA 3b: %', v_r; end if;
  if (select count(*) from public.tcg_products) <> 2 then raise exception 'FALLA 3c: productos duplicados'; end if;
  if (select product_count from public.tcg_sets where id = v_set) <> 2
     or (select products_modified_on from public.tcg_sets where id = v_set) <> '2025-12-12T22:37:34Z' then
    raise exception 'FALLA 3d: el set no registró la descarga';
  end if;

  -- Duplicado dentro del mismo envío: no truena ("cannot affect row a second time").
  v_r := public.catalog_upsert_products(v_set, v_rows || v_rows);
  if (v_r ->> 'inserted')::int <> 0 then raise exception 'FALLA 3e: %', v_r; end if;

  -- Cambia una carta: solo esa se marca.
  v_r := public.catalog_upsert_products(v_set, jsonb_set(v_rows, '{0,rarity}', '"Uncommon"'));
  if v_r <> '{"inserted": 0, "updated": 1, "unchanged": 1}' then raise exception 'FALLA 3f: %', v_r; end if;
end $$;

-- now() es la hora de inicio de la transacción: cada bloque en su propia
-- transacción para ver cambiar updated_at.
do $$
declare
  v_set    integer := (select id from public.tcg_sets where external_id = 23237);
  v_r      jsonb;
  v_prices jsonb := '[
    {"tcgplayer_product_id": 1001, "subtype": "Normal", "market_usd": 0.25, "mid_usd": 0.30},
    {"tcgplayer_product_id": 1001, "subtype": "Reverse Holofoil", "market_usd": 1.10},
    {"tcgplayer_product_id": 1002, "subtype": "Holofoil", "market_usd": 9.25, "mid_usd": 10},
    {"tcgplayer_product_id": 9999, "subtype": "Normal", "market_usd": 120}
  ]';
begin
  -- ---------- 4. Precios: idempotente; lo que no es single se ignora ----------
  v_r := public.catalog_upsert_prices(v_set, v_prices, 'tcgcsv', '2026-11-06T20:05:28Z');
  if v_r <> '{"ignored": 1, "updated": 0, "inserted": 3, "unchanged": 0}' then raise exception 'FALLA 4a: %', v_r; end if;
  v_r := public.catalog_upsert_prices(v_set, v_prices || v_prices, 'tcgcsv', '2026-11-06T20:05:28Z');
  if v_r <> '{"ignored": 1, "updated": 0, "inserted": 0, "unchanged": 3}' then raise exception 'FALLA 4b: %', v_r; end if;
  if (select count(*) from public.tcg_prices) <> 3 then raise exception 'FALLA 4c: precios duplicados'; end if;
  if (select count(*) from public.tcg_price_history) <> 3 then raise exception 'FALLA 4d: historial'; end if;
  if (select game_id from public.tcg_prices limit 1) is distinct from (select id from public.tcg_games where slug = 'pokemon') then
    raise exception 'FALLA 4e: el precio no quedó con su juego';
  end if;
  update public.tcg_prices set updated_at = '2026-01-01' ;
end $$;

do $$
declare
  v_set integer := (select id from public.tcg_sets where external_id = 23237);
  v_r   jsonb;
begin
  -- ---------- 5. Al día siguiente cambia un precio ----------
  v_r := public.catalog_upsert_prices(v_set, '[
    {"tcgplayer_product_id": 1001, "subtype": "Normal", "market_usd": 0.25, "mid_usd": 0.30},
    {"tcgplayer_product_id": 1001, "subtype": "Reverse Holofoil", "market_usd": 1.10},
    {"tcgplayer_product_id": 1002, "subtype": "Holofoil", "market_usd": 11.50, "mid_usd": 10}
  ]', 'tcgcsv', '2026-11-07T20:05:28Z');
  if v_r <> '{"ignored": 0, "updated": 1, "inserted": 0, "unchanged": 2}' then raise exception 'FALLA 5a: %', v_r; end if;
  -- Solo el que cambió tiene updated_at nuevo y fecha del dato nueva.
  if (select count(*) from public.tcg_prices where updated_at > '2026-01-01') <> 1 then
    raise exception 'FALLA 5b: se marcaron precios que no cambiaron';
  end if;
  if (select fetched_at from public.tcg_prices where subtype = 'Holofoil') <> '2026-11-07T20:05:28Z' then
    raise exception 'FALLA 5c: fecha del dato';
  end if;
  -- Historial: una fila nueva (solo el cambio), con la fecha del dato.
  if (select count(*) from public.tcg_price_history) <> 4
     or not exists (select 1 from public.tcg_price_history where price_date = '2026-11-07' and market_usd = 11.50) then
    raise exception 'FALLA 5d: historial de cambios';
  end if;
end $$;

do $$
declare
  v_game smallint := (select id from public.tcg_games where slug = 'pokemon');
  v_n    integer;
begin
  -- ---------- 6. Exportación por páginas y desde una marca ----------
  select count(*) into v_n from public.catalog_export_prices(v_game, '2026-06-01', 0, '', 1000);
  if v_n <> 1 then raise exception 'FALLA 6a: exportó % precios cambiados (esperaba 1)', v_n; end if;
  select count(*) into v_n from public.catalog_export_prices(v_game, null, 0, '', 2);
  if v_n <> 2 then raise exception 'FALLA 6b: límite de página'; end if;
  select count(*) into v_n
  from public.catalog_export_prices(v_game, null,
         (select product_id from public.tcg_products p join public.tcg_prices t on t.product_id = p.id
          where p.tcgplayer_product_id = 1001 limit 1), 'Normal', 1000);
  if v_n <> 2 then raise exception 'FALLA 6c: paginación por (producto, subtipo): %', v_n; end if;
  select count(*) into v_n from public.catalog_export_products(v_game, null, 0, 1);
  if v_n <> 1 then raise exception 'FALLA 6d: página de productos'; end if;
end $$;

reset role;

-- ---------- 7. La app nunca entra al central ----------
set role authenticated;
do $$
begin
  begin
    perform 1 from public.tcg_prices;
    raise exception 'FALLA 7a: authenticated leyó tcg_prices del central';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.catalog_upsert_games('[]');
    raise exception 'FALLA 7b: authenticated llamó un upsert del central';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select 'OK: catálogo central';

-- ---------- 8. Sellado y exportar historial (20261109000100) ----------
set role service_role;
do $$
declare v_ids bigint[] := array(select id from public.tcg_products);
begin
  insert into public.catalog_products (id, category_id, game, source, group_id, name)
  values (1, 3, 'Pokemon', 'pokemon', 1, 'Booster Box') on conflict (id) do update set name = excluded.name;
  insert into public.catalog_products (id, category_id, game, source, group_id, name)
  values (1, 3, 'Pokemon', 'pokemon', 1, 'Booster Box') on conflict (id) do update set name = excluded.name;
  if (select count(*) from public.catalog_products) <> 1 then raise exception 'FALLA 8a'; end if;
  if (select count(*) from public.catalog_export_history(v_ids)) <> 4 then raise exception 'FALLA 8b: %', (select count(*) from public.catalog_export_history(v_ids)); end if;
  if (select count(*) from public.catalog_export_history(v_ids, '2026-11-07')) <> 1 then raise exception 'FALLA 8c'; end if;
end $$;
reset role;
set role authenticated;
do $$ begin
  begin
    perform 1 from public.catalog_products;
    raise exception 'FALLA 8d: la app leyó el central';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
select 'OK: sellado e historial del central';
