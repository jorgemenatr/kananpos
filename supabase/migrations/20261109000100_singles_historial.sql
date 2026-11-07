-- =====================================================================
-- Singles · Historial de precios y orden de la búsqueda
--
--   tcg_price_history   Copia local del historial de precios (USD) de las
--                       cartas que la tienda tiene en inventario. Una fila
--                       por cada cambio de market/mid (el precio de un día
--                       es la última fila hasta ese día). La llena el job
--                       nocturno desde el catálogo central.
--   tcg_history_targets Cartas del inventario y si ya tienen historial (para
--                       que el job copie el historial completo de las nuevas
--                       y solo lo reciente de las demás). Solo service_role.
--   product_price_history
--                       Historial de UN producto del inventario (su subtipo),
--                       para la vista del producto. Máx. 400 filas.
--   search_singles      Mismo filtro, nuevo orden: primero el número exacto,
--                       luego lo más nuevo (fecha del set) a lo más viejo.
--
-- Compatible con la app publicada: se puede aplicar antes o después.
-- =====================================================================

create table public.tcg_price_history (
  product_id bigint not null references public.tcg_products (id) on delete cascade,
  subtype    text not null,
  price_date date not null,
  market_usd numeric(12, 2),
  mid_usd    numeric(12, 2),
  primary key (product_id, subtype, price_date)
);

alter table public.tcg_price_history enable row level security;
revoke all on public.tcg_price_history from anon, authenticated;
grant all on public.tcg_price_history to service_role;

-- Cartas del inventario (singles) y si ya tienen historial copiado.
create function public.tcg_history_targets()
returns table (tcg_product_id bigint, has_history boolean)
language sql
stable
set search_path = ''
as $$
  select c.id, exists (select 1 from public.tcg_price_history h where h.product_id = c.id)
  from (select distinct p.tcg_product_id as id from public.products p where p.tcg_product_id is not null) c;
$$;

revoke all on function public.tcg_history_targets() from public, anon, authenticated;
grant execute on function public.tcg_history_targets() to service_role;

-- Historial del producto del inventario (la carta y el subtipo de esa variante).
create function public.product_price_history(p_product_id uuid)
returns table (price_date date, market_usd numeric, mid_usd numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select h.price_date, h.market_usd, h.mid_usd
  from public.products p
  join public.tcg_price_history h on h.product_id = p.tcg_product_id and h.subtype = p.tcg_subtype
  where p.id = p_product_id
  order by h.price_date desc
  limit 400;
$$;

revoke all on function public.product_price_history(uuid) from public, anon;
grant execute on function public.product_price_history(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- search_singles: lo más nuevo primero ("charizard" → del set más reciente
-- al más viejo). El número exacto ("199/165") sigue saliendo arriba.
-- ---------------------------------------------------------------------
create or replace function public.search_singles(p_query text, p_game_id smallint default null, p_limit integer default 30)
returns table (
  id            bigint,
  game_id       smallint,
  game_name     text,
  set_id        integer,
  set_name      text,
  set_code      text,
  release_date  date,
  name          text,
  number        text,
  rarity        text,
  image_url     text,
  prices        jsonb,
  prices_as_of  timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_text    text := public.tcg_normalize(p_query);
  v_words   text[] := array_remove(regexp_split_to_array(public.tcg_normalize(p_query), '\s+'), '');
  v_longest text;
  v_limit   integer := least(greatest(coalesce(p_limit, 30), 1), 50);
begin
  if cardinality(v_words) = 0 then
    return;
  end if;
  select w into v_longest from unnest(v_words) w order by length(w) desc limit 1;

  return query
  with hits as (
    select p.id, p.game_id, p.set_id, p.name, p.number, p.rarity, p.image_url,
           (lower(p.number) = v_text) as exact,
           s.release_date as released
    from public.tcg_products p
    join public.store_tcg_settings st on st.game_id = p.game_id and st.enabled
    join public.tcg_sets s on s.id = p.set_id
    where (p_game_id is null or p.game_id = p_game_id)
      -- La palabra más larga con LIKE usa el índice de trigramas; las demás se revisan después.
      and p.search_text like '%' || v_longest || '%'
      and not exists (select 1 from unnest(v_words) w where strpos(p.search_text, w) = 0)
    order by exact desc, released desc nulls last, p.id desc
    limit v_limit
  )
  select
    h.id, h.game_id, g.display_name, h.set_id, s.name, s.abbreviation, s.release_date,
    h.name, h.number, h.rarity, h.image_url,
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'subtype', t.subtype, 'market_usd', t.market_usd, 'mid_usd', t.mid_usd,
               'low_usd', t.low_usd, 'fetched_at', t.fetched_at)
             order by (t.subtype = 'Normal') desc, t.subtype)
      from public.tcg_prices t where t.product_id = h.id), '[]'::jsonb),
    g.prices_as_of
  from hits h
  join public.tcg_games g on g.id = h.game_id
  join public.tcg_sets s on s.id = h.set_id
  order by h.exact desc, h.released desc nulls last, h.id desc;
end;
$$;
