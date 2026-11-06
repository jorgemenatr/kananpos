-- =====================================================================
-- Seguridad · Cerrar escrituras directas a tablas de dinero e historial
--
-- Problema: cualquier usuario con sesión (también el rol mostrador) podía
-- llamar a la API de Supabase directamente, sin pasar por la app, e
-- insertar filas en:
--   * tickets / ticket_items          → ventas inventadas en el historial
--   * ticket_payments                 → abonos falsos (preventa "pagada")
--   * customer_credit_movements       → crédito regalado a un cliente
--                                       (kind 'refund' no pasa por grant_credits)
--   * customer_league_points          → puntos de liga sin control
--   * inventory_movements             → movimientos 'sale' falsos
-- La app nunca escribe ahí directo: todo pasa por funciones del servidor
-- (pay_ticket, checkout_ticket, add_ticket_payment, cancel_ticket,
-- grant_credits, grant_league_points, register_scan…), que validan.
--
-- Solución: quitar el INSERT directo y dejar solo las funciones.
-- grant_credits y grant_league_points pasan a SECURITY DEFINER (antes usaban
-- los permisos del usuario y por eso necesitaban el INSERT abierto). Siguen
-- validando lo mismo y registran auth.uid() como autor.
--
-- También deja de exponerse por la API un par de funciones internas que
-- consumían folios o códigos internos si se llamaban sueltas.
--
-- Compatible con la app ya publicada: puede aplicarse en cualquier momento.
-- =====================================================================

-- ---------- 1. Funciones de créditos y puntos: con permisos propios ----------
alter function public.grant_credits(uuid, text, jsonb) security definer;
alter function public.grant_league_points(uuid, date, text, jsonb) security definer;

-- Solo usuarios con sesión (nunca anon).
revoke all on function public.grant_credits(uuid, text, jsonb) from public, anon;
revoke all on function public.grant_league_points(uuid, date, text, jsonb) from public, anon;
grant execute on function public.grant_credits(uuid, text, jsonb) to authenticated;
grant execute on function public.grant_league_points(uuid, date, text, jsonb) to authenticated;

-- ---------- 2. Sin INSERT directo en tablas de ventas, créditos e historial ----------
revoke insert on public.tickets                   from authenticated;
revoke insert on public.ticket_items              from authenticated;
revoke insert on public.ticket_payments           from authenticated;
revoke insert on public.customer_credit_movements from authenticated;
revoke insert on public.customer_league_points    from authenticated;
revoke insert on public.inventory_movements       from authenticated;

drop policy if exists "tickets: authenticated registra como sí mismo"               on public.tickets;
drop policy if exists "ticket_items: authenticated puede insertar"                  on public.ticket_items;
drop policy if exists "ticket_payments: authenticated puede insertar"               on public.ticket_payments;
drop policy if exists "credit_movements: authenticated registra como sí mismo"      on public.customer_credit_movements;
drop policy if exists "league_points: authenticated registra como sí mismo"         on public.customer_league_points;
drop policy if exists "movements: authenticated puede insertar como sí mismo"       on public.inventory_movements;

-- ---------- 3. Funciones internas: solo las usan otras funciones del servidor ----------
-- _next_ticket_number consumía un folio por llamada (huecos en los tickets);
-- _new_internal_code consumía un código interno. Las llaman funciones
-- SECURITY DEFINER, que no necesitan este permiso.
revoke execute on function public._next_ticket_number()     from public, anon, authenticated;
revoke execute on function public._new_internal_code()      from public, anon, authenticated;
revoke execute on function public._internal_code_prefix()   from public, anon, authenticated;
revoke execute on function public._check_reserved_barcode(text) from public, anon, authenticated;
