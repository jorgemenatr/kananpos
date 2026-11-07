-- =====================================================================
-- Pruebas de la copia local del catálogo de singles en una tienda
-- (20261107000100_singles_catalogo.sql). Base LOCAL, nunca la real.
-- =====================================================================
\set ON_ERROR_STOP 1
\set QUIET 1

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'admin@prueba.mx'),
  ('00000000-0000-0000-0000-0000000000e2', 'mostrador@prueba.mx');
update public.profiles set role = 'admin'     where id = '00000000-0000-0000-0000-0000000000e1';
update public.profiles set role = 'mostrador' where id = '00000000-0000-0000-0000-0000000000e2';

-- ---------- 1. El job (service_role) copia; repetir no duplica ----------
set role service_role;
insert into public.tcg_games (id, slug, name, display_name) values (1, 'pokemon', 'Pokemon', 'Pokémon'), (2, 'magic', 'Magic', 'Magic')
  on conflict (id) do update set name = excluded.name;
insert into public.tcg_games (id, slug, name, display_name) values (1, 'pokemon', 'Pokemon', 'Pokémon')
  on conflict (id) do update set name = excluded.name;
insert into public.tcg_sets (id, game_id, external_id, name) values (10, 1, 23237, 'SV 151');
insert into public.tcg_products (id, game_id, set_id, tcgplayer_product_id, name, number)
  values (100, 1, 10, 1002, 'Charizard ex', '199/165');
insert into public.tcg_prices (product_id, subtype, market_usd, fetched_at) values (100, 'Holofoil', 9.25, now())
  on conflict (product_id, subtype) do update set market_usd = excluded.market_usd;
insert into public.tcg_prices (product_id, subtype, market_usd, fetched_at) values (100, 'Holofoil', 9.50, now())
  on conflict (product_id, subtype) do update set market_usd = excluded.market_usd;
insert into public.store_tcg_settings (game_id, enabled) values (1, true);
reset role;

do $$ begin
  if (select count(*) from public.tcg_games) <> 2 or (select count(*) from public.tcg_prices) <> 1
     or (select market_usd from public.tcg_prices) <> 9.50 then
    raise exception 'FALLA 1: copia';
  end if;
  if (select catalog_status from public.tcg_games where id = 2) <> 'empty' then
    raise exception 'FALLA 1b: estado inicial';
  end if;
end $$;

-- ---------- 2. La app: lee el catálogo, pero NO los precios ni escribe ----------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1"}', false);
set role authenticated;
do $$
begin
  if (select count(*) from public.tcg_products) <> 1 or (select count(*) from public.tcg_games) <> 2
     or (select count(*) from public.store_tcg_settings where enabled) <> 1 then
    raise exception 'FALLA 2a: el admin no lee el catálogo';
  end if;
  begin
    perform 1 from public.tcg_prices;
    raise exception 'FALLA 2b: la app leyó tcg_prices directo';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.store_tcg_settings (game_id, enabled) values (2, true);
    raise exception 'FALLA 2c: la app escribió store_tcg_settings directo';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.tcg_products set name = 'x';
    raise exception 'FALLA 2d: la app editó el catálogo';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set role anon;
do $$ begin
  begin
    perform 1 from public.tcg_products;
    raise exception 'FALLA 3: anon leyó el catálogo';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select 'OK: copia del catálogo de singles';
