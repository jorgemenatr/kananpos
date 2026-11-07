/*
 * Modo demo (npm run dev:demo): simula la API de Supabase dentro del navegador
 * con datos inventados, para revisar la interfaz sin tocar ninguna base real.
 *
 * - Cualquier correo y contraseña entran. Si el correo contiene "mostrador" se
 *   entra con ese rol; si no, como administrador.
 * - Las lecturas salen de los datos de abajo; altas, cambios y cobros se
 *   guardan solo en memoria (se pierden al recargar).
 *
 * Solo se carga cuando VITE_DEMO=1 (ver supabase.ts); no va en el build normal.
 */
import type { Product, UserRole } from '../types'
import { demoSingles } from './demoSingles'

type Row = Record<string, unknown>

const now = Date.now()
const ago = (min: number) => new Date(now - min * 60_000).toISOString()
const day = (daysAgo: number) => new Date(now - daysAgo * 864e5).toISOString().slice(0, 10)

// ---------- sesión ----------
let role: UserRole = 'admin'
const ADMIN_ID = 'demo-admin'
const COUNTER_ID = 'demo-mostrador'

function demoUser() {
  const id = role === 'admin' ? ADMIN_ID : COUNTER_ID
  const email = role === 'admin' ? 'admin@demo.mx' : 'mostrador@demo.mx'
  return { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: ago(99_999) }
}

