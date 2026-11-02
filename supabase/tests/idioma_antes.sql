-- Datos de una base en uso ANTES de 20261102000100_idioma_producto.sql
-- (los carga run.sh entre migraciones). Solo para pruebas locales.
\set ON_ERROR_STOP 1
\set QUIET 1
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'admin@prueba.mx'),
  ('00000000-0000-0000-0000-0000000000d2', 'mostrador@prueba.mx');
update public.profiles set role = 'admin'     where id = '00000000-0000-0000-0000-0000000000d1';
update public.profiles set role = 'mostrador' where id = '00000000-0000-0000-0000-0000000000d2';

insert into public.catalog_products (id, category_id, game, group_id, name, source) values
  (1, 3,  'Pokemon',       10, 'Elite Trainer Box', 'pokemon'),
  (2, 85, 'Pokemon Japan', 11, 'Booster Box',       'pokemon-japan'),
  (3, 31, 'Dragon Shield', 12, 'Japanese Sleeves',  'dragon-shield');

insert into public.products (barcode, name, price, category, catalog_product_id) values
  ('L1', 'Elite Trainer Box',                           1000, 'TCG · Pokémon', 1),
  ('L2', '30th Celebration Mini Tin Display (ESPAÑOL)',  900, 'TCG · Pokémon', null),
  ('L3', 'Mega Latias Ex Box Español',                   550, null,            null),
  ('L4', 'Pokemon Mega Dream EX High-Class Pack Edicion Japonesa', 2300, null, null),
  ('L5', 'Booster Box JP',                              2000, 'TCG · Pokémon', 2),
  ('L6', 'Japanese Size Sleeves',                        150, 'Accesorios',    3),
  ('L7', 'Takis Fuego',                                   30, 'Cafetería',     null),
  ('L8', 'Pokemon TCG S-CHINESE GEM PACK',              2300, null,            null),
  ('L9', 'Playmat Pokemon Center',                      1200, null,            null),
  ('L10', 'Stellar Crown Sleeved Booster Pack ESPAÑOL',  120, 'TCG · Pokémon', null);
