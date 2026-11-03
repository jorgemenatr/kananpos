-- =====================================================================
-- Entradas de inventario ordenadas por intención:
--   * Inventario inicial: el primer conteo del negocio (puede hacerse por
--     partes). Escaneo libre, altas con cantidad inicial y, si se quiere,
--     proveedor y costo. Está abierto hasta que el admin lo cierra
--     (app_settings.initial_load_open).
--   * Compras: la mercancía que llega de un proveedor (ya existía).
--   * Conteo y ajustes: corregir lo que hay. Cada escaneo lleva motivo; lo
--     que sube entra como ajuste con el último costo del producto (sin
--     proveedor ni costo nuevos).
--
-- Con el inventario inicial cerrado, el servidor ya no acepta escaneos sin
-- motivo ni altas con cantidad inicial: la mercancía nueva entra por Compras.
-- =====================================================================

alter table public.app_settings
  add column initial_load_open boolean not null default true;

grant update (initial_load_open) on public.app_settings to authenticated;

comment on column public.app_settings.initial_load_open is
  'true = sigue abierta la sección Inventario inicial (escaneo libre y altas con cantidad).';

create function public._initial_load_open()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select initial_load_open from public.app_settings where id), true);
$$;

revoke all on function public._initial_load_open() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- _add_entry: igual que antes, pero con el inventario inicial cerrado ya
-- no se crean lotes de escaneo libre ni de alta con cantidad inicial.
-- ---------------------------------------------------------------------
create or replace function public._add_entry(
  p_product_id       uuid,
  p_location         public.stock_location,
  p_quantity         integer,
  p_supplier_id      uuid,
  p_unit_cost        numeric,
  p_origin           public.lot_origin,
  p_movement_id      uuid,
  p_session_id       uuid default null,
  p_purchase_item_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lot      uuid;
  v_supplier uuid;
  v_cost     numeric(12, 2);
begin
  if p_origin in ('scan', 'product_create') and not public._initial_load_open() then
    raise exception 'El inventario inicial ya se cerró: la mercancía nueva entra por Compras y las correcciones por Conteo y ajustes'
      using errcode = '22023';
  end if;
  if p_unit_cost is not null and p_unit_cost < 0 then
    raise exception 'El costo no puede ser negativo' using errcode = '22023';
  end if;

  if p_session_id is not null then
    select id into v_lot from public.lots
    where scan_session_id = p_session_id and product_id = p_product_id and entry_location = p_location
    for update;
    if found then
      update public.lots set received_quantity = received_quantity + p_quantity where id = v_lot;
      perform public._lot_add(v_lot, p_location, p_quantity, p_movement_id);
      return v_lot;
    end if;
  end if;

  select coalesce(p_supplier_id, supplier_id), coalesce(p_unit_cost, cost, 0)
  into v_supplier, v_cost
  from public.products where id = p_product_id;

  insert into public.lots (
    product_id, supplier_id, unit_cost, received_quantity, origin, entry_location,
    purchase_item_id, scan_session_id, created_by
  ) values (
    p_product_id, v_supplier, v_cost, p_quantity, p_origin, p_location,
    p_purchase_item_id, p_session_id, auth.uid()
  )
  returning id into v_lot;

  perform public._lot_add(v_lot, p_location, p_quantity, p_movement_id);

  -- Último proveedor y costo del producto (precargan la siguiente entrada).
  if p_supplier_id is not null or p_unit_cost is not null then
    update public.products
    set supplier_id = coalesce(p_supplier_id, supplier_id), cost = coalesce(p_unit_cost, cost)
    where id = p_product_id
      and (supplier_id, cost) is distinct from (coalesce(p_supplier_id, supplier_id), coalesce(p_unit_cost, cost));
  end if;

  return v_lot;
end;
$$;

revoke all on function public._add_entry(uuid, public.stock_location, integer, uuid, numeric, public.lot_origin, uuid, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- register_scan: + p_reason (Conteo y ajustes).
--   Con motivo: el movimiento es un 'adjustment' con el motivo en la nota;
--   lo que sube entra como lote de ajuste con el último proveedor y costo
--   del producto (se ignoran p_supplier_id / p_unit_cost).
--   Sin motivo: escaneo del inventario inicial, como antes. Solo mientras
--   el inventario inicial esté abierto.
-- status: 'ok' | 'duplicate' | 'not_found'
-- ---------------------------------------------------------------------
drop function public.register_scan(text, text, integer, uuid, text, public.stock_location, uuid, numeric, uuid, jsonb);

create function public.register_scan(
  p_barcode      text,
  p_mode         text,
  p_quantity     integer,
  p_client_op_id uuid default null,
  p_note         text default null,
  p_location     public.stock_location default 'store',
  p_supplier_id  uuid default null,
  p_unit_cost    numeric default null,
  p_session_id   uuid default null,
  p_lots         jsonb default null,
  p_reason       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product  public.products;
  v_movement public.inventory_movements;
  v_loc      public.stock_location := coalesce(p_location, 'store');
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_current  integer;
  v_new_qty  integer;
begin
  perform public._require_admin();

  if p_mode not in ('add', 'set') then
    raise exception 'Modo inválido: %', p_mode using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity < 0 or (p_mode = 'add' and p_quantity = 0) then
    raise exception 'Cantidad inválida: %', p_quantity using errcode = '22023';
  end if;

  if p_client_op_id is not null then
    select * into v_movement from public.inventory_movements where client_op_id = p_client_op_id;
    if found then
      return public._movement_result('duplicate', v_movement);
    end if;
  end if;

  if v_reason is null and not public._initial_load_open() then
    raise exception 'El inventario inicial ya se cerró: indica el motivo del conteo o ajuste'
      using errcode = '22023';
  end if;

  select * into v_product from public.products where barcode = btrim(p_barcode) for update;
  if not found then
    return jsonb_build_object('status', 'not_found', 'barcode', btrim(p_barcode));
  end if;

  v_current := public._location_qty(v_product.id, v_loc);
  v_new_qty := case when p_mode = 'add' then v_current + p_quantity else p_quantity end;

  insert into public.inventory_movements (product_id, type, delta, quantity_after, note, client_op_id, created_by, location)
  values (
    v_product.id,
    case
      when v_reason is not null then 'adjustment'
      when p_mode = 'add' then 'scan_add'
      else 'set_total'
    end::public.movement_type,
    v_new_qty - v_current,
    v_new_qty,
    case
      when v_reason is null then p_note
      else concat_ws(' · ',
                     case when p_mode = 'add' then 'Conteo (sumar)' else 'Conteo (fijar total)' end || '. Motivo: ' || v_reason,
                     nullif(btrim(coalesce(p_note, '')), ''))
    end,
    p_client_op_id,
    auth.uid(),
    v_loc
  )
  returning * into v_movement;

  if v_new_qty > v_current then
    if v_reason is not null then
      perform public._add_entry(v_product.id, v_loc, v_new_qty - v_current, null, null,
                                'adjustment', v_movement.id);
    else
      perform public._add_entry(v_product.id, v_loc, v_new_qty - v_current, p_supplier_id, p_unit_cost,
                                'scan', v_movement.id, p_session_id);
    end if;
  elsif v_new_qty < v_current then
    perform public._take_chosen(v_product.id, v_loc, p_lots, v_current - v_new_qty, v_movement.id);
  end if;

  return public._movement_result('ok', v_movement);
end;
$$;

revoke all on function public.register_scan(text, text, integer, uuid, text, public.stock_location, uuid, numeric, uuid, jsonb, text) from public, anon;
grant execute on function public.register_scan(text, text, integer, uuid, text, public.stock_location, uuid, numeric, uuid, jsonb, text) to authenticated;
