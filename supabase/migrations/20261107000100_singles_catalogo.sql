-- =====================================================================
-- Singles · copia local del catálogo (Fase 1)
--
-- El catálogo global de singles vive en el proyecto central
-- (supabase/catalogo). A esta base se copian, una vez al día, SOLO los juegos
-- que la tienda tiene activos (store_tcg_settings). Así el POS y las
-- búsquedas leen siempre de aquí, nunca del proveedor en vivo.
--
--   tcg_games          Todos los juegos soportados (para la lista de
--                      Configuración), con el estado de su copia.
--   tcg_sets           Sets de los juegos copiados.
--   tcg_products       Cartas (singles) de los juegos copiados. El id es el
--                      mismo del catálogo central.
--   tcg_prices         Último precio en USD por carta + subtipo. La app NO lo
--                      lee directo: solo por funciones que devuelven pocas
--                      filas (términos de los proveedores de datos).
--   store_tcg_settings Juegos que maneja la tienda.
--
-- Solo el job (service_role) escribe en tcg_*. La pantalla para activar
-- juegos y las búsquedas llegan en la Fase 2.
--
-- Compatible con la app actual: se puede aplicar antes o después de publicar.
-- =====================================================================

create table public.tcg_games (
  id                     smallint primary key,       -- mismo id que el central
  slug                   text not null unique,
  name                   text not null,              -- nombre en el proveedor
  display_name           text not null,              -- nombre en la app
  is_supported           boolean not null default true,
  sort_order             integer not null default 0,
  -- Cartas copiadas a esta base.
  product_count          integer not null default 0,
  -- empty: nunca se ha copiado; pending: se pidió la carga; downloading: en
  -- curso; ready: listo; error: falló la última copia (ver status_message).
  catalog_status         text not null default 'empty'
                         check (catalog_status in ('empty', 'pending', 'downloading', 'ready', 'error')),
  status_message         text,
  status_at              timestamptz,
  -- Fecha del dato del proveedor de los precios copiados ("actualizado hoy").
  prices_as_of           timestamptz,
  last_synced_at         timestamptz,
  -- Hasta qué cambio del central se copió (la siguiente copia solo trae lo nuevo).
  products_copied_through timestamptz,
  prices_copied_through  timestamptz
);

create table public.tcg_sets (
  id           integer primary key,
  game_id      smallint not null references public.tcg_games (id) on delete restrict,
  external_id  integer not null unique,
  name         text not null,
  abbreviation text,
  release_date date
);

create index tcg_sets_game_idx on public.tcg_sets (game_id);

create table public.tcg_products (
  id                   bigint primary key,
  game_id              smallint not null references public.tcg_games (id) on delete restrict,
  set_id               integer not null references public.tcg_sets (id) on delete restrict,
  tcgplayer_product_id bigint not null unique,
  name                 text not null,
  clean_name           text,
  number               text,
  rarity               text,
  image_url            text
);

create index tcg_products_game_idx on public.tcg_products (game_id);
create index tcg_products_set_idx on public.tcg_products (set_id);

create table public.tcg_prices (
  product_id bigint not null references public.tcg_products (id) on delete cascade,
  subtype    text not null,
  market_usd numeric(12, 2),
  low_usd    numeric(12, 2),
  mid_usd    numeric(12, 2),
  high_usd   numeric(12, 2),
  fetched_at timestamptz not null,
  primary key (product_id, subtype)
);

create table public.store_tcg_settings (
  game_id    smallint primary key references public.tcg_games (id) on delete restrict,
  enabled    boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid() references auth.users (id) on delete set null
);

create trigger store_tcg_settings_set_updated_at
  before update on public.store_tcg_settings
  for each row execute function public.set_updated_at();

-- ---------- permisos ----------
alter table public.tcg_games enable row level security;
alter table public.tcg_sets enable row level security;
alter table public.tcg_products enable row level security;
alter table public.tcg_prices enable row level security;
alter table public.store_tcg_settings enable row level security;

revoke all on public.tcg_games, public.tcg_sets, public.tcg_products, public.tcg_prices,
              public.store_tcg_settings
  from anon, authenticated;
grant all on public.tcg_games, public.tcg_sets, public.tcg_products, public.tcg_prices,
             public.store_tcg_settings
  to service_role;

-- Catálogo (sin precios) y juegos activos: cualquier usuario de la tienda los lee.
grant select on public.tcg_games, public.tcg_sets, public.tcg_products, public.store_tcg_settings
  to authenticated;

create policy "tcg_games: authenticated puede leer"
  on public.tcg_games for select to authenticated using (true);
create policy "tcg_sets: authenticated puede leer"
  on public.tcg_sets for select to authenticated using (true);
create policy "tcg_products: authenticated puede leer"
  on public.tcg_products for select to authenticated using (true);
create policy "store_tcg_settings: authenticated puede leer"
  on public.store_tcg_settings for select to authenticated using (true);

-- tcg_prices: sin permisos para la app. Se expone en la Fase 2/3 solo por
-- funciones con límite (búsqueda, ficha, inventario propio).
