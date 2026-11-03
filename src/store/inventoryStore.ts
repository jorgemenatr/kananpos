import { isAuthError, isNetworkError, probeConnection, supabase } from '../lib/supabase'
import { internalCodeLabel, normalizeBarcode } from '../lib/barcode'
import { uploadProductImage } from '../lib/images'
import { needsLotChoice } from '../lib/lots'
import type {
  CreateRpcResult,
  LotPick,
  MovementResult,
  PaymentPart,
  PayTicketResult,
  PreorderDepositType,
  Product,
  ProductLanguage,
  ScanMode,
  ScanRpcResult,
  StockLocation,
  Ticket,
  TicketPaymentMethod,
  TicketRpcResult,
} from '../lib/types'

/*
 * Estado de inventario del lado del cliente:
 *  - Caché de productos (código → producto) para saber si un código existe aun sin red
 *    y para calcular los contadores.
 *  - Cola de operaciones pendientes (localStorage). Cada operación lleva un
 *    client_op_id: si se reintenta, el servidor no la duplica.
 *  - Últimos escaneos de la sesión (para el panel y "Deshacer").
 *
 * Todas las operaciones se ejecutan en serie (una tras otra) para respetar el
 * orden de escaneo, tanto en línea como al sincronizar la cola.
 *
 * Cada producto tiene piezas en tienda (quantity) y en bodega
 * (warehouse_quantity). Escaneos, altas y ajustes van a una ubicación; las
 * ventas siempre salen de la tienda y solo se cobran con conexión.
 */

export interface CachedProduct {
  id: string
  barcode: string
  name: string
  category: string | null
  supplier: string | null
  price: number
  /** Piezas en tienda (las que se pueden vender). */
  quantity: number
  /** Piezas en bodega. */
  warehouse_quantity: number
  image_url: string | null
  is_internal_code: boolean
  /** false = sin control de inventario (comida, torneos). La caché anterior no lo trae: sí lleva. */
  track_stock?: boolean
  /** Preventa: se vende con anticipo aunque no haya llegado (la caché anterior no lo trae). */
  is_preorder?: boolean
  preorder_deposit_type?: PreorderDepositType
  preorder_deposit_value?: number
  /** Piezas comprometidas en preventas sin entregar. */
  preorder_reserved?: number
  /** Combo: al venderlo se elige una bebida del grupo de bebidas (la caché anterior no lo trae). */
  is_combo?: boolean
  /** Idioma (inglés, español…); null o ausente = no aplica (la caché anterior no lo trae). */
  language?: ProductLanguage | null
  /** Alta que aún está en la cola (no existe en el servidor todavía). */
  pending?: boolean
}

export interface CreateInput {
  barcode: string | null // null = generar código interno (HCH-)
  name: string
  price: number
  cost: number | null
  category: string | null
  supplier: string | null
  initialQuantity: number
  /** Dónde está la cantidad inicial (las altas de la cola anterior no lo traen: tienda). */
  location?: StockLocation
  // Opcionales: las altas que ya estaban en la cola antes del catálogo no los traen.
  description?: string | null
  /** productId de TCGplayer (catalog_products) vinculado. */
  catalogProductId?: number | null
  /** Idioma del producto (las altas de la cola anterior no lo traen: no aplica). */
  language?: ProductLanguage | null
}

/** Venta cobrada en el mostrador (se envía con pay_ticket). */
export interface SaleInput {
  /** Id del ticket: lo genera el mostrador y evita cobrar dos veces. */
  ticketId: string
  /**
   * Solo para mostrar mientras la venta está en la cola (p. ej. el cliente).
   * El nombre real ("Ticket N") lo asigna el servidor al registrar la venta.
   */
  name: string
  customerId: string | null
  customerName: string | null
  /** Método del ticket ('mixed' si hay varios pagos). */
  paymentMethod: TicketPaymentMethod
  /** Pagos por método; deben sumar el total. Las ventas de la cola anterior no lo traen. */
  payments?: PaymentPart[]
  openedAt: string
  items: { barcode: string; name: string; quantity: number; unitPrice: number }[]
}

/** Ticket abierto que se cobra con checkout_ticket (venta o preventa). */
export interface CheckoutInput {
  ticketId: string
  items: { productId: string; name: string; quantity: number; unitPrice: number; choiceProductId: string | null }[]
  payments: PaymentPart[]
  customerId: string | null
  /** Nombre libre (sin perfil de cliente). */
  customerName: string | null
  notes: string | null
  openedAt: string
}

export type CheckoutOutcome =
  | { type: 'ok'; ticket: Ticket; balance: number }
  | { type: 'error'; message: string }

/** Con qué se registra cada escaneo de una sesión de conteo. */
export interface ScanContext {
  location: StockLocation
  /** Proveedor y costo del lote nuevo (null = los últimos del producto). */
  supplierId: string | null
  unitCost: number | null
  /** Los escaneos de la misma sesión suman al mismo lote (uno por producto). */
  sessionId: string | null
  /**
   * Conteo y ajustes: motivo del conteo (merma, conteo físico…). Con motivo el
   * movimiento es un ajuste y lo que sube entra con el último costo; sin motivo
   * es un escaneo del inventario inicial. Los escaneos anteriores no lo traen.
   */
  reason?: string | null
}

const DEFAULT_CONTEXT: ScanContext = { location: 'store', supplierId: null, unitCost: null, sessionId: null }

