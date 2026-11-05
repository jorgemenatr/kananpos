import { useSyncExternalStore } from 'react'
import { internalCodeLabel } from '../lib/barcode'
import { listCustomers } from '../lib/customers'
import { isNetworkError, supabase } from '../lib/supabase'
import type { Customer } from '../lib/types'
import { freeQuantity, inventoryStore, tracksStock, type CachedProduct } from './inventoryStore'

/*
 * Estado del mostrador (punto de venta).
 *
 * Los tickets ABIERTOS viven en Supabase (open_tickets + open_ticket_lines):
 * se ven y se editan desde cualquier sesión o dispositivo y llegan por
 * realtime. Esta computadora guarda una copia y una cola de cambios
 * (localStorage): sin conexión se pueden abrir tickets y agregar productos, y
 * los cambios se envían al volver el internet. Si dos dispositivos editan el
 * mismo renglón, gana el último cambio.
 *
 * Al cobrar, checkout_ticket registra la venta (o preventa) y borra el ticket
 * abierto. Cancelar un ticket con productos necesita conexión.
 *
 * Stock "apartado": lo que ya está en algún ticket abierto (de cualquier
 * dispositivo) más lo comprometido en preventas. Un producto solo se puede
 * agregar si queda disponible. Los productos sin inventario (comida, torneos)
 * y los de preventa no tienen límite.
 */

export interface PosLine {
  id: string
  productId: string
  /** Opción elegida del combo (refresco): va a $0 y descuenta su inventario. */
  choiceProductId: string | null
  /** Precio de venta en ESTE ticket (se puede cambiar sin tocar el del producto). */
  unitPrice: number
  quantity: number
  createdAt: string
}

export interface OpenTicket {
  /** También es el id con el que se registra la venta (idempotencia). */
  id: string
  customer: { id: string; name: string } | null
  /** Nombre escrito en el ticket sin perfil de cliente. */
  freeName: string | null
  notes: string
  lines: PosLine[]
  openedAt: string
}

type TicketPatch = Partial<Pick<OpenTicket, 'customer' | 'freeName' | 'notes'>>

/** Cambio pendiente de enviar al servidor. */
type PosOp =
  | { kind: 'createTicket'; ticketId: string; openedAt: string }
  | { kind: 'updateTicket'; ticketId: string; patch: TicketPatch }
  | { kind: 'upsertLine'; ticketId: string; line: PosLine }
  | { kind: 'deleteLine'; ticketId: string; lineId: string }
  | { kind: 'deleteTicket'; ticketId: string }

interface PosState {
  /** Tickets abiertos (los del servidor con los cambios pendientes aplicados). */
  tickets: OpenTicket[]
  /** El ticket en pantalla. Solo en memoria: al entrar al mostrador no se abre ninguno. */
  activeId: string | null
  /** Copia de los clientes para poder asignarlos sin conexión. */
  customers: Customer[]
  /** Cambios que aún no llegan al servidor. */
  pending: number
  /** Último cambio que el servidor rechazó (p. ej. el ticket ya se cobró en otro lado). */
  syncError: string | null
}

const KEYS = {
  server: 'hachiko.pos.open.v2',
  ops: 'hachiko.pos.ops.v2',
  customers: 'hachiko.pos.customers.v1',
  /** Tickets que vivían solo en esta computadora (versión anterior). */
  legacy: 'hachiko.pos.tickets.v1',
  legacyActive: 'hachiko.pos.active.v1',
}

const REFRESH_INTERVAL_MS = 30_000

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (e) {
    console.error('No se pudo guardar en localStorage', key, e)
  }
}

function applyPatch(t: OpenTicket, patch: TicketPatch): OpenTicket {
  return { ...t, ...patch }
}

