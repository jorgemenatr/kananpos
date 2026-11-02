-- =====================================================================
-- Idioma del producto (inglés / español / japonés / chino)
--
-- En México llega el mismo producto sellado de Pokémon en inglés y en
-- español, con códigos de barras distintos. El catálogo de TCGplayer solo
-- trae la versión en inglés, así que el idioma es un dato del producto de
-- inventario, no del catálogo: dos productos (uno por idioma, cada uno con
-- su código) pueden vincularse a la misma fila de catalog_products.
--
--   * products.language: 'en' | 'es' | 'ja' | 'zh', o null = no aplica
--     (comida, accesorios, torneos…). La app lo muestra como etiqueta de
--     color junto al nombre.
--   * create_product recibe p_language (opcional, al final): la app
--     anterior sigue funcionando igual.
--   * Los productos actuales se etiquetan:
--       - "ESPAÑOL", "Japones"/"Edición Japonesa", "chino" en el nombre →
--         ese idioma (si es Pokémon o no tiene categoría), y la palabra se
--         quita del nombre porque ahora lo dice la etiqueta;
--       - del catálogo "Pokémon (Japón)" → japonés;
--       - el resto de Pokémon (por categoría o catálogo) → inglés.
--
-- Compatible con la app anterior: aplicar ANTES de publicar la app nueva.
-- =====================================================================

alter table public.products
  add column language text constraint products_language_check check (language in ('en', 'es', 'ja', 'zh'));

comment on column public.products.language is
  'Idioma del producto: en, es, ja, zh; null = no aplica. La app lo muestra como etiqueta.';

grant select (language) on public.products to authenticated;
grant insert (language) on public.products to authenticated;
grant update (language) on public.products to authenticated;

-- ---------------------------------------------------------------------
-- Productos actuales
-- ---------------------------------------------------------------------
with info as (
  select p.id, p.name,
    -- Pokémon por categoría ("TCG · Pokémon") o por el catálogo vinculado.
    translate(lower(coalesce(p.category, '')), 'áéíóú', 'aeiou') like '%pokemon%'
      or coalesce(c.game, '') ilike 'pokemon%' as pokemon_ctx,
    -- …o por el nombre, solo para decidir con las palabras de idioma.
    translate(lower(coalesce(p.category, '') || ' ' || p.name), 'áéíóú', 'aeiou') like '%pokemon%'
      or p.category is null as word_ctx,
    c.source
  from public.products p
  left join public.catalog_products c on c.id = p.catalog_product_id
),
lang as (
  select id, name, case
      when word_ctx and name ~* '\mespa(ñ|n)ol\M' then 'es'
      when word_ctx and name ~* '\mjapon(es|esa)?\M' then 'ja'
      when word_ctx and name ~* '\mchin(o|a|ese)\M|s-chinese' then 'zh'
      when source = 'pokemon-japan' then 'ja'
      when pokemon_ctx then 'en'
    end as language
  from info
)
update public.products p
set language = l.language,
    name = case
      when l.language in ('es', 'ja') then coalesce(nullif(btrim(regexp_replace(regexp_replace(regexp_replace(p.name,
               '\s*[\(\[]\s*espa(ñ|n)ol\s*[\)\]]|\s*\mespa(ñ|n)ol\M', '', 'gi'),
               '\s*(edici(o|ó)n\s+)?\mjapon(es|esa)?\M', '', 'gi'),
               '\s{2,}', ' ', 'g')), ''), p.name)
      else p.name
    end
from lang l
where l.id = p.id and l.language is not null;

