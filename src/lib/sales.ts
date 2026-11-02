import { businessDayEnd, businessDayStart } from './settings'
import { supabase } from './supabase'
import type { PaymentMethod, SaleRow, TicketItemRow, TicketPaymentMethod, TicketPaymentRow } from './types'

export interface SalesFilter {
  /** AAAA-MM-DD (día de operación, inclusive: termina a la hora de corte, p. ej. 5:00 a.m.). */
  from?: string
  to?: string
  method?: TicketPaymentMethod | ''
  customerId?: string
}

const PAGE = 100

/**
 * Folio de una venta ("140"). Las ventas anteriores a la migración
 * nombre_tickets se guardaron como "Ticket 140".
 */
export function ticketFolio(name: string | null | undefined) {
  return (name ?? '').replace(/^Ticket\s+/i, '')
}

/** Título de una venta: "140. Ana Martínez" (o solo "140" si no se muestra el cliente). */
export function saleTitle(sale: { name: string; customer_name: string | null }, withCustomer = true) {
  const folio = ticketFolio(sale.name)
  return withCustomer ? `${folio}. ${sale.customer_name ?? 'Sin cliente'}` : `#${folio}`
}

function applyFilter<T extends { gte: Function; lt: Function; eq: Function }>(query: T, f: SalesFilter): T {
  let q = query
  // Por día de operación: del día "from" a la hora de corte al día siguiente de "to" a la hora de corte.
  if (f.from) q = q.gte('paid_at', businessDayStart(f.from).toISOString())
  if (f.to) q = q.lt('paid_at', businessDayEnd(f.to).toISOString())
  if (f.method) q = q.eq('payment_method', f.method)
  if (f.customerId) q = q.eq('customer_id', f.customerId)
  return q
}

export async function listSales(filter: SalesFilter, offset = 0): Promise<SaleRow[]> {
  const query = applyFilter(
    supabase
      .from('sales_history')
      .select('*')
      // Las preventas sin entregar (sin fecha de venta) van al final.
      .order('paid_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE - 1),
    filter,
  )
  const { data, error } = await query
  if (error) throw error
  return ((data ?? []) as SaleRow[]).map(normalizeSale)
}

const normalizeSale = (r: SaleRow): SaleRow => ({
  ...r,
  subtotal: Number(r.subtotal),
  total: Number(r.total),
  paid_amount: Number(r.paid_amount ?? 0),
  balance: Number(r.balance ?? 0),
})

/** Preventas sin entregar (las más recientes primero). */
export async function listPreorders(customerId?: string): Promise<SaleRow[]> {
  let q = supabase.from('sales_history').select('*').eq('status', 'preorder').order('created_at', { ascending: false })
  if (customerId) q = q.eq('customer_id', customerId)
  const { data, error } = await q
  if (error) throw error
  return ((data ?? []) as SaleRow[]).map(normalizeSale)
}

// El idioma se lee del producto vinculado (la venta copia el nombre, no el idioma).
const ITEM_COLUMNS = '*, product:products(language)'

type ItemWithProduct = Omit<TicketItemRow, 'language'> & { product: { language: TicketItemRow['language'] } | null }

function toItems(data: unknown): TicketItemRow[] {
  return ((data ?? []) as ItemWithProduct[]).map(({ product, ...i }) => ({
    ...i,
    unit_price: Number(i.unit_price),
    line_total: Number(i.line_total),
    language: product?.language ?? null,
  }))
}

/** Productos de varias preventas (para la lista: qué llevan y si ya se pueden entregar). */
export async function getPreorderItems(ticketIds: string[]): Promise<TicketItemRow[]> {
  if (ticketIds.length === 0) return []
  const { data, error } = await supabase
    .from('ticket_items')
    .select(ITEM_COLUMNS)
    .in('ticket_id', ticketIds)
    .order('position', { ascending: true })
  if (error) throw error
  return toItems(data)
}

export async function getSale(id: string): Promise<SaleRow | null> {
  const { data, error } = await supabase.from('sales_history').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data ? normalizeSale(data as SaleRow) : null
}

export async function setTicketNotes(ticketId: string, notes: string) {
  const { error } = await supabase.rpc('set_ticket_notes', { p_ticket_id: ticketId, p_notes: notes })
  if (error) throw error
}

async function fetchAll<T>(build: (from: number) => PromiseLike<{ data: unknown; error: unknown }>) {
  const rows: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from)
    if (error) throw error
    const page = (data ?? []) as T[]
    rows.push(...page)
    if (page.length < 1000) break
  }
  return rows
}

/**
 * Totales del filtro (todas las páginas):
 *  - Ventas: tickets entregados en el periodo (una preventa cuenta completa el
 *    día que se entrega; las canceladas no cuentan).
 *  - Por forma de pago: lo cobrado en el periodo, cada abono el día que se
 *    recibió y menos las devoluciones. Los pagos mixtos se reparten.
 */
export async function salesSummary(filter: SalesFilter) {
  const [tickets, payments] = await Promise.all([
    fetchAll<{ total: number }>((from) =>
      applyFilter(
        supabase.from('tickets').select('total').eq('status', 'paid').order('paid_at', { ascending: false }).range(from, from + 999),
        filter,
      ),
    ),
    fetchAll<{ method: PaymentMethod; amount: number }>((from) =>
      applyFilter(supabase.from('sales_payments').select('method, amount').order('paid_at', { ascending: false }).range(from, from + 999), filter),
    ),
  ])
  const byMethod: Partial<Record<PaymentMethod, number>> = {}
  for (const p of payments) byMethod[p.method] = (byMethod[p.method] ?? 0) + Number(p.amount)
  const total = tickets.reduce((s, t) => s + Number(t.total), 0)
  const collected = payments.reduce((s, p) => s + Number(p.amount), 0)
  return { count: tickets.length, total, byMethod, collected }
}

export async function getTicketPayments(ticketId: string): Promise<TicketPaymentRow[]> {
  const { data, error } = await supabase.from('ticket_payments').select('*').eq('ticket_id', ticketId).order('paid_at', { ascending: true })
  if (error) throw error
  return ((data ?? []) as TicketPaymentRow[]).map((p) => ({ ...p, amount: Number(p.amount) }))
}

export async function getTicketItems(ticketId: string): Promise<TicketItemRow[]> {
  const { data, error } = await supabase
    .from('ticket_items')
    .select(ITEM_COLUMNS)
    .eq('ticket_id', ticketId)
    .order('position', { ascending: true })
  if (error) throw error
  return toItems(data)
}

export const SALES_PAGE = PAGE