/** Compra capturada (se registra con register_purchase; sin conexión, va a la cola). */
export interface PurchaseDraft {
  /** Lo genera la app: si se reintenta, no se duplica. */
  id: string
  supplierId: string
  /** Solo para mostrar mientras está en la cola. */
  supplierName: string
  location: StockLocation
  folio: string
  note: string
  /**
   * productId puede ser "pending:…" si el producto se dio de alta sin conexión:
   * al sincronizar se busca por código (el alta va antes en la cola).
   */
  items: { productId: string; barcode: string; name: string; quantity: number; unitCost: number }[]
}

export type PurchaseOutcome = { type: 'ok'; pending: boolean } | { type: 'error'; message: string }

export type QueueItem =
  // ctx falta en los escaneos que ya estaban en la cola antes de las ubicaciones (tienda).
  | { kind: 'scan'; opId: string; createdAt: string; barcode: string; mode: ScanMode; quantity: number; ctx?: ScanContext }
  | { kind: 'create'; opId: string; createdAt: string; input: CreateInput; imagePath: string | null }
  | { kind: 'undo'; opId: string; createdAt: string; movementId: string; barcode: string }
  | { kind: 'sale'; opId: string; createdAt: string; sale: SaleInput }
  /** opId = id de la compra. */
  | { kind: 'purchase'; opId: string; createdAt: string; purchase: PurchaseDraft }

export interface RecentEntry {
  /** = client_op_id de la operación */
  key: string
  at: string
  kind: 'scan' | 'create'
  barcode: string
  name: string
  imagePath: string | null
  mode: ScanMode | null
  amount: number
  delta: number
  /** Cantidad en la ubicación del movimiento después de aplicarlo. */
  quantityAfter: number
  /** Las entradas anteriores a las ubicaciones no lo traen (tienda). */
  location?: StockLocation
  movementId: string | null
  pending: boolean
  undone: boolean
  error?: string
}

export interface FailedOp {
  item: QueueItem
  error: string
  at: string
}

export interface InventoryState {
  products: Record<string, CachedProduct>
  productsLoaded: boolean
  queue: QueueItem[]
  failed: FailedOp[]
  recent: RecentEntry[]
  online: boolean
  syncing: boolean
  syncError: string | null
}

export type ScanOutcome =
  | { type: 'ok'; product: CachedProduct; delta: number; quantityAfter: number; mode: ScanMode; pending: boolean }
  | { type: 'not_found'; barcode: string; offline: boolean }
  /** Fijar total hacia abajo con varios lotes: hay que elegir de cuáles salen `remove` piezas. */
  | { type: 'choose_lot'; product: CachedProduct; remove: number; quantity: number }
  | { type: 'error'; message: string }

export type CreateOutcome =
  | {
      type: 'ok'
      product: CachedProduct
      quantityAfter: number
      pending: boolean
      /** El código ya existía: se sumó la cantidad inicial en lugar de crear. */
      existed: boolean
      imageSkipped: boolean
    }
  | { type: 'error'; message: string }

export type UndoOutcome =
  | { type: 'ok'; entry: RecentEntry; quantityAfter: number; pending: boolean }
  | { type: 'nothing' }
  | { type: 'error'; message: string }

/** Piezas de un producto en una ubicación. */
export const qtyAt = (p: Pick<CachedProduct, 'quantity' | 'warehouse_quantity'>, location: StockLocation) =>
  location === 'store' ? p.quantity : (p.warehouse_quantity ?? 0)

const withQtyAt = (p: CachedProduct, location: StockLocation, n: number): CachedProduct =>
  location === 'store' ? { ...p, quantity: n } : { ...p, warehouse_quantity: n }

const KEYS = {
  products: 'hachiko.products.v1',
  queue: 'hachiko.queue.v1',
  failed: 'hachiko.failed.v1',
  recent: 'hachiko.recent.v1',
}
const RECENT_LIMIT = 10
const RETRY_INTERVAL_MS = 15_000

class PermanentError extends Error {}

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

function toCached(p: Product): CachedProduct {
  return {
    id: p.id,
    barcode: p.barcode,
    name: p.name,
    category: p.category,
    supplier: p.supplier,
    price: Number(p.price),
    quantity: p.quantity,
    warehouse_quantity: p.warehouse_quantity ?? 0,
    image_url: p.image_url,
    is_internal_code: p.is_internal_code,
    track_stock: p.track_stock,
    is_preorder: p.is_preorder,
    preorder_deposit_type: p.preorder_deposit_type,
    preorder_deposit_value: p.preorder_deposit_value == null ? undefined : Number(p.preorder_deposit_value),
    preorder_reserved: p.preorder_reserved,
    is_combo: p.is_combo,
    language: p.language ?? null,
  }
}

/** Bebidas que se eligen con un combo: los productos de la categoría del grupo de bebidas. */
export function comboDrinks(products: Record<string, CachedProduct>, category: string | null) {
  if (!category) return []
  return Object.values(products)
    .filter((p) => p.category === category)
    .sort((a, b) => a.name.localeCompare(b.name, 'es-MX'))
}

/** Piezas que aún se pueden vender en tienda: stock − comprometidas en preventas. */
export const freeQuantity = (p: Pick<CachedProduct, 'quantity' | 'preorder_reserved'>) => p.quantity - (p.preorder_reserved ?? 0)

/** Lleva inventario (se revisa y descuenta su stock al vender). */
export const tracksStock = (p: { track_stock?: boolean }) => p.track_stock !== false

