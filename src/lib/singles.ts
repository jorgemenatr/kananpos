/*
 * Singles: juegos activos, reglas de precio, búsqueda en el catálogo, alta
 * en inventario y referencias de precio. Todo sale de la base de la tienda
 * (tablas tcg_* que copia el job nocturno); la app nunca llama al proveedor.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  DEFAULT_CONDITION_PERCENTAGES,
  DEFAULT_RULES,
  type CardCondition,
  type PricingRules,
  type Rounding,
} from './pricing'
import { supabase } from './supabase'
import type { Product, ProductLanguage, StockLocation } from './types'

// ---------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------
export type CatalogStatus = 'empty' | 'pending' | 'downloading' | 'ready' | 'error'

export interface TcgGameSetting {
  id: number
  slug: string
  display_name: string
  is_supported: boolean
  sort_order: number
  product_count: number
  catalog_status: CatalogStatus
  status_message: string | null
  status_at: string | null
  prices_as_of: string | null
  last_synced_at: string | null
  enabled: boolean
}

export interface SinglePrice {
  subtype: string
  market_usd: number | null
  mid_usd: number | null
  low_usd: number | null
  fetched_at: string | null
}

export interface SingleSearchResult {
  id: number
  game_id: number
  game_name: string
  set_id: number
  set_name: string
  set_code: string | null
  release_date: string | null
  name: string
  number: string | null
  rarity: string | null
  image_url: string | null
  prices: SinglePrice[]
  prices_as_of: string | null
}

export interface SingleVariant {
  product_id: string
  barcode: string
  tcg_subtype: string
  card_condition: CardCondition
  language: ProductLanguage
  price: number
  quantity: number
  warehouse_quantity: number
}

/** Producto del inventario que es un single, con su precio de referencia. */
export interface SingleReference {
  product_id: string
  barcode: string
  name: string
  price: number
  quantity: number
  warehouse_quantity: number
  language: ProductLanguage | null
  image_url: string | null
  tcg_product_id: number
  tcg_subtype: string
  card_condition: CardCondition
  card_name: string
  card_number: string | null
  set_name: string
  game_id: number
  game_name: string
  market_usd: number | null
  mid_usd: number | null
  price_fetched_at: string | null
  /** Fecha del dato del proveedor (la de la última copia del juego). */
  prices_as_of: string | null
  /** Costo del lote que se vende primero (FIFO). Solo para un admin. */
  fifo_cost: number | null
}

export interface FxRateChange {
  id: number
  old_rate: number | null
  new_rate: number | null
  changed_at: string
  changed_by_name: string | null
  changed_by_email: string | null
}

const n = (v: unknown) => (v == null ? null : Number(v))

// ---------------------------------------------------------------------
// Juegos
// ---------------------------------------------------------------------
export async function listGames(): Promise<TcgGameSetting[]> {
  const { data, error } = await supabase.from('tcg_game_settings').select('*').order('sort_order')
  if (error) throw error
  return (data ?? []) as TcgGameSetting[]
}

/** Piezas en inventario de un juego (aviso antes de desactivarlo). */
export async function gameStock(gameId: number): Promise<number> {
  const { data, error } = await supabase.rpc('tcg_game_stock', { p_game_id: gameId })
  if (error) throw error
  return Number(data ?? 0)
}

export interface SetGameResult {
  catalog_status: CatalogStatus
  stock: number
  /** Se pidió la carga inicial en segundo plano. */
  requested: boolean
  /** Si no se pudo pedir: se descargará en la siguiente actualización nocturna. */
  requestError: string | null
}

