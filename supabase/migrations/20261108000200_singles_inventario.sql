-- =====================================================================
-- Singles · Inventario y precio sugerido (Fase 3)
--
-- Un single en inventario ES un producto (products) más: cada variante
-- carta + subtipo (Normal, Foil…) + estado (NM/LP/MP/HP/DMG) + idioma es una
-- fila de products con código interno y su propio precio de venta. Así
-- funcionan igual que todo lo demás: lotes con proveedor y costo, FIFO,
-- tienda/bodega, compras, traspasos, ajustes, etiquetas y POS. No hay un
-- inventario paralelo.
--
--   products.tcg_product_id / tcg_subtype / card_condition
--                           Variante del catálogo de singles (las tres juntas
--                           o ninguna). language es la de siempre.
--   add_single_stock        Alta de singles: busca o crea la variante y mete
--                           las piezas como una compra (lote con proveedor y
--                           costo). Idempotente por p_op_id.
--   singles_reference       Precio de referencia (USD) de productos del
--                           inventario: una lista de ids (POS, ficha) o todos
--                           los singles (Revisar precios, solo admin). Con el
--                           costo FIFO solo para un admin.
--   apply_single_prices     Aplica precios de venta (uno o varios) que el
--                           admin confirmó. Nunca se llama solo. Queda en
--                           product_price_changes.
--   tcg_game_stock          Piezas de un juego (aviso al desactivarlo).
--
-- El precio sugerido NO se calcula aquí: lo calcula la app con una sola
-- función (src/lib/pricing.ts) a partir de la referencia y las reglas.
--
-- Aplicar ANTES de publicar la app nueva: la app lee estas columnas.
-- =====================================================================

alter table public.products
  add column tcg_product_id bigint references public.tcg_products (id) on delete restrict,
  add column tcg_subtype    text,
  add column card_condition text,
  add constraint products_card_condition_check check (card_condition in ('NM', 'LP', 'MP', 'HP', 'DMG')),
  add constraint products_single_variant_check check (
    (tcg_product_id is null and tcg_subtype is null and card_condition is null)
    or (tcg_product_id is not null and btrim(coalesce(tcg_subtype, '')) <> '' and card_condition is not null
        and language is not null)
  );

-- Una fila por variante.
create unique index products_single_variant_key
  on public.products (tcg_product_id, tcg_subtype, card_condition, language)
  where tcg_product_id is not null;

comment on column public.products.tcg_product_id is 'Single: carta del catálogo (tcg_products.id). null = no es single.';
comment on column public.products.tcg_subtype is 'Single: subtipo de precio (Normal, Foil, Holofoil…).';
comment on column public.products.card_condition is 'Single: estado de la carta (NM, LP, MP, HP, DMG).';

grant select (tcg_product_id, tcg_subtype, card_condition) on public.products to authenticated;

-- El mostrador no edita productos (tampoco la variante del single).
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
      new.is_preorder, new.preorder_deposit_type, new.preorder_deposit_value, new.is_combo, new.language,
      new.tcg_product_id, new.tcg_subtype, new.card_condition)
     is distinct from
     (old.barcode, old.name, old.category, old.supplier, old.supplier_id, old.cost, old.price, old.image_url,
      old.is_internal_code, old.description, old.catalog_product_id, old.track_stock,
      old.is_preorder, old.preorder_deposit_type, old.preorder_deposit_value, old.is_combo, old.language,
      old.tcg_product_id, old.tcg_subtype, old.card_condition) then
    raise exception 'Solo un administrador puede editar productos' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Historial de precios de venta aplicados desde el sugerido
-- ---------------------------------------------------------------------
create table public.product_price_changes (
  id          bigint generated always as identity primary key,
  product_id  uuid not null references public.products (id) on delete cascade,
  old_price   numeric(12, 2) not null,
  new_price   numeric(12, 2) not null,
  source      text not null default 'suggested' check (source in ('suggested')),
  changed_at  timestamptz not null default now(),
  changed_by  uuid default auth.uid() references auth.users (id) on delete set null
);

create index product_price_changes_product_idx on public.product_price_changes (product_id, changed_at desc);