function errorMessage(e: unknown) {
  if (e instanceof Error) return e.message
  const m = (e as { message?: string })?.message
  return m ?? String(e)
}

function queueBarcodes(q: QueueItem): string[] {
  if (q.kind === 'sale') return q.sale.items.map((i) => i.barcode)
  if (q.kind === 'purchase') return q.purchase.items.map((i) => i.barcode)
  const b = q.kind === 'create' ? q.input.barcode : q.barcode
  return b ? [b] : []
}

function rpcError(error: unknown): never {
  throw error
}

function scanParams(ctx: ScanContext) {
  return {
    p_location: ctx.location,
    p_supplier_id: ctx.supplierId,
    p_unit_cost: ctx.unitCost,
    p_session_id: ctx.sessionId,
    // Solo si trae motivo: un escaneo del inventario inicial funciona igual
    // en una base que aún no tiene la migración 20261103000100.
    ...(ctx.reason ? { p_reason: ctx.reason } : {}),
  }
}

/** ", y N en bodega: pide un movimiento" cuando la tienda no alcanza pero hay en bodega. */
export function warehouseHint(p: Pick<CachedProduct, 'warehouse_quantity'>) {
  const w = p.warehouse_quantity ?? 0
  return w > 0 ? ` y ${w} en bodega: pide un movimiento` : ''
}

class InventoryStore {
  private state: InventoryState
  private listeners = new Set<() => void>()
  private chain: Promise<unknown> = Promise.resolve()
  private started = false

  constructor() {
    const products = load<Record<string, CachedProduct>>(KEYS.products, {})
    this.state = {
      products,
      productsLoaded: Object.keys(products).length > 0,
      queue: load<QueueItem[]>(KEYS.queue, []),
      failed: load<FailedOp[]>(KEYS.failed, []),
      recent: load<RecentEntry[]>(KEYS.recent, []),
      online: typeof navigator === 'undefined' ? true : navigator.onLine,
      syncing: false,
      syncError: null,
    }
  }

  // ---------- suscripción (useSyncExternalStore) ----------
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.state

  private set(patch: Partial<InventoryState>) {
    this.state = { ...this.state, ...patch }
    if (patch.products) save(KEYS.products, this.state.products)
    if (patch.queue) save(KEYS.queue, this.state.queue)
    if (patch.failed) save(KEYS.failed, this.state.failed)
    if (patch.recent) save(KEYS.recent, this.state.recent)
    this.listeners.forEach((l) => l())
  }

  /** Ejecuta tareas en serie, en el orden en que se piden. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const p = this.chain.then(task)
    this.chain = p.catch(() => undefined)
    return p
  }

  // ---------- arranque ----------
  start() {
    if (this.started) return
    this.started = true
    window.addEventListener('online', () => void this.checkConnection())
    window.addEventListener('offline', () => this.set({ online: false }))
    setInterval(() => {
      if (this.state.queue.length > 0 || !this.state.online) void this.checkConnection()
    }, RETRY_INTERVAL_MS)
    supabase.auth.onAuthStateChange((event, session) => {
      if (!session) return
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') {
        // Fuera del callback de auth, como recomienda supabase-js.
        setTimeout(() => {
          if (this.state.syncError) this.set({ syncError: null })
          void this.syncNow().then(() => this.refreshProducts())
        }, 0)
      }
    })
  }

  /** Comprueba conectividad real y, si hay, sincroniza. */
  async checkConnection() {
    const ok = await probeConnection()
    if (ok !== this.state.online) this.set({ online: ok })
    if (ok && this.state.queue.length > 0) await this.syncNow()
  }

  private markOffline() {
    if (this.state.online) this.set({ online: false })
  }

  private markOnline() {
    if (!this.state.online) this.set({ online: true })
  }