export async function setGameEnabled(game: TcgGameSetting, enabled: boolean): Promise<SetGameResult> {
  const { data, error } = await supabase.rpc('set_tcg_game_enabled', { p_game_id: game.id, p_enabled: enabled })
  if (error) throw new Error(error.code === '42501' ? 'Solo un administrador puede cambiar los juegos.' : error.message)
  const r = data as { catalog_status: CatalogStatus; stock: number }
  let requested = false
  let requestError: string | null = null
  if (enabled && r.catalog_status === 'pending') {
    // Carga inicial en segundo plano (Edge Function → job del catálogo).
    const res = await supabase.functions.invoke('activar-juego', { body: { slug: game.slug } })
    if (res.error) {
      // La función contesta { error: "…" } en español; supabase-js lo deja en error.context (la respuesta).
      const ctx = (res.error as { context?: Response }).context
      const body = ctx && typeof ctx.json === 'function' ? ((await ctx.json().catch(() => null)) as { error?: string; message?: string } | null) : null
      requestError = body?.error ?? body?.message ?? 'Se descargará en la próxima actualización automática (05:00).'
    } else requested = true
  }
  return { catalog_status: r.catalog_status, stock: Number(r.stock ?? 0), requested, requestError }
}

// ---------------------------------------------------------------------
// Reglas de precio (una fila por tienda)
// ---------------------------------------------------------------------
export interface PricingRulesInfo extends PricingRules {
  rateUpdatedAt: string | null
  rateUpdatedBy: string | null
}

interface RulesRow {
  usd_mxn_rate: number | null
  multiplier: number
  rounding: Rounding
  condition_percentages: Record<CardCondition, number>
  min_price: number
  review_threshold_pct: number
  rate_updated_at: string | null
  rate_updated_by: string | null
}

const RULES_KEY = 'kanan.reglas-precio'

function loadRules(): PricingRulesInfo {
  try {
    const saved = JSON.parse(localStorage.getItem(RULES_KEY) ?? 'null') as PricingRulesInfo | null
    if (saved) return { ...DEFAULT_RULES, ...saved }
  } catch {
    /* sin caché */
  }
  return { ...DEFAULT_RULES, rateUpdatedAt: null, rateUpdatedBy: null }
}

let rules: PricingRulesInfo = loadRules()
let rulesLoaded = false
const rulesListeners = new Set<() => void>()

function setRules(next: PricingRulesInfo) {
  rules = next
  rulesLoaded = true
  try {
    localStorage.setItem(RULES_KEY, JSON.stringify(next))
  } catch {
    /* no crítico */
  }
  rulesListeners.forEach((l) => l())
}

function fromRow(r: RulesRow, byName: string | null): PricingRulesInfo {
  return {
    usdMxnRate: n(r.usd_mxn_rate),
    multiplier: Number(r.multiplier ?? 1),
    rounding: r.rounding ?? 'peso',
    conditionPercentages: { ...DEFAULT_CONDITION_PERCENTAGES, ...(r.condition_percentages ?? {}) },
    minPrice: Number(r.min_price ?? 0),
    reviewThresholdPct: Number(r.review_threshold_pct ?? 10),
    rateUpdatedAt: r.rate_updated_at,
    rateUpdatedBy: byName,
  }
}

export async function refreshPricingRules(): Promise<PricingRulesInfo> {
  const { data, error } = await supabase.from('store_pricing_rules').select('*').maybeSingle()
  if (error) throw error
  if (!data) return rules
  const row = data as RulesRow
  let byName: string | null = null
  if (row.rate_updated_by) {
    const { data: p } = await supabase.from('profiles').select('full_name, email').eq('id', row.rate_updated_by).maybeSingle()
    const prof = p as { full_name: string | null; email: string } | null
    byName = prof ? prof.full_name || prof.email : null
  }
  const next = fromRow(row, byName)
  setRules(next)
  return next
}

/** Reglas de precio de la tienda (se cargan una vez; con copia local para el POS). */
export function usePricingRules(): PricingRulesInfo {
  const value = useSyncExternalStore(
    (cb) => {
      rulesListeners.add(cb)
      return () => rulesListeners.delete(cb)
    },
    () => rules,
  )
  useEffect(() => {
    if (!rulesLoaded) {
      rulesLoaded = true
      refreshPricingRules().catch(() => {
        rulesLoaded = false
      })
    }
  }, [])
  return value
}

