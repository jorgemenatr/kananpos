-- =====================================================================
-- Pruebas del idioma del producto (20261102000100_idioma_producto.sql).
-- Se corren en una base LOCAL con supabase/tests/run.sh, nunca contra la
-- base real. Antes de la migración se cargan los datos de idioma_antes.sql.
-- =====================================================================
\set ON_ERROR_STOP 1
\set QUIET 1

-- ---------- 1. Etiquetado de los productos que ya existían ----------
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('L1', 'en', 'Elite Trainer Box'),
      ('L2', 'es', '30th Celebration Mini Tin Display'),
      ('L3', 'es', 'Mega Latias Ex Box'),
      ('L4', 'ja', 'Pokemon Mega Dream EX High-Class Pack'),
      ('L5', 'ja', 'Booster Box JP'),
      ('L6', null, 'Japanese Size Sleeves'),
      ('L7', null, 'Takis Fuego'),
      ('L8', 'zh', 'Pokemon TCG S-CHINESE GEM PACK'),
      ('L9', null, 'Playmat Pokemon Center'),
      ('L10', 'es', 'Stellar Crown Sleeved Booster Pack')
    ) as t(barcode, language, name)
  loop
    if not exists (select 1 from public.products p
                   where p.barcode = r.barcode and p.language is not distinct from r.language and p.name = r.name) then
      raise exception 'FALLA 1: % quedó como % / %', r.barcode,
        (select language from public.products where barcode = r.barcode),
        (select name from public.products where barcode = r.barcode);
    end if;
  end loop;
end $$;

-- ---------- 2. Alta con idioma; la llamada anterior (sin idioma) sigue igual ----------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1"}', false);
set role authenticated;

do $$
declare
  v jsonb;
begin
  v := public.create_product(p_barcode => 'ES1', p_name => 'Elite Trainer Box', p_price => 1100,
                             p_catalog_product_id => 1, p_language => 'es');
  if v->'product'->>'language' is distinct from 'es' then
    raise exception 'FALLA 2a: el alta no guardó el idioma (%)', v->'product'->>'language';
  end if;

  v := public.create_product(p_barcode => 'SIN1', p_name => 'Café', p_price => 40);
  if v->'product'->>'language' is not null then
    raise exception 'FALLA 2b: el alta sin idioma debía quedar en null';
  end if;

  begin
    perform public.create_product(p_barcode => 'MAL1', p_name => 'Raro', p_price => 1, p_language => 'fr');
    raise exception 'FALLA 2c: aceptó un idioma inválido';
  exception when check_violation then null;
  end;

  -- Dos productos (inglés y español) vinculados a la misma fila del catálogo.
  if (select count(*) from public.products where catalog_product_id = 1) <> 2 then
    raise exception 'FALLA 2d: debían quedar dos productos vinculados al mismo catálogo';
  end if;

  update public.products set language = 'en' where barcode = 'ES1';
end $$;

-- ---------- 3. El mostrador no cambia el idioma ----------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d2"}', false);

do $$
begin
  if (select language from public.products where barcode = 'ES1') is distinct from 'en' then
    raise exception 'FALLA 3a: el mostrador debe poder leer el idioma';
  end if;
  begin
    update public.products set language = 'es' where barcode = 'ES1';
    raise exception 'FALLA 3b: el mostrador cambió el idioma';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
select 'OK: idioma del producto';