/** Los tickets del servidor con los cambios pendientes encima. */
function applyOps(server: OpenTicket[], ops: PosOp[]): OpenTicket[] {
  let tickets = server
  for (const op of ops) {
    if (op.kind === 'createTicket') {
      if (!tickets.some((t) => t.id === op.ticketId)) {
        tickets = [...tickets, { id: op.ticketId, customer: null, freeName: null, notes: '', lines: [], openedAt: op.openedAt }]
      }
    } else if (op.kind === 'deleteTicket') {
      tickets = tickets.filter((t) => t.id !== op.ticketId)
    } else {
      tickets = tickets.map((t) => {
        if (t.id !== op.ticketId) return t
        if (op.kind === 'updateTicket') return applyPatch(t, op.patch)
        if (op.kind === 'deleteLine') return { ...t, lines: t.lines.filter((l) => l.id !== op.lineId) }
        const exists = t.lines.some((l) => l.id === op.line.id)
        return { ...t, lines: exists ? t.lines.map((l) => (l.id === op.line.id ? op.line : l)) : [...t.lines, op.line] }
      })
    }
  }
  return tickets
}

function patchRow(patch: TicketPatch) {
  const row: Record<string, unknown> = {}
  if ('customer' in patch || 'freeName' in patch) {
    row.customer_id = patch.customer?.id ?? null
    row.customer_name = patch.customer?.name ?? patch.freeName ?? null
  }
  if ('notes' in patch) row.notes = patch.notes?.trim() || null
  return row
}

function lineRow(ticketId: string, l: PosLine) {
  return {
    id: l.id,
    ticket_id: ticketId,
    product_id: l.productId,
    choice_product_id: l.choiceProductId,
    unit_price: l.unitPrice,
    quantity: l.quantity,
    created_at: l.createdAt,
  }
}

interface ServerTicketRow {
  id: string
  customer_id: string | null
  customer_name: string | null
  notes: string | null
  opened_at: string
  open_ticket_lines: {
    id: string
    product_id: string
    choice_product_id: string | null
    unit_price: number
    quantity: number
    created_at: string
  }[]
}

function fromServer(r: ServerTicketRow): OpenTicket {
  return {
    id: r.id,
    customer: r.customer_id ? { id: r.customer_id, name: r.customer_name ?? 'Cliente' } : null,
    freeName: r.customer_id ? null : r.customer_name,
    notes: r.notes ?? '',
    openedAt: r.opened_at,
    lines: [...(r.open_ticket_lines ?? [])]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((l) => ({
        id: l.id,
        productId: l.product_id,
        choiceProductId: l.choice_product_id,
        unitPrice: Number(l.unit_price),
        quantity: l.quantity,
        createdAt: l.created_at,
      })),
  }
}

export type AddResult = { ok: true } | { ok: false; message: string }

class PosStore {
  private server: OpenTicket[] = load<OpenTicket[]>(KEYS.server, [])
  private ops: PosOp[] = load<PosOp[]>(KEYS.ops, [])
  private state: PosState
  private listeners = new Set<() => void>()
  private started = false
  private flushing = false
  /** Cuenta los cambios enviados: una lectura que empezó antes de uno se descarta. */
  private flushedCount = 0
  private refreshTimer: number | undefined