export async function updatePricingRules(patch: Partial<PricingRules>): Promise<PricingRulesInfo> {
  const row: Record<string, unknown> = {}
  if (patch.usdMxnRate !== undefined) row.usd_mxn_rate = patch.usdMxnRate
  if (patch.multiplier !== undefined) row.multiplier = patch.multiplier
  if (patch.rounding !== undefined) row.rounding = patch.rounding
  if (patch.conditionPercentages !== undefined) row.condition_percentages = patch.conditionPercentages
  if (patch.minPrice !== undefined) row.min_price = patch.minPrice
  if (patch.reviewThresholdPct !== undefined) row.review_threshold_pct = patch.reviewThresholdPct
  const { data, error } = await supabase.from('store_pricing_rules').update(row).eq('id', true).select('id')
  if (error) {
    if (error.code === '23514') throw new Error('Algún valor está fuera de rango. Revisa los campos.')
    throw new Error(error.code === '42501' ? 'Solo un administrador puede cambiar las reglas de precio.' : error.message)
  }
  if (!data?.length) throw new Error('Solo un administrador puede cambiar las reglas de precio.')
  return refreshPricingRules()
}

export async function fxRateHistory(limit = 20): Promise<FxRateChange[]> {
  const { data, error } = await supabase
    .from('fx_rate_history')
    .select('id, old_rate, new_rate, changed_at, changed_by_name, changed_by_email')
    .order('changed_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return ((data ?? []) as FxRateChange[]).map((r) => ({ ...r, old_rate: n(r.old_rate), new_rate: n(r.new_rate) }))
}

// ---------------------------------------------------------------------
// Catálogo e inventario
// ---------------------------------------------------------------------
export async function searchSingles(query: string, gameId: number | null = null, limit = 30): Promise<SingleSearchResult[]> {
  const { data, error } = await supabase.rpc('search_singles', { p_query: query, p_game_id: gameId, p_limit: limit })
  if (error) throw error
  return ((data ?? []) as SingleSearchResult[]).map((r) => ({
    ...r,
    prices: (r.prices ?? []).map((p) => ({ ...p, market_usd: n(p.market_usd), mid_usd: n(p.mid_usd), low_usd: n(p.low_usd) })),
  }))
}

export async function singleVariants(tcgProductId: number): Promise<SingleVariant[]> {
  const { data, error } = await supabase.rpc('single_variants', { p_tcg_product_id: tcgProductId })
  if (error) throw error
  return ((data ?? []) as SingleVariant[]).map((v) => ({ ...v, price: Number(v.price) }))
}

export interface AddSingleInput {
  opId: string
  tcgProductId: number
  subtype: string
  condition: CardCondition
  language: ProductLanguage
  quantity: number
  unitCost: number | null
  supplierId: string | null
  location: StockLocation
  /** Precio de venta: solo se usa si la variante es nueva. */
  price: number | null
  folio?: string | null
}

export async function addSingleStock(i: AddSingleInput): Promise<{ status: 'ok' | 'duplicate'; created: boolean; product: Product }> {
  const { data, error } = await supabase.rpc('add_single_stock', {
    p_op_id: i.opId,
    p_tcg_product_id: i.tcgProductId,
    p_subtype: i.subtype,
    p_condition: i.condition,
    p_language: i.language,
    p_quantity: i.quantity,
    p_unit_cost: i.unitCost,
    p_supplier_id: i.supplierId,
    p_location: i.location,
    p_price: i.price,
    p_folio: i.folio?.trim() || null,
  })
  if (error) throw new Error(error.code === '42501' ? 'Solo un administrador puede dar de alta singles.' : error.message)
  clearSingleRefs()
  return data as { status: 'ok' | 'duplicate'; created: boolean; product: Product }
}

function normRef(r: SingleReference): SingleReference {
  return { ...r, price: Number(r.price), market_usd: n(r.market_usd), mid_usd: n(r.mid_usd), fifo_cost: n(r.fifo_cost) }
}

/** Referencia de precio de productos del inventario (máx. 200), o de todos los singles (null, solo admin). */
export async function singlesReference(productIds: string[] | null): Promise<SingleReference[]> {
  const { data, error } = await supabase.rpc('singles_reference', { p_product_ids: productIds })
  if (error) throw error
  return ((data ?? []) as SingleReference[]).map(normRef)
}

export interface ApplyPriceItem {
  product_id: string
  price: number
  /** Precio que tenía cuando se calculó (si otro lo cambió, no se toca). */
  expected_price: number
}

export async function applySinglePrices(items: ApplyPriceItem[]): Promise<{ applied: number; skipped: { product_id: string; reason: string }[] }> {
  const { data, error } = await supabase.rpc('apply_single_prices', { p_items: items })
  if (error) throw new Error(error.code === '42501' ? 'Solo un administrador puede aplicar precios.' : error.message)
  clearSingleRefs()
  return data as { applied: number; skipped: { product_id: string; reason: string }[] }
}

// ---------------------------------------------------------------------
// Caché de referencias por producto (POS y ficha)
// ---------------------------------------------------------------------
const REF_TTL = 10 * 60_000
const refCache = new Map<string, { ref: SingleReference | null; at: number }>()
const refListeners = new Set<() => void>()
let refVersion = 0

export function clearSingleRefs() {
  refCache.clear()
  refVersion++
  refListeners.forEach((l) => l())
}

let pendingIds = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function requestRefs(ids: string[]) {
  const now = Date.now()
  for (const id of ids) {
    const c = refCache.get(id)
    if (!c || now - c.at > REF_TTL) pendingIds.add(id)
  }
  if (!pendingIds.size || flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const batch = [...pendingIds].slice(0, 200)
    pendingIds = new Set([...pendingIds].slice(200))
    singlesReference(batch)
      .then((rows) => {
        const at = Date.now()
        const got = new Map(rows.map((r) => [r.product_id, r]))
        for (const id of batch) refCache.set(id, { ref: got.get(id) ?? null, at })
      })
      .catch(() => {
        // Sin red: se reintenta en el siguiente render que lo pida.
      })
      .finally(() => {
        refVersion++
        refListeners.forEach((l) => l())
        if (pendingIds.size) requestRefs([])
      })
  }, 30)
}

