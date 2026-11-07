-- =====================================================================
-- Catálogo CENTRAL de singles (proyecto kananpos-catalogo)
--
-- Este archivo NO se aplica a las tiendas: es el esquema del proyecto de
-- Supabase que guarda el catálogo global (npm run singles -- migrar-central).
--
--   * Se llena una vez al día desde el proveedor de precios (hoy TCGCSV,
--     espejo de TCGplayer) con scripts/singles (job "Sincronizar singles").
--   * Nadie de la app se conecta aquí: anon y authenticated no tienen ningún
--     permiso. Solo el job, con la service_role.
--   * De aquí se copian a cada tienda SOLO los juegos que tiene activos
--     (tablas tcg_* de su propia base).
--
-- Precios siempre en USD. La conversión a pesos la hace cada tienda.
--
-- Escritura por funciones catalog_upsert_* para que el upsert sea idempotente
-- y solo toque (y marque con updated_at) lo que de verdad cambió: así la
-- copia a las tiendas manda solo los cambios.
-- =====================================================================

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------- juegos ----------
create table public.tcg_games (
  id                smallint generated always as identity primary key,
  -- Clave nuestra, estable entre proveedores ("pokemon", "magic", …).
  -- La lista curada está en scripts/singles/juegos.json.
  slug              text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  provider          text not null,
  -- categoryId de TCGplayer (sale de /categories, no se escribe a mano).
  external_id       integer unique,
  name              text not null,              -- nombre en el proveedor
  display_name      text not null,              -- nombre en la app (español)
  is_supported      boolean not null default true,
  sort_order        integer not null default 0,
  -- Fecha del dato del proveedor (last-updated.txt) de la última sincronización completa.
  source_updated_at timestamptz,
  last_synced_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger tcg_games_set_updated_at
  before update on public.tcg_games
  for each row execute function public.set_updated_at();

-- ---------- sets ----------
create table public.tcg_sets (
  id                   integer generated always as identity primary key,
  game_id              smallint not null references public.tcg_games (id) on delete restrict,
  external_id          integer not null unique,   -- groupId de TCGplayer
  name                 text not null,
  abbreviation         text,
  release_date         date,
  -- modifiedOn del grupo en el proveedor. Los productos solo se vuelven a
  -- bajar si cambió (los precios se bajan siempre).
  source_modified_on   timestamptz,
  products_modified_on timestamptz,
  product_count        integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index tcg_sets_game_idx on public.tcg_sets (game_id);

create trigger tcg_sets_set_updated_at
  before update on public.tcg_sets
  for each row execute function public.set_updated_at();

-- ---------- productos (solo singles por ahora) ----------
create table public.tcg_products (
  id                   bigint generated always as identity primary key,
  game_id              smallint not null references public.tcg_games (id) on delete restrict,
  set_id               integer not null references public.tcg_sets (id) on delete restrict,
  -- productId de TCGplayer: sirve para cruzar fuentes.
  tcgplayer_product_id bigint not null unique,
  name                 text not null,
  clean_name           text,
  number               text,
  rarity               text,
  image_url            text,
  url                  text,
  is_single            boolean not null default true,
  extended_data        jsonb not null default '{}'::jsonb,
  source_modified_on   timestamptz,
  created_at           timestamptz not null default now(),
  -- Solo cambia cuando cambia algún dato (ver catalog_upsert_products).
  updated_at           timestamptz not null default now()
);

create index tcg_products_set_idx on public.tcg_products (set_id);
create index tcg_products_game_idx on public.tcg_products (game_id, id);
create index tcg_products_game_updated_idx on public.tcg_products (game_id, updated_at);

-- ---------- último precio por producto + subtipo ----------
create table public.tcg_prices (
  product_id     bigint not null references public.tcg_products (id) on delete cascade,
  game_id        smallint not null references public.tcg_games (id) on delete restrict,
  subtype        text not null,                 -- Normal, Foil, Holofoil, Reverse Holofoil…
  market_usd     numeric(12, 2),
  low_usd        numeric(12, 2),
  mid_usd        numeric(12, 2),
  high_usd       numeric(12, 2),
  direct_low_usd numeric(12, 2),
  source         text not null,
  -- Fecha del dato en el proveedor cuando se vio este valor por primera vez.
  fetched_at     timestamptz not null,
  -- Cuándo cambió el valor en esta base (la copia a tiendas manda solo esto).
  updated_at     timestamptz not null default now(),
  primary key (product_id, subtype)
);

create index tcg_prices_game_key_idx on public.tcg_prices (game_id, product_id, subtype);
create index tcg_prices_game_updated_idx on public.tcg_prices (game_id, updated_at);

-- ---------- historial de precios (solo cambios) ----------
-- Una fila cada vez que cambia market/mid de un producto + subtipo. Equivale
-- a un snapshot diario (el precio de un día es la última fila hasta ese día)
-- pero ocupa mucho menos: la mayoría de las cartas no cambian de un día a otro.
create table public.tcg_price_history (
  product_id bigint not null references public.tcg_products (id) on delete cascade,
  subtype    text not null,
  price_date date not null,
  market_usd numeric(12, 2),
  mid_usd    numeric(12, 2),
  primary key (product_id, subtype, price_date)
);

-- ---------- corridas ----------
create table public.catalog_sync_runs (
  id          bigint generated always as identity primary key,
  game_id     smallint references public.tcg_games (id) on delete set null,
  -- download: proveedor → central. copy: central → una tienda (target = ref del proyecto).
  kind        text not null check (kind in ('download', 'copy')),
  target      text,
  provider    text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running'
              check (status in ('running', 'ok', 'partial', 'error', 'skipped')),
  counts      jsonb not null default '{}'::jsonb,
  -- Errores por set: [{ "set": "SV 151", "external_id": 123, "error": "…" }]
  errors      jsonb not null default '[]'::jsonb,
  error       text
);

create index catalog_sync_runs_game_idx on public.catalog_sync_runs (game_id, started_at desc);

-- =====================================================================
-- Upserts idempotentes (los llama el job con la service_role)
-- =====================================================================

-- Juegos de la lista curada. Los que ya no vienen quedan is_supported = false
-- (no se borran: las tiendas pueden tener inventario de ellos).
create function public.catalog_upsert_games(p_rows jsonb)
returns setof public.tcg_games
language plpgsql
set search_path = ''
as $$
begin
  insert into public.tcg_games (slug, provider, external_id, name, display_name, is_supported, sort_order)
  select r.slug, r.provider, r.external_id, r.name, r.display_name, true, coalesce(r.sort_order, 0)
  from jsonb_to_recordset(p_rows) as r(
    slug text, provider text, external_id integer, name text, display_name text, sort_order integer)
  on conflict (slug) do update
    set provider = excluded.provider,
        external_id = excluded.external_id,
        name = excluded.name,
        display_name = excluded.display_name,
        is_supported = true,
        sort_order = excluded.sort_order
    where (tcg_games.provider, tcg_games.external_id, tcg_games.name, tcg_games.display_name,
           tcg_games.is_supported, tcg_games.sort_order)
          is distinct from
          (excluded.provider, excluded.external_id, excluded.name, excluded.display_name,
           true, excluded.sort_order);

  update public.tcg_games g
  set is_supported = false
  where g.is_supported
    and not exists (select 1 from jsonb_array_elements(p_rows) e where e ->> 'slug' = g.slug);

  return query select * from public.tcg_games order by sort_order, id;
end;
$$;

-- Sets de un juego. Devuelve todos los sets del juego con lo necesario para
-- decidir si hay que volver a bajar sus productos.
create function public.catalog_upsert_sets(p_game_id smallint, p_rows jsonb)
returns table (id integer, external_id integer, name text, source_modified_on timestamptz,
               products_modified_on timestamptz, product_count integer)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
begin
  insert into public.tcg_sets (game_id, external_id, name, abbreviation, release_date, source_modified_on)
  select distinct on (r.external_id)
         p_game_id, r.external_id, r.name, nullif(r.abbreviation, ''), r.release_date, r.source_modified_on
  from jsonb_to_recordset(p_rows) as r(
    external_id integer, name text, abbreviation text, release_date date, source_modified_on timestamptz)
  order by r.external_id
  on conflict (external_id) do update
    set game_id = excluded.game_id,
        name = excluded.name,
        abbreviation = excluded.abbreviation,
        release_date = excluded.release_date,
        source_modified_on = excluded.source_modified_on
    where (tcg_sets.game_id, tcg_sets.name, tcg_sets.abbreviation, tcg_sets.release_date, tcg_sets.source_modified_on)
          is distinct from
          (excluded.game_id, excluded.name, excluded.abbreviation, excluded.release_date, excluded.source_modified_on);

  return query
    select s.id, s.external_id, s.name, s.source_modified_on, s.products_modified_on, s.product_count
    from public.tcg_sets s
    where s.game_id = p_game_id
    order by s.release_date desc nulls last, s.id;
end;
$$;

-- Productos (singles) de un set. p_modified_on: modifiedOn del set con el que
-- se bajaron (la siguiente corrida no los vuelve a bajar si no cambia).
create function public.catalog_upsert_products(p_set_id integer, p_rows jsonb, p_modified_on timestamptz default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_game     smallint;
  v_total    integer;
  v_inserted integer;
  v_updated  integer;
begin
  select s.game_id into v_game from public.tcg_sets s where s.id = p_set_id;
  if not found then
    raise exception 'No existe el set %', p_set_id using errcode = '22023';
  end if;

  with src as (
    select distinct on (r.tcgplayer_product_id) r.*
    from jsonb_to_recordset(p_rows) as r(
      tcgplayer_product_id bigint, name text, clean_name text, number text, rarity text,
      image_url text, url text, is_single boolean, extended_data jsonb, source_modified_on timestamptz)
    where r.tcgplayer_product_id is not null and r.name is not null
    order by r.tcgplayer_product_id
  ), up as (
    insert into public.tcg_products (
      game_id, set_id, tcgplayer_product_id, name, clean_name, number, rarity, image_url, url,
      is_single, extended_data, source_modified_on)
    select v_game, p_set_id, s.tcgplayer_product_id, s.name, s.clean_name, s.number, s.rarity, s.image_url, s.url,
           coalesce(s.is_single, true), coalesce(s.extended_data, '{}'::jsonb), s.source_modified_on
    from src s
    on conflict (tcgplayer_product_id) do update
      set game_id = excluded.game_id,
          set_id = excluded.set_id,
          name = excluded.name,
          clean_name = excluded.clean_name,
          number = excluded.number,
          rarity = excluded.rarity,
          image_url = excluded.image_url,
          url = excluded.url,
          is_single = excluded.is_single,
          extended_data = excluded.extended_data,
          source_modified_on = excluded.source_modified_on,
          updated_at = now()
      where (tcg_products.game_id, tcg_products.set_id, tcg_products.name, tcg_products.clean_name,
             tcg_products.number, tcg_products.rarity, tcg_products.image_url, tcg_products.url,
             tcg_products.is_single, tcg_products.extended_data)
            is distinct from
            (excluded.game_id, excluded.set_id, excluded.name, excluded.clean_name,
             excluded.number, excluded.rarity, excluded.image_url, excluded.url,
             excluded.is_single, excluded.extended_data)
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
  into v_inserted, v_updated
  from up;

  select count(*) into v_total
  from (select distinct (e ->> 'tcgplayer_product_id') from jsonb_array_elements(p_rows) e) d;

  update public.tcg_sets s
  set product_count = (select count(*) from public.tcg_products p where p.set_id = p_set_id),
      products_modified_on = coalesce(p_modified_on, s.products_modified_on)
  where s.id = p_set_id;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated,
                            'unchanged', v_total - v_inserted - v_updated);
end;
$$;

-- Precios de un set. Los que no son de un producto del catálogo (sellado,
-- Code Cards) se ignoran. Solo se escribe lo que cambió, y cada cambio de
-- market/mid queda en tcg_price_history.
create function public.catalog_upsert_prices(p_set_id integer, p_rows jsonb, p_source text, p_fetched_at timestamptz)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_total    integer;
  v_matched  integer;
  v_inserted integer;
  v_updated  integer;
begin
  if p_source is null or p_fetched_at is null then
    raise exception 'Faltan la fuente o la fecha del dato' using errcode = '22023';
  end if;

  -- Pares (producto, subtipo) distintos que mandó el proveedor.
  select count(*) into v_total
  from (select distinct e ->> 'tcgplayer_product_id', e ->> 'subtype'
        from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e) d;

  with src as (
    select distinct on (p.id, r.subtype)
           p.id as product_id, p.game_id, r.subtype,
           r.market_usd, r.low_usd, r.mid_usd, r.high_usd, r.direct_low_usd
    from jsonb_to_recordset(p_rows) as r(
      tcgplayer_product_id bigint, subtype text, market_usd numeric, low_usd numeric,
      mid_usd numeric, high_usd numeric, direct_low_usd numeric)
    join public.tcg_products p on p.tcgplayer_product_id = r.tcgplayer_product_id and p.set_id = p_set_id
    where r.subtype is not null and btrim(r.subtype) <> ''
    order by p.id, r.subtype
  ), up as (
    insert into public.tcg_prices (
      product_id, game_id, subtype, market_usd, low_usd, mid_usd, high_usd, direct_low_usd, source, fetched_at)
    select t.product_id, t.game_id, t.subtype, t.market_usd, t.low_usd, t.mid_usd, t.high_usd, t.direct_low_usd,
           p_source, p_fetched_at
    from src t
    on conflict (product_id, subtype) do update
      set market_usd = excluded.market_usd,
          low_usd = excluded.low_usd,
          mid_usd = excluded.mid_usd,
          high_usd = excluded.high_usd,
          direct_low_usd = excluded.direct_low_usd,
          source = excluded.source,
          fetched_at = excluded.fetched_at,
          updated_at = now()
      where (tcg_prices.market_usd, tcg_prices.low_usd, tcg_prices.mid_usd, tcg_prices.high_usd,
             tcg_prices.direct_low_usd, tcg_prices.source)
            is distinct from
            (excluded.market_usd, excluded.low_usd, excluded.mid_usd, excluded.high_usd,
             excluded.direct_low_usd, excluded.source)
    returning product_id, subtype, market_usd, mid_usd, (xmax = 0) as inserted
  ), hist as (
    insert into public.tcg_price_history (product_id, subtype, price_date, market_usd, mid_usd)
    select u.product_id, u.subtype, (p_fetched_at at time zone 'UTC')::date, u.market_usd, u.mid_usd
    from up u
    where u.market_usd is not null or u.mid_usd is not null
    on conflict (product_id, subtype, price_date) do update
      set market_usd = excluded.market_usd, mid_usd = excluded.mid_usd
    returning 1
  )
  select (select count(*) from src), count(*) filter (where inserted), count(*) filter (where not inserted)
  into v_matched, v_inserted, v_updated
  from up;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated,
                            'unchanged', v_matched - v_inserted - v_updated,
                            'ignored', v_total - v_matched);
end;
$$;

-- =====================================================================
-- Lectura para copiar a las tiendas (por páginas, solo lo que cambió)
-- =====================================================================
create function public.catalog_export_products(p_game_id smallint, p_since timestamptz, p_after_id bigint, p_limit integer)
returns table (id bigint, game_id smallint, set_id integer, tcgplayer_product_id bigint, name text,
               clean_name text, number text, rarity text, image_url text, updated_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select p.id, p.game_id, p.set_id, p.tcgplayer_product_id, p.name, p.clean_name, p.number, p.rarity,
         p.image_url, p.updated_at
  from public.tcg_products p
  where p.game_id = p_game_id
    and p.is_single
    and (p_since is null or p.updated_at >= p_since)
    and p.id > coalesce(p_after_id, 0)
  order by p.id
  limit least(greatest(coalesce(p_limit, 1000), 1), 5000);
$$;

create function public.catalog_export_prices(
  p_game_id smallint, p_since timestamptz, p_after_product_id bigint, p_after_subtype text, p_limit integer)
returns table (product_id bigint, subtype text, market_usd numeric, low_usd numeric, mid_usd numeric,
               high_usd numeric, fetched_at timestamptz, updated_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select t.product_id, t.subtype, t.market_usd, t.low_usd, t.mid_usd, t.high_usd, t.fetched_at, t.updated_at
  from public.tcg_prices t
  where t.game_id = p_game_id
    and (p_since is null or t.updated_at >= p_since)
    and (t.product_id, t.subtype) > (coalesce(p_after_product_id, 0), coalesce(p_after_subtype, ''))
  order by t.product_id, t.subtype
  limit least(greatest(coalesce(p_limit, 1000), 1), 5000);
$$;

-- Cuántas cartas tiene cada juego (para mostrar en las tiendas).
create function public.catalog_game_counts()
returns table (game_id smallint, products bigint)
language sql
stable
set search_path = ''
as $$
  select p.game_id, count(*) from public.tcg_products p where p.is_single group by p.game_id;
$$;

-- =====================================================================
-- Permisos: solo la service_role (el job). La app nunca entra aquí.
-- =====================================================================
alter table public.tcg_games enable row level security;
alter table public.tcg_sets enable row level security;
alter table public.tcg_products enable row level security;
alter table public.tcg_prices enable row level security;
alter table public.tcg_price_history enable row level security;
alter table public.catalog_sync_runs enable row level security;

revoke all on public.tcg_games, public.tcg_sets, public.tcg_products, public.tcg_prices,
              public.tcg_price_history, public.catalog_sync_runs
  from anon, authenticated;
grant all on public.tcg_games, public.tcg_sets, public.tcg_products, public.tcg_prices,
             public.tcg_price_history, public.catalog_sync_runs
  to service_role;

revoke all on function public.catalog_upsert_games(jsonb) from public, anon, authenticated;
revoke all on function public.catalog_upsert_sets(smallint, jsonb) from public, anon, authenticated;
revoke all on function public.catalog_upsert_products(integer, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.catalog_upsert_prices(integer, jsonb, text, timestamptz) from public, anon, authenticated;
revoke all on function public.catalog_export_products(smallint, timestamptz, bigint, integer) from public, anon, authenticated;
revoke all on function public.catalog_export_prices(smallint, timestamptz, bigint, text, integer) from public, anon, authenticated;
revoke all on function public.catalog_game_counts() from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;

grant execute on function public.catalog_upsert_games(jsonb) to service_role;
grant execute on function public.catalog_upsert_sets(smallint, jsonb) to service_role;
grant execute on function public.catalog_upsert_products(integer, jsonb, timestamptz) to service_role;
grant execute on function public.catalog_upsert_prices(integer, jsonb, text, timestamptz) to service_role;
grant execute on function public.catalog_export_products(smallint, timestamptz, bigint, integer) to service_role;
grant execute on function public.catalog_export_prices(smallint, timestamptz, bigint, text, integer) to service_role;
grant execute on function public.catalog_game_counts() to service_role;