-- ---------------------------------------------------------------------
-- Solo un admin cambia el idioma (igual que el resto del producto).
-- ---------------------------------------------------------------------
create or replace function public.guard_products()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'Solo un administrador puede dar de alta productos' using errcode = '42501';
  end if;
  -- Mostrador: solo puede cambiar la cantidad (ventas con checkout_ticket).
  if (new.barcode, new.name, new.category, new.supplier, new.supplier_id, new.cost, new.price, new.image_url,
      new.is_internal_code, new.description, new.catalog_product_id, new.track_stock,
      new.is_preorder, new.preorder_deposit_type, new.preorder_deposit_value, new.is_combo, new.language)
     is distinct from
     (old.barcode, old.name, old.category, old.supplier, old.supplier_id, old.cost, old.price, old.image_url,
      old.is_internal_code, old.description, old.catalog_product_id, old.track_stock,
      old.is_preorder, old.preorder_deposit_type, old.preorder_deposit_value, old.is_combo, old.language) then
    raise exception 'Solo un administrador puede editar productos' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- create_product: igual que en 20261020000100_configuracion_negocio.sql,
-- más p_language. Se recrea (no se agrega otra versión) para que PostgREST
-- no tenga dos funciones con el mismo nombre; como p_language tiene valor
-- por omisión, las llamadas de la app anterior siguen funcionando.
-- ---------------------------------------------------------------------
drop function public.create_product(text, text, numeric, numeric, text, text, integer, text, uuid, text, bigint, public.stock_location, uuid);

create function public.create_product(
  p_barcode            text,
  p_name               text,
  p_price              numeric,
  p_cost               numeric default null,
  p_category           text default null,
  p_supplier           text default null,
  p_initial_quantity   integer default 0,
  p_image_url          text default null,
  p_client_op_id       uuid default null,
  p_description        text default null,
  p_catalog_product_id bigint default null,
  p_location           public.stock_location default 'store',
  p_supplier_id        uuid default null,
  p_language           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_barcode  text := nullif(btrim(coalesce(p_barcode, '')), '');
  v_internal boolean := false;
  v_loc      public.stock_location := coalesce(p_location, 'store');
  v_product  public.products;
  v_movement public.inventory_movements;
begin
  perform public._require_admin();

  if p_initial_quantity is null or p_initial_quantity < 0 then
    raise exception 'Cantidad inicial inválida: %', p_initial_quantity using errcode = '22023';
  end if;

  if p_client_op_id is not null then
    select * into v_movement from public.inventory_movements where client_op_id = p_client_op_id;
    if found then
      return public._movement_result('duplicate', v_movement);
    end if;
  end if;

  if v_barcode is null then
    v_barcode  := public._new_internal_code();
    v_internal := true;
  else
    select * into v_product from public.products where barcode = v_barcode;
    if found then
      return jsonb_build_object('status', 'exists', 'product', to_jsonb(v_product));
    end if;
    perform public._check_reserved_barcode(v_barcode);
  end if;

  insert into public.products (
    barcode, name, price, cost, category, supplier_id, quantity, image_url, is_internal_code, created_by,
    description, catalog_product_id, language
  ) values (
    v_barcode,
    btrim(p_name),
    p_price,
    p_cost,
    nullif(btrim(coalesce(p_category, '')), ''),
    public._resolve_supplier(p_supplier_id, p_supplier),
    0,
    p_image_url,
    v_internal,
    auth.uid(),
    nullif(btrim(coalesce(p_description, '')), ''),
    p_catalog_product_id,
    nullif(btrim(coalesce(p_language, '')), '')
  )
  returning * into v_product;

  insert into public.inventory_movements (product_id, type, delta, quantity_after, note, client_op_id, created_by, location)
  values (v_product.id, 'initial_count', p_initial_quantity, p_initial_quantity, 'Alta de producto', p_client_op_id, auth.uid(), v_loc)
  returning * into v_movement;

  if p_initial_quantity > 0 then
    perform public._add_entry(v_product.id, v_loc, p_initial_quantity, null, null, 'product_create', v_movement.id);
  end if;

  return public._movement_result('ok', v_movement);
end;
$$;

revoke all on function public.create_product(text, text, numeric, numeric, text, text, integer, text, uuid, text, bigint, public.stock_location, uuid, text) from public, anon;
grant execute on function public.create_product(text, text, numeric, numeric, text, text, integer, text, uuid, text, bigint, public.stock_location, uuid, text) to authenticated;