/** Referencia de precio de los singles de una lista de productos (los que no son single quedan fuera). */
export function useSingleRefs(productIds: string[]): Map<string, SingleReference> {
  const version = useSyncExternalStore(
    (cb) => {
      refListeners.add(cb)
      return () => refListeners.delete(cb)
    },
    () => refVersion,
  )
  const key = productIds.join(',')
  useEffect(() => {
    if (key) requestRefs(key.split(','))
  }, [key, version])
  const [map, setMap] = useState(new Map<string, SingleReference>())
  useEffect(() => {
    const m = new Map<string, SingleReference>()
    for (const id of key ? key.split(',') : []) {
      const r = refCache.get(id)?.ref
      if (r) m.set(id, r)
    }
    setMap(m)
  }, [key, version])
  return map
}

// ---------------------------------------------------------------------
// Historial de precios (USD) de un producto del inventario
// ---------------------------------------------------------------------
export interface PriceHistoryRow {
  price_date: string
  market_usd: number | null
  mid_usd: number | null
}

/** Cambios del precio de referencia de un single (más reciente primero). Base sin la migración: []. */
export async function productPriceHistory(productId: string): Promise<PriceHistoryRow[]> {
  const { data, error } = await supabase.rpc('product_price_history', { p_product_id: productId })
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') return []
    throw error
  }
  return ((data ?? []) as PriceHistoryRow[]).map((r) => ({ ...r, market_usd: n(r.market_usd), mid_usd: n(r.mid_usd) }))
}