alter table public.product_price_changes enable row level security;
revoke all on public.product_price_changes from anon, authenticated;
grant all on public.product_price_changes to service_role;
grant select on public.product_price_changes to authenticated;
create policy "price_changes: solo admin lee"
  on public.product_price_changes for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------
-- Nombre del producto de una variante: "Charizard ex (199/165) · 151 · Holofoil · NM"
-- ---------------------------------------------------------------------
create function public._single_name(p_tcg_product_id bigint, p_subtype text, p_condition text)
returns text
language sql
stable
set search_path = ''
as $$
  select left(
    p.name
    || coalesce(' (' || nullif(p.number, '') || ')', '')
    || ' · ' || coalesce(nullif(s.abbreviation, ''), s.name)
    || case when p_subtype = 'Normal' then '' else ' · ' || p_subtype end
    || ' · ' || p_condition,
    200)
  from public.tcg_products p
  join public.tcg_sets s on s.id = p.set_id
  where p.id = p_tcg_product_id;
$$;

revoke all on function public._single_name(bigint, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- add_single_stock: alta de singles integrada a productos, lotes y compras.
--   * Busca la variante (carta + subtipo + estado + idioma) o la crea con
--     código interno, la categoría ligada a su juego y p_price como precio
--     de venta (obligatorio solo al crearla; a una existente NO se le
--     cambia el precio).
--   * Si p_quantity > 0, registra una compra de una línea (proveedor y
--     costo) → un lote nuevo en p_location. p_op_id es el id de la compra:
--     reintentar no duplica.
-- status: 'ok' | 'duplicate'
-- ---------------------------------------------------------------------
create function public.add_single_stock(
  p_op_id          uuid,
  p_tcg_product_id bigint,
  p_subtype        text,
  p_condition      text,
  p_language       text,
  p_quantity       integer,
  p_unit_cost      numeric default null,
  p_supplier_id    uuid default null,
  p_location       public.stock_location default 'store',
  p_price          numeric default null,
  p_folio          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card     public.tcg_products;
  v_subtype  text := btrim(coalesce(p_subtype, ''));
  v_product  public.products;
  v_created  boolean := false;
  v_category text;
  v_movement public.inventory_movements;
  v_purchase jsonb;
begin
  perform public._require_admin();

  if p_op_id is null then
    raise exception 'Falta el identificador de la operación' using errcode = '22023';
  end if;
  -- Reintento de una alta que ya entró.
  if exists (select 1 from public.purchases where id = p_op_id) then
    select p.* into v_product
    from public.purchase_items pi join public.products p on p.id = pi.product_id
    where pi.purchase_id = p_op_id limit 1;
    return jsonb_build_object('status', 'duplicate', 'created', false, 'product', public._product_json(v_product.id));
  end if;

  select * into v_card from public.tcg_products where id = p_tcg_product_id;
  if not found then
    raise exception 'Esa carta no está en el catálogo' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.store_tcg_settings where game_id = v_card.game_id and enabled) then
    raise exception 'Ese juego no está activo en la tienda (Configuración → Singles y juegos)' using errcode = '22023';
  end if;
  if v_subtype = '' or length(v_subtype) > 60 then
    raise exception 'Elige el tipo de impresión (Normal, Foil…)' using errcode = '22023';
  end if;
  if p_condition is null or p_condition not in ('NM', 'LP', 'MP', 'HP', 'DMG') then
    raise exception 'Elige el estado de la carta' using errcode = '22023';
  end if;
  if p_language is null or p_language not in ('en', 'es', 'ja', 'zh') then
    raise exception 'Elige el idioma de la carta' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity < 0 then
    raise exception 'Cantidad inválida' using errcode = '22023';
  end if;
  if p_quantity > 0 and p_supplier_id is null then
    raise exception 'Elige el proveedor' using errcode = '22023';
  end if;
  if p_quantity > 0 and (p_unit_cost is null or p_unit_cost < 0) then
    raise exception 'Escribe el costo de compra' using errcode = '22023';
  end if;

  -- ¿Ya existe la variante?
  select * into v_product from public.products
  where tcg_product_id = p_tcg_product_id and tcg_subtype = v_subtype
    and card_condition = p_condition and language = p_language
  for update;

  if not found then
    if p_price is null or p_price < 0 or p_price <> round(p_price, 2) then
      raise exception 'Escribe el precio de venta' using errcode = '22023';
    end if;
    select public.category_value(pc) into v_category
    from public.product_categories pc
    join public.tcg_games g on g.slug = any (pc.catalog_sources)
    where g.id = v_card.game_id
    order by pc.parent_id nulls last
    limit 1;

    insert into public.products (
      barcode, name, price, category, quantity, image_url, is_internal_code, created_by,
      language, tcg_product_id, tcg_subtype, card_condition
    ) values (
      public._new_internal_code(),
      public._single_name(p_tcg_product_id, v_subtype, p_condition),
      p_price, v_category, 0, v_card.image_url, true, auth.uid(),
      p_language, p_tcg_product_id, v_subtype, p_condition
    )
    on conflict (tcg_product_id, tcg_subtype, card_condition, language) where tcg_product_id is not null
    do nothing
    returning * into v_product;

    if v_product.id is null then
      -- Otra alta la creó al mismo tiempo.
      select * into v_product from public.products
      where tcg_product_id = p_tcg_product_id and tcg_subtype = v_subtype
        and card_condition = p_condition and language = p_language;
    else
      v_created := true;
      insert into public.inventory_movements (product_id, type, delta, quantity_after, note, created_by, location)
      values (v_product.id, 'initial_count', 0, 0, 'Alta de single', auth.uid(), coalesce(p_location, 'store'))
      returning * into v_movement;
    end if;
  end if;

  if p_quantity > 0 then
    v_purchase := public.register_purchase(
      p_op_id, p_supplier_id,
      jsonb_build_array(jsonb_build_object('product_id', v_product.id, 'quantity', p_quantity,
                                           'unit_cost', round(p_unit_cost, 2))),
      coalesce(p_location, 'store'), p_folio, 'Alta de singles');
  end if;

  return jsonb_build_object('status', 'ok', 'created', v_created, 'product', public._product_json(v_product.id),
                            'purchase_id', v_purchase -> 'purchase' ->> 'id');
end;
$$;

revoke all on function public.add_single_stock(uuid, bigint, text, text, text, integer, numeric, uuid, public.stock_location, numeric, text)
  from public, anon;
grant execute on function public.add_single_stock(uuid, bigint, text, text, text, integer, numeric, uuid, public.stock_location, numeric, text)
  to authenticated;

-- Variantes que ya hay de una carta (alta de singles).
create function public.single_variants(p_tcg_product_id bigint)
returns table (product_id uuid, barcode text, tcg_subtype text, card_condition text, language text,
               price numeric, quantity integer, warehouse_quantity integer)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.barcode, p.tcg_subtype, p.card_condition, p.language, p.price, p.quantity, p.warehouse_quantity
  from public.products p
  where p.tcg_product_id = p_tcg_product_id
  order by p.tcg_subtype, array_position(array['NM', 'LP', 'MP', 'HP', 'DMG'], p.card_condition), p.language;
$$;

revoke all on function public.single_variants(bigint) from public, anon;
grant execute on function public.single_variants(bigint) to authenticated;

-- ---------------------------------------------------------------------
-- Costo FIFO: el del lote que se vende primero (el más viejo con piezas en
-- tienda; si la tienda no tiene, el más viejo en bodega).
-- ---------------------------------------------------------------------
create function public._fifo_cost(p_product_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select l.unit_cost
  from public.lots l
  join public.lot_stock ls on ls.lot_id = l.id and ls.quantity > 0
  where l.product_id = p_product_id
  order by (ls.location = 'store') desc, l.received_at, l.number
  limit 1;
$$;

revoke all on function public._fifo_cost(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- singles_reference: datos para el precio sugerido de productos del
-- inventario.
--   p_product_ids = lista (máx. 200): cualquier usuario (POS, ficha).
--   p_product_ids = null: todos los singles del inventario, solo admin
--                         (Revisar precios).
-- fifo_cost solo para un admin. Precios de referencia solo de la variante
-- que tiene la tienda (su subtipo), nunca del catálogo completo.
-- ---------------------------------------------------------------------
create function public.singles_reference(p_product_ids uuid[] default null)
returns table (
  product_id         uuid,
  barcode            text,
  name               text,
  price              numeric,
  quantity           integer,
  warehouse_quantity integer,
  language           text,
  image_url          text,
  tcg_product_id     bigint,
  tcg_subtype        text,
  card_condition     text,
  card_name          text,
  card_number        text,
  set_name           text,
  game_id            smallint,
  game_name          text,
  market_usd         numeric,
  mid_usd            numeric,
  price_fetched_at   timestamptz,
  prices_as_of       timestamptz,
  fifo_cost          numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin boolean := auth.uid() is null or public.is_admin();
begin
  if p_product_ids is null and not v_admin then
    raise exception 'Solo un administrador puede revisar todos los precios' using errcode = '42501';
  end if;
  if p_product_ids is not null and cardinality(p_product_ids) > 200 then
    raise exception 'Demasiados productos (máximo 200)' using errcode = '22023';
  end if;

  return query
  select p.id, p.barcode, p.name, p.price, p.quantity, p.warehouse_quantity, p.language, p.image_url,
         p.tcg_product_id, p.tcg_subtype, p.card_condition,
         c.name, c.number, s.name, g.id, g.display_name,
         t.market_usd, t.mid_usd, t.fetched_at, g.prices_as_of,
         case when v_admin then public._fifo_cost(p.id) end
  from public.products p
  join public.tcg_products c on c.id = p.tcg_product_id
  join public.tcg_sets s on s.id = c.set_id
  join public.tcg_games g on g.id = c.game_id
  left join public.tcg_prices t on t.product_id = c.id and t.subtype = p.tcg_subtype
  where p.tcg_product_id is not null
    and (p_product_ids is null or p.id = any (p_product_ids))
  order by g.sort_order, c.name, p.id;
end;
$$;

revoke all on function public.singles_reference(uuid[]) from public, anon;
grant execute on function public.singles_reference(uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- apply_single_prices: [{ "product_id": "…", "price": 185, "expected_price": 150 }]
-- Cambia el precio de venta de singles que el admin confirmó. Si el precio
-- actual ya no es expected_price (otro lo cambió mientras), ese no se toca.
-- Devuelve cuántos se aplicaron y cuáles se saltaron.
-- ---------------------------------------------------------------------
create function public.apply_single_prices(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item    record;
  v_old     numeric(12, 2);
  v_applied integer := 0;
  v_skipped jsonb := '[]'::jsonb;
begin
  perform public._require_admin();
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'No hay precios que aplicar' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'Máximo 1000 precios a la vez' using errcode = '22023';
  end if;

  for v_item in
    select i.product_id, i.price, i.expected_price
    from jsonb_to_recordset(p_items) as i(product_id uuid, price numeric, expected_price numeric)
    order by i.product_id
  loop
    if v_item.price is null or v_item.price < 0 or v_item.price <> round(v_item.price, 2) then
      raise exception 'Precio inválido: %', v_item.price using errcode = '22023';
    end if;
    select price into v_old from public.products
    where id = v_item.product_id and tcg_product_id is not null
    for update;
    if not found then
      v_skipped := v_skipped || jsonb_build_object('product_id', v_item.product_id, 'reason', 'no es un single');
      continue;
    end if;
    if v_item.expected_price is not null and v_old <> v_item.expected_price then
      v_skipped := v_skipped || jsonb_build_object('product_id', v_item.product_id, 'reason', 'el precio cambió');
      continue;
    end if;
    if v_old = v_item.price then
      continue;
    end if;
    update public.products set price = v_item.price where id = v_item.product_id;
    insert into public.product_price_changes (product_id, old_price, new_price, changed_by)
    values (v_item.product_id, v_old, v_item.price, auth.uid());
    v_applied := v_applied + 1;
  end loop;

  return jsonb_build_object('applied', v_applied, 'skipped', v_skipped);
end;
$$;

revoke all on function public.apply_single_prices(jsonb) from public, anon;
grant execute on function public.apply_single_prices(jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Piezas en inventario (tienda + bodega) de un juego.
-- ---------------------------------------------------------------------
create or replace function public.tcg_game_stock(p_game_id smallint)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(p.quantity + p.warehouse_quantity), 0)::integer
  from public.products p
  join public.tcg_products c on c.id = p.tcg_product_id
  where c.game_id = p_game_id;
$$;