  constructor() {
    this.state = {
      tickets: applyOps(this.server, this.ops),
      activeId: null,
      customers: load<Customer[]>(KEYS.customers, []),
      pending: this.ops.length,
      syncError: null,
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.state

  private set(patch: Partial<PosState>) {
    this.state = { ...this.state, ...patch }
    if (patch.customers) save(KEYS.customers, this.state.customers)
    this.listeners.forEach((l) => l())
  }

  /** Recalcula los tickets visibles después de cambiar la copia del servidor o la cola. */
  private recompute() {
    save(KEYS.server, this.server)
    save(KEYS.ops, this.ops)
    const tickets = applyOps(this.server, this.ops)
    const activeId = tickets.some((t) => t.id === this.state.activeId) ? this.state.activeId : null
    this.set({ tickets, activeId, pending: this.ops.length })
  }

  private enqueue(op: PosOp) {
    // Un renglón se manda completo: basta el último cambio pendiente.
    if (op.kind === 'upsertLine') {
      // (menos el que se está enviando en este momento).
      this.ops = this.ops.filter((o, i) => !(o.kind === 'upsertLine' && o.line.id === op.line.id && !(this.flushing && i === 0)))
    }
    this.ops = [...this.ops, op]
    this.recompute()
    void this.flush()
  }

  // ---------- sincronización ----------
  /** Arranca realtime y la sincronización (una sola vez por sesión de la app). */
  start() {
    if (this.started) return
    this.started = true
    this.migrateLegacy()
    supabase
      .channel('open-tickets')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'open_tickets' }, () => this.scheduleRefresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'open_ticket_lines' }, () => this.scheduleRefresh())
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') this.scheduleRefresh()
      })
    window.addEventListener('online', () => void this.flush().then(() => this.refresh()))
    window.addEventListener('focus', () => this.scheduleRefresh())
    setInterval(() => void this.flush().then(() => this.refresh()), REFRESH_INTERVAL_MS)
    void this.flush().then(() => this.refresh())
  }

  private scheduleRefresh() {
    window.clearTimeout(this.refreshTimer)
    this.refreshTimer = window.setTimeout(() => void this.refresh(), 250)
  }

  /** Lee los tickets abiertos del servidor. */
  async refresh() {
    const before = this.flushedCount
    const { data, error } = await supabase
      .from('open_tickets')
      .select('id, customer_id, customer_name, notes, opened_at, open_ticket_lines(id, product_id, choice_product_id, unit_price, quantity, created_at)')
      .eq('status', 'open')
      .order('opened_at', { ascending: true })
    if (error) {
      if (!isNetworkError(error)) console.error('No se pudieron leer los tickets abiertos', error)
      return
    }
    // Se envió un cambio mientras se leía: la lectura puede no traerlo.
    if (this.flushedCount !== before || this.flushing) return this.scheduleRefresh()
    this.server = ((data ?? []) as ServerTicketRow[]).map(fromServer)
    this.recompute()
  }

  /** Envía la cola en orden. Se detiene sin red; un cambio rechazado se descarta. */
  async flush() {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.ops.length > 0) {
        const op = this.ops[0]
        const error = await this.send(op)
        if (error && isNetworkError(error)) return
        if (error) {
          console.error('Cambio rechazado en tickets abiertos', op, error)
          this.set({ syncError: error.message })
        } else {
          // Ya está en el servidor: se refleja en la copia hasta la siguiente lectura.
          this.server = applyOps(this.server, [op])
        }
        this.ops = this.ops.filter((o) => o !== op)
        this.flushedCount++
        this.recompute()
      }
    } finally {
      this.flushing = false
    }
  }

  private async send(op: PosOp): Promise<{ message: string } | null> {
    try {
      let res
      if (op.kind === 'createTicket') {
        res = await supabase
          .from('open_tickets')
          .upsert({ id: op.ticketId, opened_at: op.openedAt }, { onConflict: 'id', ignoreDuplicates: true })
      } else if (op.kind === 'updateTicket') {
        res = await supabase.from('open_tickets').update(patchRow(op.patch)).eq('id', op.ticketId)
      } else if (op.kind === 'upsertLine') {
        res = await supabase.from('open_ticket_lines').upsert(lineRow(op.ticketId, op.line))
      } else if (op.kind === 'deleteLine') {
        res = await supabase.from('open_ticket_lines').delete().eq('id', op.lineId)
      } else {
        res = await supabase.from('open_tickets').delete().eq('id', op.ticketId)
      }
      return res.error
    } catch (e) {
      return { message: (e as Error).message }
    }
  }

  dismissSyncError() {
    this.set({ syncError: null })
  }

  /** Tickets abiertos de la versión anterior (solo en esta computadora): se suben a la base. */
  private migrateLegacy() {
    const legacy = load<
      { id: string; customer: { id: string; name: string } | null; openedAt: string; lines: { barcode: string; unitPrice: number; quantity: number }[] }[]
    >(KEYS.legacy, [])
    if (legacy.length === 0) return
    const { products } = inventoryStore.getSnapshot()
    for (const t of legacy) {
      this.ops.push({ kind: 'createTicket', ticketId: t.id, openedAt: t.openedAt })
      if (t.customer) this.ops.push({ kind: 'updateTicket', ticketId: t.id, patch: { customer: t.customer, freeName: null } })
      for (const l of t.lines) {
        const p = products[l.barcode]
        if (!p || p.pending) continue
        const line: PosLine = {
          id: crypto.randomUUID(),
          productId: p.id,
          choiceProductId: null,
          unitPrice: l.unitPrice,
          quantity: l.quantity,
          createdAt: new Date().toISOString(),
        }
        this.ops.push({ kind: 'upsertLine', ticketId: t.id, line })
      }
    }
    try {
      localStorage.removeItem(KEYS.legacy)
      localStorage.removeItem(KEYS.legacyActive)
    } catch {
      /* no crítico */
    }
    this.recompute()
  }

  // ---------- tickets ----------
  createTicket() {
    const id = crypto.randomUUID()
    this.enqueue({ kind: 'createTicket', ticketId: id, openedAt: new Date().toISOString() })
    this.set({ activeId: id })
    return id
  }

  select(id: string | null) {
    this.set({ activeId: id })
  }

  setCustomer(id: string, customer: { id: string; name: string } | null) {
    this.enqueue({ kind: 'updateTicket', ticketId: id, patch: { customer, freeName: null } })
  }

  /** Nombre libre: identifica el ticket sin crear ni ligar un perfil de cliente. */
  setFreeName(id: string, name: string | null) {
    this.enqueue({ kind: 'updateTicket', ticketId: id, patch: { customer: null, freeName: name?.trim() || null } })
  }

  setNotes(id: string, notes: string) {
    const ticket = this.state.tickets.find((t) => t.id === id)
    if (!ticket || ticket.notes === notes) return
    this.enqueue({ kind: 'updateTicket', ticketId: id, patch: { notes } })
  }

  /** Solo tickets vacíos (con productos se cancelan con cancelTicket). */
  removeTicket(id: string) {
    const ticket = this.state.tickets.find((t) => t.id === id)
    if (!ticket || ticket.lines.length > 0) return
    this.enqueue({ kind: 'deleteTicket', ticketId: id })
  }

  /**
   * Cancela un ticket abierto con productos (necesita conexión). Queda
   * registrado quién, cuándo y el motivo; no hay inventario que regresar
   * porque aún no se descontaba.
   */
  async cancelTicket(id: string, reason: string | null): Promise<AddResult> {
    await this.flush()
    if (this.ops.some((o) => o.ticketId === id)) {
      return { ok: false, message: 'Sin conexión no se puede cancelar. Inténtalo cuando vuelva el internet.' }
    }
    const { data, error } = await supabase.rpc('cancel_open_ticket', { p_ticket_id: id, p_reason: reason })
    if (error) {
      return { ok: false, message: isNetworkError(error) ? 'Sin conexión no se puede cancelar.' : error.message }
    }
    if ((data as { status: string }).status !== 'ok') {
      await this.refresh()
      return { ok: false, message: 'Este ticket ya no está abierto (se cobró o canceló en otro dispositivo).' }
    }
    this.forget(id)
    return { ok: true }
  }

  /** Quita el ticket de los abiertos (después de cobrarlo o cancelarlo). */
  forget(id: string) {
    this.server = this.server.filter((t) => t.id !== id)
    this.ops = this.ops.filter((o) => o.ticketId !== id)
    this.recompute()
  }

  /** Antes de cobrar: que el servidor tenga el ticket (con sus datos) y no queden cambios pendientes de él. */
  async flushTicket(id: string) {
    await this.flush()
    return !this.ops.some((o) => o.ticketId === id)
  }

  // ---------- stock apartado ----------
  /** Piezas de un producto en tickets abiertos, sueltas o como opción de combo (opcionalmente sin contar un ticket). */
  reserved(productId: string, exceptTicketId?: string) {
    let n = 0
    for (const t of this.state.tickets) {
      if (t.id === exceptTicketId) continue
      for (const l of t.lines) {
        if (l.productId === productId) n += l.quantity
        if (l.choiceProductId === productId) n += l.quantity
      }
    }
    return n
  }

  /** No tiene límite: sin inventario, o de preventa (se compromete aunque no haya llegado). */
  private unlimited(product: CachedProduct) {
    return !tracksStock(product) || !!product.is_preorder
  }

  /** Piezas de un producto en un ticket (sueltas y como opción de combo). */
  private inTicket(ticket: OpenTicket, productId: string) {
    return ticket.lines.reduce(
      (n, l) => n + (l.productId === productId ? l.quantity : 0) + (l.choiceProductId === productId ? l.quantity : 0),
      0,
    )
  }

  /** Máximo que puede llevar este ticket de un producto (sumando todos sus renglones). */
  maxFor(ticketId: string, product: CachedProduct) {
    if (this.unlimited(product)) return Infinity
    return Math.max(0, freeQuantity(product) - this.reserved(product.id, ticketId))
  }

  /** Disponible para agregar en cualquier ticket: stock − preventas − todo lo apartado. */
  available(product: CachedProduct) {
    if (this.unlimited(product)) return Infinity
    return freeQuantity(product) - this.reserved(product.id)
  }

  private stockMessage(ticket: OpenTicket, product: CachedProduct) {
    const elsewhere = this.reserved(product.id, ticket.id)
    const current = this.inTicket(ticket, product.id)
    const committed = product.preorder_reserved ?? 0
    return (
      (product.quantity <= 0
        ? `${product.name} no tiene stock en tienda.`
        : `No hay más stock de ${product.name}: hay ${product.quantity} en tienda` +
          (committed > 0 ? `, ${committed} comprometida(s) en preventas` : '') +
          (elsewhere > 0 ? `, ${elsewhere} apartado(s) en otros tickets abiertos` : '') +
          (current > 0 ? ` y ${current} ya en este ticket` : '') +
          '.') + ((product.warehouse_quantity ?? 0) > 0 ? ` Hay ${product.warehouse_quantity} en bodega: pide un movimiento.` : '')
    )
  }

  // ---------- productos del ticket ----------
  /**
   * Agrega piezas de un producto. Con choice (combo), el renglón lleva esa
   * opción: combos con distinto refresco van en renglones separados.
   */
  addProduct(ticketId: string, product: CachedProduct, choice: CachedProduct | null = null, quantity = 1): AddResult {
    const ticket = this.state.tickets.find((t) => t.id === ticketId)
    if (!ticket) return { ok: false, message: 'No hay un ticket abierto' }
    for (const p of [product, choice]) {
      if (p?.pending) {
        return {
          ok: false,
          message: `Este producto aún no se sincroniza${p.is_internal_code ? ` (le falta su código ${internalCodeLabel()})` : ''}. Espera a tener conexión.`,
        }
      }
    }
    for (const p of [product, choice]) {
      if (p && this.inTicket(ticket, p.id) + quantity > this.maxFor(ticketId, p)) return { ok: false, message: this.stockMessage(ticket, p) }
    }
    const choiceId = choice?.id ?? null
    const existing = ticket.lines.find((l) => l.productId === product.id && l.choiceProductId === choiceId)
    const line: PosLine = existing
      ? { ...existing, quantity: existing.quantity + quantity }
      : {
          id: crypto.randomUUID(),
          productId: product.id,
          choiceProductId: choiceId,
          unitPrice: product.price,
          quantity,
          createdAt: new Date().toISOString(),
        }
    this.enqueue({ kind: 'upsertLine', ticketId, line })
    return { ok: true }
  }

  /** Cambia la cantidad de un renglón; se limita a lo disponible. Devuelve la cantidad que quedó. */
  setQuantity(ticketId: string, lineId: string, quantity: number, product: CachedProduct | undefined, choice: CachedProduct | undefined) {
    const ticket = this.state.tickets.find((t) => t.id === ticketId)
    const line = ticket?.lines.find((l) => l.id === lineId)
    if (!ticket || !line) return quantity
    let max = Infinity
    for (const p of [product, choice]) {
      if (p) max = Math.min(max, line.quantity + this.maxFor(ticketId, p) - this.inTicket(ticket, p.id))
    }
    const q = Math.max(1, Math.min(Math.floor(quantity), max))
    if (q !== line.quantity) this.enqueue({ kind: 'upsertLine', ticketId, line: { ...line, quantity: q } })
    return q
  }

  /** Cuántas piezas más admite un renglón (por su producto y su opción de combo). */
  lineRoom(ticketId: string, product: CachedProduct | undefined, choice: CachedProduct | undefined) {
    const ticket = this.state.tickets.find((t) => t.id === ticketId)
    if (!ticket) return 0
    let room = Infinity
    for (const p of [product, choice]) {
      if (p) room = Math.min(room, this.maxFor(ticketId, p) - this.inTicket(ticket, p.id))
    }
    return room
  }

  /** Precio de venta de un renglón solo en este ticket (el del producto no cambia). */
  setPrice(ticketId: string, lineId: string, unitPrice: number) {
    const line = this.state.tickets.find((t) => t.id === ticketId)?.lines.find((l) => l.id === lineId)
    if (!line || line.unitPrice === unitPrice) return
    this.enqueue({ kind: 'upsertLine', ticketId, line: { ...line, unitPrice } })
  }

  removeLine(ticketId: string, lineId: string) {
    this.enqueue({ kind: 'deleteLine', ticketId, lineId })
  }

  // ---------- clientes ----------
  async loadCustomers() {
    const customers = await listCustomers()
    this.set({ customers })
    return customers
  }

  addCustomer(customer: Customer) {
    const customers = [...this.state.customers.filter((c) => c.id !== customer.id), customer].sort((a, b) =>
      a.name.localeCompare(b.name, 'es-MX'),
    )
    this.set({ customers })
  }
}

export const posStore = new PosStore()

export function usePos() {
  return useSyncExternalStore(posStore.subscribe, posStore.getSnapshot)
}

export const ticketTotal = (t: OpenTicket) => t.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0)
export const ticketPieces = (t: OpenTicket) => t.lines.reduce((n, l) => n + l.quantity, 0)

/** Hora en que se abrió el ticket (para distinguir tickets sin cliente). */
export const ticketOpenedTime = (t: OpenTicket) =>
  new Date(t.openedAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })

/** Cómo se identifica un ticket abierto: por su cliente, su nombre libre o "Sin cliente". */
export const ticketLabel = (t: OpenTicket) => t.customer?.name ?? t.freeName ?? 'Sin cliente'

/**
 * Anticipo mínimo de un renglón de preventa: porcentaje del importe o monto
 * por pieza (nunca más que el importe).
 */
export function lineDeposit(line: Pick<PosLine, 'quantity' | 'unitPrice'>, product: CachedProduct) {
  const amount = line.quantity * line.unitPrice
  const value = product.preorder_deposit_value ?? 0
  const deposit =
    product.preorder_deposit_type === 'amount' ? Math.min(amount, line.quantity * value) : Math.round(amount * value) / 100
  return Math.round(deposit * 100) / 100
}
