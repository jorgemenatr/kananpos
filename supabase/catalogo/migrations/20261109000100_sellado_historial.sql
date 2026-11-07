-- =====================================================================
-- Catálogo CENTRAL · producto sellado y exportar historial
--
--   catalog_products   Copia central del catálogo de producto sellado y
--                      accesorios (mismas columnas que catalog_products de
--                      cada tienda, sin las generadas). La llena el
--                      importador semanal (scripts/importar-catalogo.mjs
--                      --central) UNA vez para todas las tiendas, solo con
--                      las fuentes que usa alguna; de aquí se copia a cada
--                      tienda solo lo de sus fuentes.
--   catalog_export_history
--                      Historial de precios de una lista de cartas (las que
--                      una tienda tiene en inventario), desde una fecha.
-- =====================================================================

create table public.catalog_products (
  id                 bigint primary key,          -- productId de TCGplayer
  category_id        integer not null,
  game               text not null,
  source             text,                        -- clave de src/lib/catalogSources.json
  group_id           integer not null,
  set_name           text,
  set_code           text,
  name               text not null,
  description        text,
  image_url          text,
  upc                text,
  market_price       numeric(12, 2),              -- USD, solo referencia
  released_on        date,
  tcgplayer_url      text,
  source_modified_on timestamptz,
  imported_at        timestamptz not null default now()
);

create index catalog_products_source_idx on public.catalog_products (source, id);

alter table public.catalog_products enable row level security;
revoke all on public.catalog_products from anon, authenticated;
grant all on public.catalog_products to service_role;

create function public.catalog_export_history(p_product_ids bigint[], p_since date default null)
returns table (product_id bigint, subtype text, price_date date, market_usd numeric, mid_usd numeric)
language sql
stable
set search_path = ''
as $$
  select h.product_id, h.subtype, h.price_date, h.market_usd, h.mid_usd
  from public.tcg_price_history h
  where h.product_id = any (p_product_ids)
    and (p_since is null or h.price_date >= p_since)
  order by h.product_id, h.subtype, h.price_date;
$$;

revoke all on function public.catalog_export_history(bigint[], date) from public, anon, authenticated;
grant execute on function public.catalog_export_history(bigint[], date) to service_role;
