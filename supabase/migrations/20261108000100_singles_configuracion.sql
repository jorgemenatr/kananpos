-- =====================================================================
-- Singles · Configuración por tienda y búsqueda (Fase 2)
--
--   store_pricing_rules   Reglas de precio de la tienda (una fila):
--                         tipo de cambio de VENTA (MXN por 1 USD) que define
--                         la tienda (nunca se consulta una fuente externa),
--                         multiplicador, redondeo, % por estado de la carta,
--                         precio mínimo y % de diferencia para "Revisar
--                         precios". Sin tipo de cambio no hay precio sugerido.
--   store_fx_rate_history Cada cambio del tipo de cambio (anterior, nuevo,
--                         fecha y usuario). Lo llena un trigger.
--   set_tcg_game_enabled  Activa o desactiva un juego. Al activar uno que no
--                         está copiado, queda 'pending' para la carga
--                         inicial. Al desactivar NO se borra nada.
--   search_singles        Búsqueda de cartas (nombre, set o número) solo en
--                         los juegos activos de la tienda, con índice de
--                         trigramas. Devuelve los precios de referencia de
--                         cada resultado (pocas filas, nunca en bloque).
--
-- Aplicar ANTES de publicar la app nueva (la anterior no usa nada de esto).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Reglas de precio
-- ---------------------------------------------------------------------
-- {"NM": 100, "LP": 85, "MP": 70, "HP": 50, "DMG": 30}: los cinco estados, de 0 a 200 %.
create function public._valid_condition_percentages(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'object'
     and p ?& array['NM', 'LP', 'MP', 'HP', 'DMG']
     and (select count(*) from jsonb_object_keys(p)) = 5
     and not exists (
       select 1 from jsonb_each(p) as e(k, v)
       where jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric not between 0 and 200);
$$;

create table public.store_pricing_rules (
  id                    boolean primary key default true check (id),   -- una sola fila
  -- MXN por 1 USD. null = la tienda aún no lo configura (no hay sugeridos).
  usd_mxn_rate          numeric(10, 4) check (usd_mxn_rate is null or usd_mxn_rate > 0 and usd_mxn_rate < 1000),
  multiplier            numeric(6, 3) not null default 1 check (multiplier > 0 and multiplier <= 10),
  -- none: sin redondeo · peso: al peso · 5: a $5 · 10: a $10 (siempre al más cercano)
  rounding              text not null default 'peso' check (rounding in ('none', 'peso', '5', '10')),
  -- % del precio NM por estado de la carta.
  condition_percentages jsonb not null default '{"NM": 100, "LP": 85, "MP": 70, "HP": 50, "DMG": 30}'::jsonb,
  min_price             numeric(12, 2) not null default 5 check (min_price >= 0),
  -- "Revisar precios" muestra los singles cuyo precio difiere del sugerido más de esto.
  review_threshold_pct  numeric(5, 2) not null default 10 check (review_threshold_pct >= 0 and review_threshold_pct <= 1000),
  rate_updated_at       timestamptz,
  rate_updated_by       uuid references auth.users (id) on delete set null,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references auth.users (id) on delete set null,
  constraint store_pricing_rules_conditions check (public._valid_condition_percentages(condition_percentages))
);

insert into public.store_pricing_rules (id) values (true);

create table public.store_fx_rate_history (
  id         bigint generated always as identity primary key,
  old_rate   numeric(10, 4),
  new_rate   numeric(10, 4),
  changed_at timestamptz not null default now(),
  changed_by uuid default auth.uid() references auth.users (id) on delete set null
);

create index store_fx_rate_history_changed_idx on public.store_fx_rate_history (changed_at desc);

create function public.store_pricing_rules_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if new.usd_mxn_rate is distinct from old.usd_mxn_rate then
    new.rate_updated_at := now();
    new.rate_updated_by := auth.uid();
    insert into public.store_fx_rate_history (old_rate, new_rate, changed_by)
    values (old.usd_mxn_rate, new.usd_mxn_rate, auth.uid());
  else
    new.rate_updated_at := old.rate_updated_at;
    new.rate_updated_by := old.rate_updated_by;
  end if;
  return new;
end;
$$;

create trigger store_pricing_rules_audit
  before update on public.store_pricing_rules
  for each row execute function public.store_pricing_rules_audit();

revoke all on function public.store_pricing_rules_audit() from public, anon, authenticated;
revoke all on function public._valid_condition_percentages(jsonb) from public, anon;
-- El CHECK la ejecuta con el usuario que guarda.
grant execute on function public._valid_condition_percentages(jsonb) to authenticated, service_role;

alter table public.store_pricing_rules enable row level security;
alter table public.store_fx_rate_history enable row level security;

revoke all on public.store_pricing_rules, public.store_fx_rate_history from anon, authenticated;
grant all on public.store_pricing_rules, public.store_fx_rate_history to service_role;

-- Todos leen las reglas (el POS calcula el sugerido); solo un admin las cambia.
grant select on public.store_pricing_rules to authenticated;
grant update (usd_mxn_rate, multiplier, rounding, condition_percentages, min_price, review_threshold_pct)
  on public.store_pricing_rules to authenticated;
grant select on public.store_fx_rate_history to authenticated;

create policy "pricing_rules: authenticated puede leer"
  on public.store_pricing_rules for select to authenticated using (true);
create policy "pricing_rules: solo admin cambia"
  on public.store_pricing_rules for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "fx_history: solo admin lee"
  on public.store_fx_rate_history for select to authenticated using (public.is_admin());

-- Historial con el nombre de quién lo cambió.
create view public.fx_rate_history
with (security_invoker = true)
as
select h.id, h.old_rate, h.new_rate, h.changed_at, h.changed_by,
       p.full_name as changed_by_name, p.email as changed_by_email
from public.store_fx_rate_history h
left join public.profiles p on p.id = h.changed_by;

revoke all on public.fx_rate_history from anon, authenticated;
grant select on public.fx_rate_history to authenticated;

-- ---------------------------------------------------------------------
-- Juegos activos
-- ---------------------------------------------------------------------
-- Piezas en inventario de un juego (para avisar antes de desactivarlo). La
-- migración de inventario de singles la reemplaza con el conteo real.
create function public.tcg_game_stock(p_game_id smallint)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select 0;
$$;

create function public.set_tcg_game_enabled(p_game_id smallint, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.tcg_games;
begin
  perform public._require_admin();
  select * into v_game from public.tcg_games where id = p_game_id for update;
  if not found then
    raise exception 'Ese juego no existe' using errcode = 'P0002';
  end if;
  if p_enabled and not v_game.is_supported then
    raise exception 'Ese juego ya no está soportado' using errcode = '22023';
  end if;

  insert into public.store_tcg_settings (game_id, enabled, updated_by)
  values (p_game_id, coalesce(p_enabled, false), auth.uid())
  on conflict (game_id) do update set enabled = excluded.enabled, updated_by = auth.uid();

  -- Activar uno que no está copiado: queda pendiente de la carga inicial.
  if p_enabled and v_game.catalog_status in ('empty', 'error') then
    update public.tcg_games
    set catalog_status = 'pending', status_message = null, status_at = now()
    where id = p_game_id
    returning * into v_game;
  end if;

  return jsonb_build_object(
    'game_id', v_game.id,
    'slug', v_game.slug,
    'enabled', coalesce(p_enabled, false),
    'catalog_status', v_game.catalog_status,
    'stock', public.tcg_game_stock(p_game_id)
  );
end;
$$;

revoke all on function public.tcg_game_stock(smallint) from public, anon;
revoke all on function public.set_tcg_game_enabled(smallint, boolean) from public, anon;
grant execute on function public.tcg_game_stock(smallint) to authenticated;
grant execute on function public.set_tcg_game_enabled(smallint, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- Búsqueda: texto normalizado + índice de trigramas
-- ---------------------------------------------------------------------
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

-- Minúsculas, sin acentos y sin signos raros: "Pokémon" → "pokemon".
create function public.tcg_normalize(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select btrim(regexp_replace(
    translate(lower(coalesce(p_text, '')), 'áàäâéèëêíìïîóòöôúùüûñç', 'aaaaeeeeiiiioooouuuunc'),
    '[^a-z0-9/ .-]+', ' ', 'g'));
$$;

alter table public.tcg_products add column search_text text;

-- Nombre + número + set (nombre y abreviatura). El set vive en otra tabla, así
-- que lo llena un trigger (el job copia los sets antes que las cartas).
create function public.tcg_products_search_text()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.search_text := public.tcg_normalize(concat_ws(' ',
    new.name, new.number,
    (select s.name || ' ' || coalesce(s.abbreviation, '') from public.tcg_sets s where s.id = new.set_id)));
  return new;
end;
$$;

create trigger tcg_products_search_text
  before insert or update of name, number, set_id on public.tcg_products
  for each row execute function public.tcg_products_search_text();

revoke all on function public.tcg_products_search_text() from public, anon, authenticated;

update public.tcg_products set name = name;

create index tcg_products_search_trgm_idx on public.tcg_products using gin (search_text extensions.gin_trgm_ops);
create index tcg_products_number_idx on public.tcg_products (game_id, lower(number));

-- ---------------------------------------------------------------------
-- search_singles: cartas de los juegos ACTIVOS que tienen todas las palabras
-- (nombre, número o set, en cualquier orden). p_game_id opcional.
-- Devuelve con cada carta sus precios de referencia (USD) por subtipo.
-- Máximo 50 filas.
-- ---------------------------------------------------------------------
create function public.search_singles(p_query text, p_game_id smallint default null, p_limit integer default 30)
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
           extensions.similarity(p.search_text, v_text) as score
    from public.tcg_products p
    join public.store_tcg_settings st on st.game_id = p.game_id and st.enabled
    where (p_game_id is null or p.game_id = p_game_id)
      -- La palabra más larga con LIKE usa el índice de trigramas; las demás se revisan después.
      and p.search_text like '%' || v_longest || '%'
      and not exists (select 1 from unnest(v_words) w where strpos(p.search_text, w) = 0)
    order by exact desc, score desc, p.id desc
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
  order by h.exact desc, h.score desc, s.release_date desc nulls last, h.id desc;
end;
$$;

revoke all on function public.search_singles(text, smallint, integer) from public, anon;
grant execute on function public.search_singles(text, smallint, integer) to authenticated;
revoke all on function public.tcg_normalize(text) from public, anon;
grant execute on function public.tcg_normalize(text) to authenticated, service_role;

-- Juegos para Configuración (con su estado de activo).
create view public.tcg_game_settings
with (security_invoker = true)
as
select g.id, g.slug, g.display_name, g.is_supported, g.sort_order, g.product_count, g.catalog_status,
       g.status_message, g.status_at, g.prices_as_of, g.last_synced_at,
       coalesce(st.enabled, false) as enabled
from public.tcg_games g
left join public.store_tcg_settings st on st.game_id = g.id
where g.is_supported or coalesce(st.enabled, false);

revoke all on public.tcg_game_settings from anon, authenticated;
grant select on public.tcg_game_settings to authenticated;