  // ---------- caché de productos ----------
  refreshProducts() {
    return this.run(async () => {
      if (this.state.queue.length > 0) return // no pisar lo optimista con datos viejos
      const { data: s } = await supabase.auth.getSession()
      if (!s.session) return
      const all: Record<string, CachedProduct> = {}
      const PAGE = 1000
      try {
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase
            .from('products')
            .select(
              'id, barcode, name, category, supplier, price, quantity, warehouse_quantity, image_url, is_internal_code, track_stock, ' +
                'is_preorder, preorder_deposit_type, preorder_deposit_value, is_combo, language',
            )
            .order('created_at', { ascending: true })
            .range(from, from + PAGE - 1)
          if (error) throw error
          for (const p of (data ?? []) as unknown as Product[]) all[p.barcode] = toCached(p)
          if (!data || data.length < PAGE) break
        }
        // Piezas comprometidas en preventas (vista aparte: products.cost no es legible para la app).
        const { data: reservations, error: reservationsError } = await supabase
          .from('product_reservations')
          .select('product_id, reserved')
        if (reservationsError) throw reservationsError
        const reserved = new Map((reservations ?? []).map((r) => [r.product_id as string, Number(r.reserved)]))
        for (const p of Object.values(all)) p.preorder_reserved = reserved.get(p.id) ?? 0
        this.markOnline()
        this.set({ products: all, productsLoaded: true })
      } catch (e) {
        if (isNetworkError(e)) this.markOffline()
        else console.error('No se pudo cargar el catálogo', e)
      }
    })
  }

  private putProduct(p: CachedProduct, removeBarcode?: string) {
    const products = { ...this.state.products }
    const before = products[removeBarcode ?? p.barcode]
    if (removeBarcode) delete products[removeBarcode]
    // Las funciones de escaneo no devuelven lo comprometido en preventas: se conserva.
    products[p.barcode] = p.preorder_reserved === undefined && before ? { ...p, preorder_reserved: before.preorder_reserved } : p
    this.set({ products })
  }

  /**
   * Guarda un producto recién devuelto por el servidor. Si en la cola quedan
   * otras operaciones del mismo código, conserva la cantidad local (optimista),
   * que ya las incluye.
   */
  private putServerProduct(product: CachedProduct, opId: string, removeBarcode?: string) {
    const keys = new Set([product.barcode, removeBarcode].filter(Boolean))
    const othersQueued = this.state.queue.some((q) => q.opId !== opId && queueBarcodes(q).some((b) => keys.has(b)))
    const local = this.state.products[removeBarcode ?? product.barcode]
    this.putProduct(
      othersQueued && local ? { ...product, quantity: local.quantity, warehouse_quantity: local.warehouse_quantity ?? 0 } : product,
      removeBarcode,
    )
  }

  private addRecent(entry: RecentEntry) {
    this.set({ recent: [entry, ...this.state.recent].slice(0, RECENT_LIMIT) })
  }

  private patchRecent(key: string, patch: Partial<RecentEntry>) {
    if (!this.state.recent.some((r) => r.key === key)) return
    this.set({ recent: this.state.recent.map((r) => (r.key === key ? { ...r, ...patch } : r)) })
  }

  private enqueue(item: QueueItem) {
    this.set({ queue: [...this.state.queue, item] })
  }

  private canGoOnline() {
    return navigator.onLine && this.state.online
  }

  /** Antes de operar en línea, vacía la cola para no alterar el orden. */
  private async flushBeforeOnline() {
    if (this.state.queue.length > 0 && this.canGoOnline()) await this.syncInternal()
    return this.state.queue.length === 0 && this.canGoOnline()
  }

  // ---------- escaneo ----------
  /**
   * Escaneo en la ubicación de la sesión (ctx). lots: de qué lotes salen las
   * piezas cuando "fijar total" baja la cantidad y hay más de un lote.
   */
  scan(rawCode: string, mode: ScanMode, quantity: number, ctx: ScanContext = DEFAULT_CONTEXT, lots?: LotPick[]): Promise<ScanOutcome> {
    return this.run(async () => {
      const barcode = normalizeBarcode(rawCode)
      if (!barcode) return { type: 'error', message: 'Código vacío' }
      if (!Number.isInteger(quantity) || quantity < 0 || (mode === 'add' && quantity === 0)) {
        return { type: 'error', message: 'Cantidad por escaneo inválida' }
      }
      const opId = crypto.randomUUID()

      if (await this.flushBeforeOnline()) {
        try {
          const { data, error } = await supabase.rpc('register_scan', {
            p_barcode: barcode,
            p_mode: mode,
            p_quantity: quantity,
            p_client_op_id: opId,
            ...scanParams(ctx),
            p_lots: lots?.length ? lots : null,
          })
          if (error) {
            const cached = this.state.products[barcode]
            if (needsLotChoice(error) && cached) {
              return { type: 'choose_lot', product: cached, remove: qtyAt(cached, ctx.location) - quantity, quantity }
            }
            rpcError(error)
          }
          const res = data as ScanRpcResult
          if (res.status === 'not_found') {
            if (this.state.products[barcode]) {
              const products = { ...this.state.products }
              delete products[barcode]
              this.set({ products })
            }
            return { type: 'not_found', barcode, offline: false }
          }
          return this.applyScanResult(res, opId, mode, quantity, ctx.location)
        } catch (e) {
          if (!isNetworkError(e) && !isAuthError(e)) return { type: 'error', message: errorMessage(e) }
          if (isNetworkError(e)) this.markOffline()
          // Se encola con el mismo opId: si sí llegó al servidor, no se duplica.
        }
      }
      return this.scanOffline(barcode, mode, quantity, opId, ctx)
    })
  }

  private applyScanResult(res: MovementResult, opId: string, mode: ScanMode, amount: number, location: StockLocation): ScanOutcome {
    this.markOnline()
    const product = toCached(res.product)
    this.putProduct(product)
    this.addRecent({
      key: opId,
      at: new Date().toISOString(),
      kind: 'scan',
      barcode: product.barcode,
      name: product.name,
      imagePath: product.image_url,
      mode,
      amount,
      delta: res.delta,
      quantityAfter: res.quantity_after,
      location,
      movementId: res.movement_id,
      pending: false,
      undone: false,
    })
    return { type: 'ok', product, delta: res.delta, quantityAfter: res.quantity_after, mode, pending: false }
  }

  private scanOffline(barcode: string, mode: ScanMode, quantity: number, opId: string, ctx: ScanContext): ScanOutcome {
    const cached = this.state.products[barcode]
    if (!cached) return { type: 'not_found', barcode, offline: true }
    const current = qtyAt(cached, ctx.location)
    const quantityAfter = mode === 'add' ? current + quantity : quantity
    if (quantityAfter < current) {
      // Bajar existencias pide elegir el lote, y los lotes solo se ven en línea.
      return { type: 'error', message: 'Sin conexión no se pueden bajar existencias (hay que elegir el lote). Intenta cuando vuelva el internet.' }
    }
    const delta = quantityAfter - current
    const product = withQtyAt(cached, ctx.location, quantityAfter)
    this.enqueue({ kind: 'scan', opId, createdAt: new Date().toISOString(), barcode, mode, quantity, ctx })
    this.putProduct(product)
    this.addRecent({
      key: opId,
      at: new Date().toISOString(),
      kind: 'scan',
      barcode,
      name: cached.name,
      imagePath: cached.image_url,
      mode,
      amount: quantity,
      delta,
      quantityAfter,
      location: ctx.location,
      movementId: null,
      pending: true,
      undone: false,
    })
    return { type: 'ok', product, delta, quantityAfter, mode, pending: true }
  }

  // ---------- alta de producto ----------
  createProduct(raw: CreateInput, image: Blob | null): Promise<CreateOutcome> {
    return this.run(async () => {
      const input: CreateInput = {
        ...raw,
        barcode: raw.barcode ? normalizeBarcode(raw.barcode) || null : null,
        name: raw.name.trim(),
        category: raw.category?.trim() || null,
        supplier: raw.supplier?.trim() || null,
        description: raw.description?.trim() || null,
        catalogProductId: raw.catalogProductId ?? null,
        language: raw.language ?? null,
        location: raw.location ?? 'store',
      }
      const location = input.location ?? 'store'
      const opId = crypto.randomUUID()
      const online = await this.flushBeforeOnline()

      if (!input.barcode && !online) {
        return {
          type: 'error',
          message: `Para generar un código interno (${internalCodeLabel()}) se necesita conexión. Intenta cuando vuelva el internet.`,
        }
      }

      let imageSkipped = false
      if (online) {
        let imagePath: string | null = null
        let networkFailed = false
        if (image) {
          try {
            imagePath = await uploadProductImage(image)
          } catch (e) {
            if (!isNetworkError(e)) return { type: 'error', message: `No se pudo subir la imagen: ${errorMessage(e)}` }
            networkFailed = true
            imageSkipped = true
          }
        }
        if (!networkFailed) {
          try {
            const res = await this.callCreate(input, imagePath, opId)
            return { ...res, pending: false, imageSkipped }
          } catch (e) {
            if (e instanceof PermanentError || (!isNetworkError(e) && !isAuthError(e))) {
              return { type: 'error', message: errorMessage(e) }
            }
          }
        }
        this.markOffline()
      } else if (image) {
        imageSkipped = true
      }

      // ----- sin conexión: encolar -----
      if (input.barcode && this.state.products[input.barcode]) {
        // Ya existe localmente: lo tratamos como escaneo "sumar" de la cantidad inicial.
        if (input.initialQuantity === 0) {
          const p = this.state.products[input.barcode]
          return { type: 'ok', product: p, quantityAfter: qtyAt(p, location), pending: false, existed: true, imageSkipped }
        }
        const out = this.scanOffline(input.barcode, 'add', input.initialQuantity, opId, {
          location,
          supplierId: null,
          unitCost: input.cost,
          sessionId: null,
        })
        if (out.type !== 'ok') return { type: 'error', message: 'No se pudo registrar' }
        return { type: 'ok', product: out.product, quantityAfter: out.quantityAfter, pending: true, existed: true, imageSkipped }
      }
      const tempBarcode = input.barcode ?? `${internalCodeLabel()}pendiente-${opId.slice(0, 8)}`
      const product: CachedProduct = {
        id: `pending:${opId}`,
        barcode: tempBarcode,
        name: input.name,
        category: input.category,
        supplier: input.supplier,
        price: input.price,
        quantity: location === 'store' ? input.initialQuantity : 0,
        warehouse_quantity: location === 'warehouse' ? input.initialQuantity : 0,
        image_url: null,
        is_internal_code: !input.barcode,
        language: input.language ?? null,
        pending: true,
      }
      this.enqueue({ kind: 'create', opId, createdAt: new Date().toISOString(), input, imagePath: null })
      this.putProduct(product)
      this.addRecent({
        key: opId,
        at: new Date().toISOString(),
        kind: 'create',
        barcode: tempBarcode,
        name: input.name,
        imagePath: null,
        mode: null,
        amount: input.initialQuantity,
        delta: input.initialQuantity,
        quantityAfter: input.initialQuantity,
        location,
        movementId: null,
        pending: true,
        undone: false,
      })
      return { type: 'ok', product, quantityAfter: input.initialQuantity, pending: true, existed: false, imageSkipped }
    })
  }

  /** Llama a create_product; si el código ya existía, suma la cantidad inicial. */
  private async callCreate(input: CreateInput, imagePath: string | null, opId: string) {
    const location = input.location ?? 'store'
    const { data, error } = await supabase.rpc('create_product', {
      p_barcode: input.barcode,
      p_name: input.name,
      p_price: input.price,
      p_cost: input.cost,
      p_category: input.category,
      p_supplier: input.supplier,
      p_initial_quantity: input.initialQuantity,
      p_image_url: imagePath,
      p_client_op_id: opId,
      p_description: input.description ?? null,
      p_catalog_product_id: input.catalogProductId ?? null,
      p_location: location,
      // Solo si trae idioma: así un alta sin idioma también funciona en una
      // base que aún no tiene la migración 20261102000100.
      ...(input.language ? { p_language: input.language } : {}),
    })
    if (error) {
      if (!isNetworkError(error) && !isAuthError(error)) throw new PermanentError(error.message)
      throw error
    }
    const res = data as CreateRpcResult
    this.markOnline()

    if (res.status === 'exists') {
      let product = toCached(res.product)
      let delta = 0
      let movementId: string | null = null
      if (input.initialQuantity > 0) {
        const scan = await supabase.rpc('register_scan', {
          p_barcode: product.barcode,
          p_mode: 'add',
          p_quantity: input.initialQuantity,
          p_client_op_id: opId,
          p_note: 'Alta repetida: el código ya existía, se sumó la cantidad inicial',
          p_location: location,
          p_unit_cost: input.cost,
        })
        if (scan.error) {
          if (!isNetworkError(scan.error) && !isAuthError(scan.error)) throw new PermanentError(scan.error.message)
          throw scan.error
        }
        const sr = scan.data as ScanRpcResult
        if (sr.status === 'not_found') throw new PermanentError('El producto desapareció al sincronizar')
        product = toCached(sr.product)
        delta = sr.delta
        movementId = sr.movement_id
      }
      this.putServerProduct(product, opId, input.barcode ?? undefined)
      this.upsertRecentAfterSync(opId, product, delta, movementId, 'scan', input.initialQuantity, location)
      return { type: 'ok' as const, product, quantityAfter: qtyAt(product, location), existed: true }
    }

    const product = toCached(res.product)
    const pendingKey = input.barcode ?? this.findPendingBarcode(opId)
    this.putServerProduct(product, opId, pendingKey ?? undefined)
    this.upsertRecentAfterSync(opId, product, res.delta, res.movement_id, 'create', input.initialQuantity, location)
    return { type: 'ok' as const, product, quantityAfter: res.quantity_after, existed: false }
  }

  private findPendingBarcode(opId: string) {
    return Object.values(this.state.products).find((p) => p.id === `pending:${opId}`)?.barcode ?? null
  }

  private upsertRecentAfterSync(
    opId: string,
    product: CachedProduct,
    delta: number,
    movementId: string | null,
    kind: 'scan' | 'create',
    amount: number,
    location: StockLocation,
  ) {
    if (this.state.recent.some((r) => r.key === opId)) {
      this.patchRecent(opId, {
        barcode: product.barcode,
        name: product.name,
        imagePath: product.image_url,
        quantityAfter: qtyAt(product, location),
        delta,
        movementId,
        pending: false,
        // Si no hubo movimiento (cantidad 0 sobre código existente) no hay nada que deshacer.
        undone: movementId === null,
      })
      return
    }
    this.addRecent({
      key: opId,
      at: new Date().toISOString(),
      kind,
      barcode: product.barcode,
      name: product.name,
      imagePath: product.image_url,
      mode: kind === 'scan' ? 'add' : null,
      amount,
      delta,
      quantityAfter: qtyAt(product, location),
      location,
      movementId,
      pending: false,
      undone: movementId === null,
    })
  }

  // ---------- compras ----------
  /**
   * Registra una compra. Sin conexión se guarda en la cola (el id de la compra
   * evita duplicarla) y las piezas se suman de una vez a la copia local.
   */
  registerPurchase(draft: PurchaseDraft): Promise<PurchaseOutcome> {
    return this.run(async () => {
      if (draft.items.length === 0) return { type: 'error', message: 'La compra no tiene productos' }
      if (await this.flushBeforeOnline()) {
        try {
          await this.callRegisterPurchase(draft)
          return { type: 'ok', pending: false }
        } catch (e) {
          if (e instanceof PermanentError || (!isNetworkError(e) && !isAuthError(e))) {
            return { type: 'error', message: errorMessage(e) }
          }
          if (isNetworkError(e)) this.markOffline()
          // Se encola con el mismo id: si sí llegó al servidor, no se duplica.
        }
      }
      this.enqueue({ kind: 'purchase', opId: draft.id, createdAt: new Date().toISOString(), purchase: draft })
      for (const i of draft.items) {
        const p = this.state.products[i.barcode]
        if (p) this.putProduct(withQtyAt(p, draft.location, qtyAt(p, draft.location) + i.quantity))
      }
      return { type: 'ok', pending: true }
    })
  }

  private async callRegisterPurchase(draft: PurchaseDraft) {
    const items = draft.items.map((i) => {
      if (!i.productId.startsWith('pending:')) return i
      // Alta hecha sin conexión: ya se sincronizó (va antes en la cola) y la copia local tiene su id real.
      const p = this.state.products[i.barcode]
      if (!p || p.pending || p.id.startsWith('pending:')) throw new PermanentError(`${i.name} no se pudo dar de alta en el servidor`)
      return { ...i, productId: p.id }
    })
    const { error } = await supabase.rpc('register_purchase', {
      p_purchase_id: draft.id,
      p_supplier_id: draft.supplierId,
      p_items: items.map((i) => ({ product_id: i.productId, quantity: i.quantity, unit_cost: i.unitCost })),
      p_location: draft.location,
      p_folio: draft.folio.trim() || null,
      p_note: draft.note.trim() || null,
    })
    if (error) {
      if (!isNetworkError(error) && !isAuthError(error)) throw new PermanentError(error.message)
      throw error
    }
    this.markOnline()
  }

  // ---------- venta (mostrador) ----------
  private applyTicketResult(res: TicketRpcResult, opId: string) {
    for (const p of res.products) this.putServerProduct(toCached(p), opId)
  }

  private async callTicketRpc(fn: string, args: Record<string, unknown>, opId: string): Promise<TicketRpcResult> {
    if (!(await this.flushBeforeOnline())) {
      throw new PermanentError('Sin conexión. Inténtalo cuando vuelva el internet.')
    }
    const { data, error } = await supabase.rpc(fn, args)
    if (error) {
      if (!isNetworkError(error) && !isAuthError(error)) throw new PermanentError(error.message)
      if (isNetworkError(error)) this.markOffline()
      throw new PermanentError('Se perdió la conexión. Vuelve a intentarlo cuando regrese el internet (no se cobra doble).')
    }
    this.markOnline()
    const res = data as TicketRpcResult
    this.applyTicketResult(res, opId)
    return res
  }

  /**
   * Cobra un ticket abierto con checkout_ticket: venta normal (los pagos
   * suman el total) o preventa (primer abono de al menos el anticipo). Solo
   * con conexión; el id del ticket evita cobrar dos veces si se reintenta.
   */
  checkout(input: CheckoutInput): Promise<CheckoutOutcome> {
    return this.run(async () => {
      if (input.items.length === 0) return { type: 'error', message: 'El ticket no tiene productos' }
      try {
        const res = await this.callTicketRpc(
          'checkout_ticket',
          {
            p_ticket_id: input.ticketId,
            p_items: input.items.map((i) => ({
              product_id: i.productId,
              quantity: i.quantity,
              unit_price: i.unitPrice,
              choice_product_id: i.choiceProductId,
            })),
            p_payments: input.payments,
            p_customer_id: input.customerId,
            p_customer_name: input.customerName,
            p_notes: input.notes,
            p_opened_at: input.openedAt,
          },
          input.ticketId,
        )
        return { type: 'ok', ticket: res.ticket, balance: Number(res.balance ?? 0) }
      } catch (e) {
        return { type: 'error', message: errorMessage(e) }
      }
    })
  }

  /** Abono a una preventa (y entrega, si se pide y queda saldada). */
  addTicketPayment(ticketId: string, payments: PaymentPart[], deliver: boolean, opId: string): Promise<CheckoutOutcome> {
    return this.run(async () => {
      try {
        const res = await this.callTicketRpc(
          'add_ticket_payment',
          { p_ticket_id: ticketId, p_payments: payments, p_deliver: deliver, p_op_id: opId },
          opId,
        )
        return { type: 'ok', ticket: res.ticket, balance: Number(res.balance ?? 0) }
      } catch (e) {
        return { type: 'error', message: errorMessage(e) }
      }
    })
  }

  /** Cancela una preventa o una venta cobrada (solo admin): regresa inventario y, si se pide, los pagos. */
  cancelTicket(ticketId: string, reason: string | null, refund: boolean): Promise<CheckoutOutcome> {
    return this.run(async () => {
      try {
        const res = await this.callTicketRpc(
          'cancel_ticket',
          { p_ticket_id: ticketId, p_reason: reason, p_refund: refund },
          crypto.randomUUID(),
        )
        return { type: 'ok', ticket: res.ticket, balance: 0 }
      } catch (e) {
        return { type: 'error', message: errorMessage(e) }
      }
    })
  }

  private async callPayTicket(sale: SaleInput, offline: boolean) {
    const { data, error } = await supabase.rpc('pay_ticket', {
      p_ticket_id: sale.ticketId,
      p_name: sale.name || 'Ticket',
      p_payment_method: sale.paymentMethod,
      p_items: sale.items.map((i) => ({ barcode: i.barcode, quantity: i.quantity, unit_price: i.unitPrice })),
      p_customer_id: sale.customerId,
      p_opened_at: sale.openedAt,
      p_offline: offline,
      p_payments: sale.payments ?? null,
    })
    if (error) {
      if (!isNetworkError(error) && !isAuthError(error)) throw new PermanentError(error.message)
      throw error
    }
    this.markOnline()
    const res = data as PayTicketResult
    for (const p of res.products) this.putServerProduct(toCached(p), sale.ticketId)
    return res
  }

  // ---------- deshacer ----------
  undoLast(): Promise<UndoOutcome> {
    return this.run(async () => {
      const entry = this.state.recent.find((r) => !r.undone && !r.error)
      if (!entry) return { type: 'nothing' }

      // 1) Sigue en la cola: basta con quitarla y revertir lo optimista.
      if (entry.pending) {
        const queued = this.state.queue.find((q) => q.opId === entry.key)
        if (!queued) return { type: 'error', message: 'No se encontró la operación pendiente' }
        this.set({ queue: this.state.queue.filter((q) => q.opId !== entry.key) })
        const cached = this.state.products[entry.barcode]
        const location = entry.location ?? 'store'
        let quantityAfter = 0
        if (queued.kind === 'create' && cached?.pending) {
          const products = { ...this.state.products }
          delete products[entry.barcode]
          this.set({ products })
        } else if (cached) {
          quantityAfter = qtyAt(cached, location) - entry.delta
          this.putProduct(withQtyAt(cached, location, quantityAfter))
        }
        this.patchRecent(entry.key, { undone: true })
        return { type: 'ok', entry, quantityAfter, pending: false }
      }

      if (!entry.movementId) return { type: 'error', message: 'Este movimiento no se puede deshacer' }
      const opId = crypto.randomUUID()

      // 2) Ya está en el servidor: undo_movement.
      if (await this.flushBeforeOnline()) {
        try {
          const { data, error } = await supabase.rpc('undo_movement', {
            p_movement_id: entry.movementId,
            p_client_op_id: opId,
          })
          if (error) rpcError(error)
          const res = data as MovementResult
          const product = toCached(res.product)
          this.putProduct(product)
          this.patchRecent(entry.key, { undone: true })
          this.markOnline()
          return { type: 'ok', entry, quantityAfter: qtyAt(product, entry.location ?? 'store'), pending: false }
        } catch (e) {
          if (!isNetworkError(e) && !isAuthError(e)) return { type: 'error', message: errorMessage(e) }
          if (isNetworkError(e)) this.markOffline()
        }
      }

      // 3) Sin conexión: encolar el "deshacer".
      this.enqueue({ kind: 'undo', opId, createdAt: new Date().toISOString(), movementId: entry.movementId, barcode: entry.barcode })
      const cached = this.state.products[entry.barcode]
      const location = entry.location ?? 'store'
      const quantityAfter = (cached ? qtyAt(cached, location) : 0) - entry.delta
      if (cached) this.putProduct(withQtyAt(cached, location, quantityAfter))
      this.patchRecent(entry.key, { undone: true })
      return { type: 'ok', entry, quantityAfter, pending: true }
    })
  }

  // ---------- sincronización ----------
  syncNow() {
    return this.run(() => this.syncInternal())
  }

  private async syncInternal() {
    if (this.state.queue.length === 0 || this.state.syncing) return
    if (!navigator.onLine) return this.markOffline()

    const { data, error } = await supabase.auth.getSession()
    if (error) {
      if (isNetworkError(error)) this.markOffline()
      return
    }
    if (!data.session) {
      this.set({ syncError: 'Inicia sesión para sincronizar las operaciones pendientes.' })
      return
    }

    this.set({ syncing: true, syncError: null })
    let refreshedOnce = false
    try {
      while (this.state.queue.length > 0) {
        const item = this.state.queue[0]
        try {
          await this.applyQueued(item)
          this.set({ queue: this.state.queue.slice(1) })
          this.markOnline()
        } catch (e) {
          if (isNetworkError(e)) {
            this.markOffline()
            break
          }
          if (isAuthError(e) && !refreshedOnce) {
            refreshedOnce = true
            const r = await supabase.auth.refreshSession()
            if (r.error) {
              if (isNetworkError(r.error)) this.markOffline()
              else this.set({ syncError: 'La sesión expiró. Inicia sesión de nuevo para sincronizar.' })
              break
            }
            continue
          }
          if (isAuthError(e)) {
            this.set({ syncError: 'La sesión expiró. Inicia sesión de nuevo para sincronizar.' })
            break
          }
          // Error permanente: se aparta para revisión y se sigue con lo demás.
          const message = errorMessage(e)
          this.set({
            queue: this.state.queue.slice(1),
            failed: [...this.state.failed, { item, error: message, at: new Date().toISOString() }],
          })
          this.patchRecent(item.opId, { pending: false, error: message })
        }
      }
    } finally {
      this.set({ syncing: false })
    }
  }

  private async applyQueued(item: QueueItem) {
    if (item.kind === 'scan') {
      const { data, error } = await supabase.rpc('register_scan', {
        p_barcode: item.barcode,
        p_mode: item.mode,
        p_quantity: item.quantity,
        p_client_op_id: item.opId,
        p_note: 'Sincronizado desde la cola sin conexión',
        ...scanParams(item.ctx ?? DEFAULT_CONTEXT),
      })
      if (error) {
        if (!isNetworkError(error) && !isAuthError(error)) throw new PermanentError(error.message)
        throw error
      }
      const res = data as ScanRpcResult
      if (res.status === 'not_found') {
        throw new PermanentError(`El código ${item.barcode} no existe en la base de datos`)
      }
      this.putServerProduct(toCached(res.product), item.opId)
      this.patchRecent(item.opId, { movementId: res.movement_id, pending: false })
      return
    }
    if (item.kind === 'create') {
      await this.callCreate(item.input, item.imagePath, item.opId)
      return
    }
    if (item.kind === 'purchase') {
      // Las piezas ya están sumadas en la copia local desde que se encoló.
      await this.callRegisterPurchase(item.purchase)
      return
    }
    if (item.kind === 'sale') {
      // Solo ventas que quedaron en la cola antes de que el cobro pidiera conexión.
      await this.callPayTicket(item.sale, true)
      return
    }
    const { data, error } = await supabase.rpc('undo_movement', {
      p_movement_id: item.movementId,
      p_client_op_id: item.opId,
    })
    if (error) {
      if (!isNetworkError(error) && !isAuthError(error)) throw new PermanentError(error.message)
      throw error
    }
    this.putServerProduct(toCached((data as MovementResult).product), item.opId)
  }

  /**
   * Producto editado, ajustado o desvinculado: actualiza la copia local.
   * oldBarcode: el código que tenía si se desvinculó (se quita de la caché).
   */
  productEdited(p: Product, oldBarcode?: string) {
    this.putServerProduct(toCached(p), '', oldBarcode && oldBarcode !== p.barcode ? oldBarcode : undefined)
  }

  dismissFailed(index: number) {
    this.set({ failed: this.state.failed.filter((_, i) => i !== index) })
  }

  /** Al cerrar sesión: se conserva la cola (se sincroniza con el siguiente login). */
  clearSessionData() {
    this.set({ recent: [] })
  }
}

export const inventoryStore = new InventoryStore()