function b64url(o: unknown) {
  return btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function demoSession() {
  const user = demoUser()
  const exp = Math.floor(Date.now() / 1000) + 86_400 * 30
  const token = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: user.id, role: 'authenticated', email: user.email, exp })}.demo`
  return { access_token: token, refresh_token: 'demo', token_type: 'bearer', expires_in: 86_400 * 30, expires_at: exp, user }
}

// ---------- datos ----------
const SAMPLE: [string, string, number][] = [
  ['Pokémon TCG: Scarlet & Violet—Prismatic Evolutions Elite Trainer Box', 'TCG · Pokémon', 1499],
  ['Magic: The Gathering Foundations Play Booster Box (36 sobres)', 'TCG · Magic', 3299],
  ['Yu-Gi-Oh! Rage of the Abyss Booster', 'TCG · Yu-Gi-Oh!', 89],
  ['Micas Dragon Shield Matte Negro (100)', 'Accesorios', 279],
  ['Tapete Ultra Pro Playmat Charizard', 'Accesorios', 549],
  ['Carpeta 9 bolsillos Vault X', 'Accesorios', 699],
  ['Café americano', 'Cafetería', 45],
  ['One Piece OP-09 Emperors in the New World Booster', 'TCG · One Piece', 119],
  ['Disney Lorcana Azurite Sea Starter Deck', 'TCG · Lorcana', 349],
  ['Dados d20 Chessex set de 7', 'Accesorios', 189],
]

// Fotos de muestra (ver fotos/): unos productos con foto y otros sin.
const PHOTOS = import.meta.glob('./fotos/*.jpg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const PHOTO_BY_SAMPLE: Record<number, string> = { 0: 'etb', 1: 'booster-box', 3: 'micas', 4: 'tapete', 5: 'carpeta', 6: 'cafe' }

const products: Product[] = Array.from({ length: 24 }, (_, i) => {
  const [name, category, price] = SAMPLE[i % SAMPLE.length]
  const photo = i < SAMPLE.length ? PHOTO_BY_SAMPLE[i] : undefined
  const internal = i % 3 === 0
  return {
    id: `p${i}`,
    barcode: internal ? `DEMO-${String(i + 1).padStart(5, '0')}` : `08206508${String(10_000 + i)}`,
    name: i < SAMPLE.length ? name : `${name} (${i})`,
    category,
    supplier: 'Distribuidora Kanto',
    supplier_id: 's1',
    cost: Math.round(price * 0.6),
    price,
    quantity: i % 7 === 0 ? 0 : (i * 3) % 17,
    warehouse_quantity: (i * 5) % 11,
    image_url: photo ? `demo/${photo}.jpg` : null,
    is_internal_code: internal,
    track_stock: true,
    // Una preventa (30 % de anticipo) para probar abonos.
    is_preorder: i === 1,
    preorder_deposit_type: 'percent',
    preorder_deposit_value: i === 1 ? 30 : 0,
    // El café (p6) es combo: se elige una bebida del grupo (en el demo, Accesorios).
    is_combo: i === 6,
    description: null,
    catalog_product_id: null,
    // Pokémon: el primero en inglés y su versión en español (otro código).
    language: category === 'TCG · Pokémon' ? (i === 10 ? 'es' : 'en') : null,
    created_by: ADMIN_ID,
    created_at: ago(10_000 - i),
    updated_at: ago(100),
  }
})

// Singles de muestra (cartas reales del catálogo).
const singles = demoSingles(products)

const CUSTOMER_NAMES = ['Ana Martínez', 'Luis Hernández García', 'Sofía Ramírez', 'Diego Torres', 'Valentina Cruz Domínguez de la Fuente', 'Carlos Pérez']
const GAMES = [['Pokémon', 'Magic'], ['Yu-Gi-Oh!'], [], ['One Piece', 'Lorcana', 'Magic', 'Pokémon'], ['Magic'], []]
const customers: Row[] = CUSTOMER_NAMES.map((name, i) => ({
  id: `c${i}`,
  name,
  email: i % 2 ? null : `${name.split(' ')[0].toLowerCase()}@correo.com`,
  phone: i % 3 ? '55 1234 5678' : null,
  // Con correo y teléfono: tiene código de cliente.
  code: i % 2 === 0 && i % 3 ? String(10000001 + i) : null,
  games: GAMES[i],
  nicknames: i === 1 ? ['Wicho'] : [],
  created_at: ago(5000 * (i + 1)),
  updated_at: ago(100),
}))

const by = { created_by: ADMIN_ID, created_by_email: 'admin@demo.mx', created_by_name: 'Admin Demo' }

const METHODS = ['cash', 'card', 'mixed', 'credit', 'transfer']
const sales: Row[] = Array.from({ length: 14 }, (_, i) => ({
  id: `t${i}`,
  name: String(140 - i),
  status: 'paid',
  customer_id: i % 3 ? `c${i % 6}` : null,
  customer_name: i % 3 ? CUSTOMER_NAMES[i % 6] : null,
  payment_method: METHODS[i % 5],
  item_count: (i % 4) + 1,
  subtotal: 300 + i * 117,
  total: 300 + i * 117,
  paid_offline: i === 2,
  note: null,
  opened_at: ago(i * 180 + 20),
  paid_at: ago(i * 180),
  created_at: ago(i * 180),
  number: 140 - i,
  notes: i === 1 ? 'Pidió factura' : null,
  customer_is_free_name: false,
  paid_amount: 300 + i * 117,
  balance: 0,
  ...by,
}))

// Una preventa pendiente (para la sección Preventas y el perfil del cliente).
sales.push({
  id: 'pre1',
  name: '141',
  number: 141,
  status: 'preorder',
  customer_id: 'c1',
  customer_name: CUSTOMER_NAMES[1],
  customer_is_free_name: false,
  payment_method: 'cash',
  item_count: 2,
  subtotal: 3298,
  total: 3298,
  paid_offline: false,
  note: null,
  notes: 'Avisar por WhatsApp cuando llegue',
  opened_at: ago(3000),
  paid_at: null,
  created_at: ago(3000),
  paid_amount: 1000,
  balance: 2298,
  ...by,
})

const MOVE_TYPES = ['sale', 'scan_add', 'purchase', 'transfer', 'adjustment', 'set_total', 'initial_count', 'barcode_unlink']
const movements: Row[] = Array.from({ length: 20 }, (_, i) => ({
  id: `m${i}`,
  created_at: ago(i * 90),
  type: MOVE_TYPES[i % MOVE_TYPES.length],
  delta: i % 2 ? 3 : -1,
  quantity_after: 7,
  note: i % 4 === 0 ? 'Conteo de fin de mes, se encontró caja dañada' : null,
  reverts_movement_id: null,
  product_id: products[i].id,
  barcode: products[i].barcode,
  product_name: products[i].name,
  ...by,
  old_barcode: null,
  cancelled_by_movement_id: i === 5 ? 'mx' : null,
  cancelled_at: i === 5 ? ago(10) : null,
  cancel_note: i === 5 ? 'Error de captura' : null,
  cancelled_by_name: i === 5 ? 'Admin Demo' : null,
  location: i % 3 ? 'store' : 'warehouse',
  purchase_id: null,
  transfer_id: null,
  ticket_id: null,
  lot_numbers: '3, 7',
}))

const purchases: Row[] = Array.from({ length: 5 }, (_, i) => ({
  id: `pu${i}`,
  created_at: ago(i * 2000),
  supplier_id: i % 2 ? 's1' : 's2',
  supplier_name: i % 2 ? 'Distribuidora Kanto' : 'Importadora Mágica del Bajío S.A. de C.V.',
  location: i % 2 ? 'store' : 'warehouse',
  folio: i % 2 ? `F-${1200 + i}` : null,
  note: i === 0 ? 'Llegó una caja abierta' : null,
  total: 12_345.5 + i * 1000,
  status: i === 3 ? 'cancelled' : 'active',
  cancel_reason: i === 3 ? 'Duplicada' : null,
  cancelled_at: i === 3 ? ago(100) : null,
  cancelled_by_name: i === 3 ? 'Admin Demo' : null,
  created_by: ADMIN_ID,
  created_by_name: 'Admin Demo',
  item_count: 3 + i,
  piece_count: 24 + i * 5,
  is_intact: i < 2,
}))

const transfers: Row[] = Array.from({ length: 4 }, (_, i) => ({
  id: `tr${i}`,
  created_at: ago(i * 1500),
  from_location: i % 2 ? 'store' : 'warehouse',
  to_location: i % 2 ? 'warehouse' : 'store',
  note: i === 0 ? 'Reabasto para torneo del sábado' : null,
  created_by: ADMIN_ID,
  created_by_name: 'Admin Demo',
  item_count: 2 + i,
  piece_count: 10 + i,
}))

const tables: Record<string, Row[]> = {
  ...singles.tables,
  products: products as unknown as Row[],
  product_costs: products.map((p) => ({ product_id: p.id, cost: p.cost })),
  profiles: [
    { id: ADMIN_ID, email: 'admin@demo.mx', full_name: 'Admin Demo', role: 'admin', created_at: ago(99_999) },
    { id: COUNTER_ID, email: 'mostrador@demo.mx', full_name: 'Mariana López Gutiérrez', role: 'mostrador', created_at: ago(9999) },
    { id: 'demo-3', email: 'fines.de.semana.turno.extra@demo.mx', full_name: null, role: 'mostrador', created_at: ago(999) },
  ],
  app_settings: [{ id: true, business_name: 'Demo', internal_code_prefix: 'DEMO', combo_drinks_category: 'Accesorios', initial_load_open: true }],
  product_categories: [
    { id: 'k1', parent_id: null, name: 'TCG', catalog_sources: [], sort_order: 1 },
    { id: 'k1a', parent_id: 'k1', name: 'Pokémon', catalog_sources: ['pokemon'], sort_order: 1 },
    { id: 'k1b', parent_id: 'k1', name: 'Magic', catalog_sources: ['magic'], sort_order: 2 },
    { id: 'k1c', parent_id: 'k1', name: 'Yu-Gi-Oh!', catalog_sources: ['yugioh'], sort_order: 3 },
    { id: 'k1d', parent_id: 'k1', name: 'One Piece', catalog_sources: ['one-piece'], sort_order: 4 },
    { id: 'k1e', parent_id: 'k1', name: 'Lorcana', catalog_sources: ['lorcana'], sort_order: 5 },
    { id: 'k2', parent_id: null, name: 'Accesorios', catalog_sources: [], sort_order: 2 },
    { id: 'k3', parent_id: null, name: 'Cafetería', catalog_sources: [], sort_order: 3 },
  ],
  customers,
  customer_credit_balances: customers.map((c, i) => ({ customer_id: c.id, earned: i * 150, used: i * 40, balance: i * 110 })),
  customer_league_totals: customers.map((c, i) => ({ customer_id: c.id, points: i * 7 })),
  credit_movement_history: [0, 1, 2].map((i) => ({
    id: `cm${i}`,
    customer_id: 'c1',
    kind: i % 2 ? 'sale' : 'grant',
    amount: 100 + i * 25,
    note: i === 0 ? 'Premio 1er lugar torneo regional' : null,
    ticket_id: i % 2 ? 't1' : null,
    ticket_name: i % 2 ? '139' : null,
    batch_id: null,
    created_at: ago(i * 3000),
    ...by,
  })),
  league_points_history: [0, 1, 2].map((i) => ({
    id: `lp${i}`,
    customer_id: 'c1',
    points: 3 + i,
    note: `Liga Pokémon semana ${i + 1}`,
    awarded_on: day(i * 7),
    batch_id: null,
    created_at: ago(i * 9000),
    ...by,
  })),
  sales_history: sales,
  open_tickets: [],
  open_ticket_lines: [],
  tickets: sales,
  sales_payments: sales.filter((s) => s.id !== 'pre1').map((s) => ({ method: s.payment_method === 'mixed' ? 'cash' : s.payment_method, amount: s.total, paid_at: s.paid_at })),
  ticket_payments: sales.filter((s) => s.id !== 'pre1').map((s, i) => ({
    id: `tp${i}`,
    ticket_id: s.id,
    method: s.payment_method === 'mixed' ? 'cash' : s.payment_method,
    amount: s.total,
    paid_at: s.paid_at,
    kind: 'payment',
  })),
  ticket_items: sales.filter((s) => s.id !== 'pre1').flatMap((s, t) =>
    products.slice(t % 10, (t % 10) + (s.item_count as number)).map((p, i) => ({
      id: `ti${t}-${i}`,
      ticket_id: s.id,
      product_id: p.id,
      barcode: p.barcode,
      product_name: p.name,
      quantity: 1,
      unit_price: p.price,
      line_total: p.price,
      position: i,
    })),
  ),
  movement_history: movements,
  suppliers: [
    { id: 's1', name: 'Distribuidora Kanto', contact: null, note: null },
    { id: 's2', name: 'Importadora Mágica del Bajío S.A. de C.V.', contact: null, note: null },
  ],
  purchase_history: purchases,
  purchase_item_details: purchases.flatMap((pu) =>
    products.slice(0, 4).map((p, i) => ({
      id: `${pu.id}-${i}`,
      purchase_id: pu.id,
      position: i,
      product_id: p.id,
      barcode: p.barcode,
      product_name: p.name,
      quantity: 6,
      unit_cost: p.cost,
      line_total: (p.cost ?? 0) * 6,
      lot_number: 10 + i,
    })),
  ),
  transfer_history: transfers,
  transfer_item_lots: transfers.flatMap((tr) =>
    products.slice(0, 3).map((p, i) => ({
      transfer_id: tr.id,
      product_id: p.id,
      barcode: p.barcode,
      product_name: p.name,
      lot_id: `l${i}`,
      lot_number: 4 + i,
      quantity: 3,
      unit_cost: p.cost,
      supplier_name: 'Distribuidora Kanto',
      received_at: ago(5000),
    })),
  ),
  product_lots: products.flatMap((p, i) =>
    [
      { location: 'store', quantity: p.quantity },
      { location: 'warehouse', quantity: p.warehouse_quantity },
    ]
      .filter((l) => l.quantity > 0)
      .map((l, j) => ({
        lot_id: `l${i}-${j}`,
        number: i * 2 + j + 1,
        product_id: p.id,
        location: l.location,
        quantity: l.quantity,
        received_quantity: l.quantity + 2,
        unit_cost: p.cost,
        supplier_id: 's1',
        supplier_name: 'Distribuidora Kanto',
        origin: j ? 'purchase' : 'initial',
        entry_location: l.location,
        received_at: ago(3000 * (j + 1)),
        purchase_id: j ? 'pu1' : null,
        purchase_folio: j ? 'F-1201' : null,
      })),
  ),
  catalog_products: [],
}

// Renglón de la preventa de ejemplo (Booster Box en preventa, 2 piezas).
tables.ticket_items.push({
  id: 'pre1-0', ticket_id: 'pre1', product_id: 'p1', barcode: products[1].barcode, product_name: products[1].name,
  quantity: 2, unit_price: 1649, line_total: 3298, position: 1, preorder: true, parent_item_id: null,
})
tables.ticket_payments.push({ id: 'pre1-pay', ticket_id: 'pre1', method: 'cash', amount: 1000, paid_at: ago(3000), kind: 'payment' })

// ---------- RPC ----------
let nextFolio = 141

/** Movimiento de inventario simulado (escaneos, altas, compras). */
function demoMovement(p: Product, location: string, delta: number, type: string, note: string | null) {
  const store = location !== 'warehouse'
  if (store) p.quantity += delta
  else p.warehouse_quantity = (p.warehouse_quantity ?? 0) + delta
  const id = crypto.randomUUID()
  movements.unshift({
    id,
    created_at: new Date().toISOString(),
    type,
    delta,
    quantity_after: store ? p.quantity : p.warehouse_quantity,
    note,
    reverts_movement_id: null,
    product_id: p.id,
    barcode: p.barcode,
    product_name: p.name,
    old_barcode: null,
    cancelled_by_movement_id: null,
    cancelled_at: null,
    cancel_note: null,
    location,
    ...by,
  })
  return { status: 'ok', movement_id: id, movement_type: type, location, delta, quantity_after: store ? p.quantity : p.warehouse_quantity, product: p }
}

const initialLoadOpen = () => tables.app_settings[0]?.initial_load_open !== false

const rpcs: Record<string, (args: Row) => unknown> = {
  ...singles.rpcs,
  register_scan: (a) => {
    const p = products.find((x) => x.barcode === String(a.p_barcode).trim())
    if (!p) return { status: 'not_found', barcode: a.p_barcode }
    const reason = typeof a.p_reason === 'string' ? a.p_reason.trim() : ''
    if (!reason && !initialLoadOpen()) throw new Error('El inventario inicial ya se cerró: indica el motivo del conteo o ajuste')
    const location = String(a.p_location ?? 'store')
    const current = location === 'warehouse' ? (p.warehouse_quantity ?? 0) : p.quantity
    const next = a.p_mode === 'add' ? current + Number(a.p_quantity) : Number(a.p_quantity)
    const type = reason ? 'adjustment' : a.p_mode === 'add' ? 'scan_add' : 'set_total'
    const note = reason ? `${a.p_mode === 'add' ? 'Conteo (sumar)' : 'Conteo (fijar total)'}. Motivo: ${reason}` : null
    return demoMovement(p, location, next - current, type, note)
  },
  create_product: (a) => {
    const barcode = a.p_barcode ? String(a.p_barcode).trim() : `DEMO-${String(products.length + 1).padStart(5, '0')}`
    const existing = products.find((x) => x.barcode === barcode)
    if (existing) return { status: 'exists', product: existing }
    const qty = Number(a.p_initial_quantity ?? 0)
    if (qty > 0 && !initialLoadOpen()) throw new Error('El inventario inicial ya se cerró: la mercancía nueva entra por Compras')
    const p = {
      ...products[2],
      id: crypto.randomUUID(),
      barcode,
      name: String(a.p_name),
      price: Number(a.p_price),
      cost: a.p_cost == null ? null : Number(a.p_cost),
      category: (a.p_category as string) || null,
      quantity: 0,
      warehouse_quantity: 0,
      image_url: null,
      is_internal_code: !a.p_barcode,
      is_preorder: false,
      is_combo: false,
      language: (a.p_language as Product['language']) ?? null,
      created_at: new Date().toISOString(),
    } as Product
    products.push(p)
    return demoMovement(p, String(a.p_location ?? 'store'), qty, 'initial_count', 'Alta de producto')
  },
  register_purchase: (a) => {
    if (purchases.some((x) => x.id === a.p_purchase_id)) return { status: 'duplicate' }
    const items = (a.p_items as { product_id: string; quantity: number; unit_cost: number }[]) ?? []
    const location = String(a.p_location ?? 'store')
    const supplier = tables.suppliers.find((x) => x.id === a.p_supplier_id)
    for (const it of items) {
      const p = products.find((x) => x.id === it.product_id)
      if (p) demoMovement(p, location, it.quantity, 'purchase', `Compra · ${supplier?.name ?? ''}`)
    }
    const purchase = {
      id: a.p_purchase_id,
      created_at: new Date().toISOString(),
      supplier_id: a.p_supplier_id,
      supplier_name: supplier?.name ?? '—',
      location,
      folio: a.p_folio ?? null,
      note: a.p_note ?? null,
      total: items.reduce((n, i) => n + i.quantity * i.unit_cost, 0),
      status: 'active',
      cancel_reason: null,
      cancelled_at: null,
      cancelled_by_name: null,
      created_by: ADMIN_ID,
      created_by_name: 'Admin Demo',
      item_count: items.length,
      piece_count: items.reduce((n, i) => n + i.quantity, 0),
      is_intact: true,
    }
    purchases.unshift(purchase)
    return { status: 'ok', purchase }
  },
  catalog_status: () => ({ total: 0, updated_at: null, games: [] }),
  search_catalog: () => [],
  checkout_ticket: (a) => {
    const items = (a.p_items as { product_id: string; quantity: number; unit_price: number; choice_product_id: string | null }[]) ?? []
    const payments = (a.p_payments as { method: string; amount: number }[]) ?? []
    const touched: Product[] = []
    let preorder = false
    for (const it of items) {
      for (const id of [it.product_id, it.choice_product_id]) {
        const p = products.find((x) => x.id === id)
        if (!p) continue
        if (p.is_preorder) preorder = true
        else if (p.track_stock) p.quantity = Math.max(0, p.quantity - it.quantity)
        touched.push(p)
      }
    }
    const total = items.reduce((s, it) => s + it.quantity * it.unit_price, 0)
    const paid = payments.reduce((s, p) => s + p.amount, 0)
    const ticket = {
      id: a.p_ticket_id,
      number: nextFolio,
      name: String(nextFolio++),
      status: preorder ? 'preorder' : 'paid',
      customer_id: a.p_customer_id ?? null,
      payment_method: payments.length > 1 ? 'mixed' : (payments[0]?.method ?? 'cash'),
      item_count: items.reduce((s, it) => s + it.quantity, 0),
      subtotal: total,
      total,
      paid_offline: false,
      note: null,
      notes: a.p_notes ?? null,
      opened_at: a.p_opened_at ?? null,
      paid_at: preorder ? null : new Date().toISOString(),
      created_at: new Date().toISOString(),
    }
    const customer = customers.find((c) => c.id === ticket.customer_id)
    sales.unshift({
      ...ticket,
      customer_name: customer?.name ?? a.p_customer_name ?? null,
      customer_is_free_name: !customer && !!a.p_customer_name,
      paid_amount: paid,
      balance: total - paid,
      ...by,
    })
    for (const p of payments) {
      tables.ticket_payments.push({ id: crypto.randomUUID(), ticket_id: ticket.id, method: p.method, amount: p.amount, paid_at: new Date().toISOString(), kind: 'payment' })
    }
    items.forEach((it, position) => {
      const p = products.find((x) => x.id === it.product_id)
      const c = products.find((x) => x.id === it.choice_product_id)
      const id = crypto.randomUUID()
      const row = { ticket_id: ticket.id, quantity: it.quantity, position }
      tables.ticket_items.push({ ...row, id, product_id: p?.id, barcode: p?.barcode, product_name: p?.name, unit_price: it.unit_price, line_total: it.quantity * it.unit_price, preorder: !!p?.is_preorder, parent_item_id: null })
      if (c) tables.ticket_items.push({ ...row, id: crypto.randomUUID(), product_id: c.id, barcode: c.barcode, product_name: c.name, unit_price: 0, line_total: 0, preorder: false, parent_item_id: id })
    })
    tables.open_tickets = tables.open_tickets.filter((t) => t.id !== a.p_ticket_id)
    tables.open_ticket_lines = tables.open_ticket_lines.filter((l) => l.ticket_id !== a.p_ticket_id)
    return { status: 'ok', ticket, products: touched, balance: total - paid }
  },
  add_ticket_payment: (a) => {
    const sale = sales.find((x) => x.id === a.p_ticket_id)
    if (!sale) return { status: 'ok', ticket: null, products: [], balance: 0 }
    const payments = (a.p_payments as { method: string; amount: number }[]) ?? []
    const paid = payments.reduce((s, p) => s + p.amount, 0)
    for (const p of payments) {
      tables.ticket_payments.push({ id: crypto.randomUUID(), ticket_id: sale.id, method: p.method, amount: p.amount, paid_at: new Date().toISOString(), kind: 'payment' })
    }
    sale.paid_amount = (sale.paid_amount as number) + paid
    sale.balance = (sale.balance as number) - paid
    if (a.p_deliver && (sale.balance as number) <= 0) {
      sale.status = 'paid'
      sale.paid_at = new Date().toISOString()
    }
    return { status: 'ok', ticket: sale, products: [], balance: sale.balance }
  },
  cancel_ticket: (a) => {
    const sale = sales.find((x) => x.id === a.p_ticket_id)
    if (sale) Object.assign(sale, { status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: a.p_reason ?? null, balance: 0 })
    return { status: 'ok', ticket: sale, products: [] }
  },
  cancel_open_ticket: (a) => {
    tables.open_tickets = tables.open_tickets.filter((t) => t.id !== a.p_ticket_id)
    return { status: 'ok' }
  },
  pay_ticket: (a) => {
    const items = (a.p_items as { barcode: string; quantity: number; unit_price: number }[]) ?? []
    const touched: Product[] = []
    for (const it of items) {
      const p = products.find((x) => x.barcode === it.barcode)
      if (!p) continue
      p.quantity = Math.max(0, p.quantity - it.quantity)
      touched.push(p)
    }
    const total = items.reduce((s, it) => s + it.quantity * it.unit_price, 0)
    const ticket = {
      id: a.p_ticket_id,
      name: String(nextFolio++),
      status: 'paid',
      customer_id: a.p_customer_id ?? null,
      payment_method: a.p_payment_method,
      item_count: items.reduce((s, it) => s + it.quantity, 0),
      subtotal: total,
      total,
      paid_offline: !!a.p_offline,
      note: null,
      opened_at: a.p_opened_at ?? null,
      paid_at: new Date().toISOString(),
    }
    const customer = customers.find((c) => c.id === ticket.customer_id)
    sales.unshift({ ...ticket, customer_name: customer?.name ?? null, ...by })
    return { status: 'ok', ticket, products: touched }
  },
  grant_credits: (a) => {
    const grants = (a.p_grants as { amount: number }[]) ?? []
    return { status: 'ok', count: grants.length, total: grants.reduce((s, g) => s + g.amount, 0) }
  },
  grant_league_points: (a) => {
    const grants = (a.p_grants as { points: number }[]) ?? []
    return { status: 'ok', count: grants.length, total: grants.reduce((s, g) => s + (g.points ?? 0), 0) }
  },
}

// ---------- PostgREST mínimo ----------
const IGNORED = new Set(['select', 'order', 'limit', 'offset', 'or', 'and', 'columns', 'on_conflict'])

function matches(row: Row, params: URLSearchParams) {
  for (const [key, raw] of params) {
    if (IGNORED.has(key)) continue
    const [op, ...rest] = raw.split('.')
    const value = rest.join('.')
    const cell = row[key]
    if (op === 'eq' && String(cell) !== value) return false
    if (op === 'neq' && String(cell) === value) return false
    if (op === 'in' && !value.replace(/^\(|\)$/g, '').split(',').includes(String(cell))) return false
    if ((op === 'ilike' || op === 'like') && !String(cell ?? '').toLowerCase().includes(value.replace(/[%*]/g, '').toLowerCase()))
      return false
  }
  return true
}

function ordered(rows: Row[], order: string | null) {
  if (!order) return rows
  const [col, dir] = order.split(',')[0].split('.')
  const sign = dir === 'desc' ? -1 : 1
  const key = (v: unknown) => (typeof v === 'number' ? v : String(v ?? ''))
  return [...rows].sort((a, b) => (key(a[col]) < key(b[col]) ? -sign : key(a[col]) > key(b[col]) ? sign : 0))
}

function json(body: unknown, status = 200) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function notAvailable(what: string) {
  return json({ code: 'DEMO', message: `"${what}" no está disponible en modo demo.`, details: null, hint: null }, 400)
}

/** fetch que contesta como Supabase; lo usa el cliente cuando VITE_DEMO=1. */
export async function demoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init)
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method.toUpperCase()
  // Un poco de latencia para que se vean los estados de carga.
  await new Promise((r) => setTimeout(r, 150))

  if (path.startsWith('/auth/v1/health')) return json({ ok: true })
  if (path.startsWith('/auth/v1/token')) {
    const body = (await req.json().catch(() => ({}))) as { email?: string }
    if (body.email) role = body.email.toLowerCase().includes('mostrador') ? 'mostrador' : 'admin'
    return json(demoSession())
  }
  if (path.startsWith('/auth/v1/user')) return json(demoUser())
  if (path.startsWith('/auth/v1/logout')) return json(undefined, 204)
  if (path.startsWith('/auth/v1/')) return json({})
  if (path.startsWith('/storage/v1/object/sign/') && method === 'POST') {
    // Supabase arma la URL como <origen>/storage/v1 + signedURL; con "/../.." queda
    // en el archivo que sirve Vite (ver supabase.ts: en demo la URL es el origen).
    const { paths = [] } = (await req.json().catch(() => ({}))) as { paths?: string[] }
    return json(
      paths.map((p) => {
        const file = PHOTOS[`./fotos/${p.replace(/^demo\//, '')}`]
        return { path: p, signedURL: file ? `/../..${file}` : null, error: file ? null : 'not found' }
      }),
    )
  }
  if (path.startsWith('/storage/v1/')) return notAvailable('Subir imágenes')
  if (path.startsWith('/functions/v1/')) return notAvailable(path.split('/').pop() ?? 'función')

  if (path.startsWith('/rest/v1/rpc/')) {
    const name = path.split('/').pop()!
    const fn = rpcs[name]
    if (!fn) return notAvailable(name)
    const args = (await req.json().catch(() => ({}))) as Row
    try {
      return json(fn(args))
    } catch (e) {
      // Como un raise exception de Postgres (no como falla de red).
      return json({ code: '22023', message: (e as Error).message, details: null, hint: null }, 400)
    }
  }

  if (path.startsWith('/rest/v1/')) {
    const name = path.split('/').pop()!
    const rows = (tables[name] ??= [])
    const single = (req.headers.get('accept') ?? '').includes('vnd.pgrst.object')
    const reply = (out: Row[]) => (single ? json(out[0] ?? null) : json(out))

    if (method === 'GET' || method === 'HEAD') {
      let out = ordered(rows.filter((r) => matches(r, url.searchParams)), url.searchParams.get('order'))
      // Único embebido que usa la app: los renglones de los tickets abiertos.
      if (name === 'open_tickets') {
        out = out.map((t) => ({ ...t, open_ticket_lines: tables.open_ticket_lines.filter((l) => l.ticket_id === t.id) }))
      }
      return reply(out)
    }
    if (method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as Row | Row[]
      // Upsert por id (como on_conflict=id).
      const merge = (req.headers.get('prefer') ?? '').includes('resolution=')
      const ignore = (req.headers.get('prefer') ?? '').includes('ignore-duplicates')
      const added: Row[] = []
      for (const r of Array.isArray(body) ? body : [body]) {
        const existing = merge && r.id ? rows.find((x) => x.id === r.id) : undefined
        if (existing) {
          if (!ignore) Object.assign(existing, r, { updated_at: new Date().toISOString() })
          added.push(existing)
          continue
        }
        const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: name === 'open_tickets' ? 'open' : undefined, ...r }
        rows.push(row)
        added.push(row)
      }
      return reply(added)
    }
    if (method === 'PATCH') {
      const patch = (await req.json().catch(() => ({}))) as Row
      const hit = rows.filter((r) => matches(r, url.searchParams))
      for (const r of hit) Object.assign(r, patch, { updated_at: new Date().toISOString() })
      return reply(hit)
    }
    if (method === 'DELETE') {
      const hit = rows.filter((r) => matches(r, url.searchParams))
      tables[name] = rows.filter((r) => !hit.includes(r))
      return reply(hit)
    }
  }
  return notAvailable(path)
}
