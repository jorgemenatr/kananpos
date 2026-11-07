/*
 * Sincronización del catálogo de singles.
 *
 *   1. Descarga (proveedor → central): solo los juegos que tiene activos al
 *      menos una tienda (o los que se pidan a mano). Si el proveedor no se ha
 *      actualizado desde la última corrida buena, no se baja nada. Los
 *      productos de un set solo se vuelven a bajar si el set cambió; los
 *      precios, siempre. Si un set falla, se anota y se sigue con el siguiente.
 *   2. Copia (central → cada tienda): solo sus juegos activos y solo lo que
 *      cambió desde su última copia.
 *
 * Todo es upsert: correrla dos veces no duplica nada. Cada descarga y cada
 * copia queda en catalog_sync_runs (proyecto central).
 *
 * Las dependencias (proveedor, central, tiendas) llegan como interfaces para
 * poder probarla sin red (sync.test.ts).
 */
import { resolveGames, type CuratedGame, type ResolvedGame } from './games.ts'
import type { PriceProvider, ProviderPrice, ProviderProduct, ProviderSet, UpsertCounts } from './types.ts'

// ---------- central ----------
export interface CentralGame {
  id: number
  slug: string
  external_id: number | null
  name: string
  display_name: string
  is_supported: boolean
  sort_order: number
  source_updated_at: string | null
}

export interface CentralSet {
  id: number
  external_id: number
  name: string
  source_modified_on: string | null
  products_modified_on: string | null
  product_count: number
}

export interface CopySet {
  id: number
  game_id: number
  external_id: number
  name: string
  abbreviation: string | null
  release_date: string | null
}

export interface CopyProduct {
  id: number
  game_id: number
  set_id: number
  tcgplayer_product_id: number
  name: string
  clean_name: string | null
  number: string | null
  rarity: string | null
  image_url: string | null
  updated_at: string
}

export interface CopyPrice {
  product_id: number
  subtype: string
  market_usd: number | null
  low_usd: number | null
  mid_usd: number | null
  high_usd: number | null
  fetched_at: string
  updated_at: string
}

export interface HistoryRow {
  product_id: number
  subtype: string
  price_date: string
  market_usd: number | null
  mid_usd: number | null
}

export type RunStatus = 'running' | 'ok' | 'partial' | 'error' | 'skipped'

export interface SetError {
  set: string
  external_id: number
  error: string
}

export interface CentralStore {
  upsertGames(rows: ResolvedGame[]): Promise<CentralGame[]>
  upsertSets(gameId: number, sets: ProviderSet[]): Promise<CentralSet[]>
  upsertProducts(setId: number, products: ProviderProduct[], modifiedOn: string | null): Promise<UpsertCounts>
  upsertPrices(setId: number, prices: ProviderPrice[], source: string, fetchedAt: string): Promise<UpsertCounts>
  startRun(run: { game_id: number; kind: 'download' | 'copy'; target?: string | null; provider?: string | null }): Promise<number>
  finishRun(
    id: number,
    result: { status: RunStatus; counts?: Record<string, number>; errors?: SetError[]; error?: string | null },
  ): Promise<void>
  markGameSynced(gameId: number, sourceUpdatedAt: string | null): Promise<void>
  listSets(gameId: number): Promise<CopySet[]>
  exportProducts(gameId: number, since: string | null, afterId: number, limit: number): Promise<CopyProduct[]>
  exportPrices(
    gameId: number,
    since: string | null,
    afterProductId: number,
    afterSubtype: string,
    limit: number,
  ): Promise<CopyPrice[]>
  /** Historial (solo cambios) de esas cartas desde una fecha (AAAA-MM-DD; null = todo). */
  exportHistory(productIds: number[], since: string | null): Promise<HistoryRow[]>
}

// ---------- tienda ----------
export interface TenantGame {
  id: number
  catalog_status: string
  products_copied_through: string | null
  prices_copied_through: string | null
}

export type TenantGamePatch = Partial<{
  catalog_status: 'empty' | 'pending' | 'downloading' | 'ready' | 'error'
  status_message: string | null
  status_at: string
  product_count: number
  prices_as_of: string | null
  last_synced_at: string
  products_copied_through: string | null
  prices_copied_through: string | null
}>

export interface TenantStore {
  readonly ref: string
  readonly name: string
  /** IDs de juegos activos; null si a la base le falta la migración de singles. */
  enabledGameIds(): Promise<number[] | null>
  upsertGames(games: CentralGame[]): Promise<void>
  getGame(gameId: number): Promise<TenantGame | null>
  updateGame(gameId: number, patch: TenantGamePatch): Promise<void>
  upsertSets(rows: CopySet[]): Promise<void>
  upsertProducts(rows: Omit<CopyProduct, 'updated_at'>[]): Promise<void>
  upsertPrices(rows: Omit<CopyPrice, 'updated_at'>[]): Promise<void>
  countProducts(gameId: number): Promise<number>
  /** Cartas del inventario y si ya tienen historial; null si falta la migración. */
  historyTargets(): Promise<{ tcg_product_id: number; has_history: boolean }[] | null>
  upsertHistory(rows: HistoryRow[]): Promise<void>
}

// ---------- opciones y resultado ----------
export interface SyncOptions {
  /** Slugs a sincronizar. Sin esto: los activos en alguna tienda. */
  games?: string[]
  /** Con una sola tienda (--ref) y juegos: se copian aunque no estén activos. */
  singleTenant?: boolean
  force?: boolean
  skipDownload?: boolean
  skipCopy?: boolean
  log?: (msg: string) => void
  now?: () => Date
}

export interface DownloadSummary {
  slug: string
  status: RunStatus
  counts: Record<string, number>
  errors: SetError[]
  error?: string
}

export interface CopySummary {
  tenant: string
  slug: string
  status: RunStatus
  counts: Record<string, number>
  error?: string
}

export interface SyncSummary {
  sourceUpdatedAt: string | null
  downloads: DownloadSummary[]
  copies: CopySummary[]
  warnings: string[]
}

export interface SyncDeps {
  provider: PriceProvider
  central: CentralStore
  tenants: TenantStore[]
  curated: CuratedGame[]
}

const PRODUCT_CHUNK = 500
const PRICE_CHUNK = 2000
const COPY_PAGE = 1000

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const time = (s: string | null | undefined) => (s ? new Date(s).getTime() : NaN)

function add(target: Record<string, number>, counts: object, prefix: string) {
  for (const [k, v] of Object.entries(counts)) {
    if (typeof v === 'number') target[`${prefix}_${k}`] = (target[`${prefix}_${k}`] ?? 0) + v
  }
}

// =====================================================================
// Orquestación
// =====================================================================
export async function runSync(deps: SyncDeps, opts: SyncOptions = {}): Promise<SyncSummary> {
  const log = opts.log ?? (() => {})
  const now = opts.now ?? (() => new Date())
  const { provider, central, tenants, curated } = deps
  const summary: SyncSummary = { sourceUpdatedAt: null, downloads: [], copies: [], warnings: [] }

  // 1. Juegos: lista curada → IDs del proveedor → central.
  const lastUpdated = await provider.lastUpdated()
  summary.sourceUpdatedAt = lastUpdated?.toISOString() ?? null
  const resolved = resolveGames(curated, await provider.listGames(), provider.id)
  const games = await central.upsertGames(resolved)
  const bySlug = new Map(games.map((g) => [g.slug, g]))
  const byId = new Map(games.map((g) => [g.id, g]))
  for (const s of opts.games ?? []) {
    if (!bySlug.has(s)) throw new Error(`Juego desconocido: "${s}". Disponibles: ${[...bySlug.keys()].join(', ')}`)
  }
  const requested = opts.games?.length ? new Set(opts.games) : null

  // 2. Juegos activos de cada tienda (y la lista de juegos para su Configuración).
  const enabled = new Map<TenantStore, Set<string>>()
  for (const t of tenants) {
    try {
      const ids = await t.enabledGameIds()
      if (ids === null) {
        summary.warnings.push(`${t.name}: le falta la migración de singles; se omite.`)
        continue
      }
      await t.upsertGames(games)
      enabled.set(t, new Set(ids.map((id) => byId.get(id)?.slug).filter((s): s is string => Boolean(s))))
    } catch (e) {
      summary.warnings.push(`${t.name}: ${errMsg(e)}`)
    }
  }

  // 3. Descarga: solo lo que alguna tienda tiene activo (o lo pedido).
  const toDownload = requested ?? new Set([...enabled.values()].flatMap((s) => [...s]))
  if (!opts.skipDownload) {
    for (const g of games) {
      if (!toDownload.has(g.slug)) continue
      if (!g.is_supported) continue
      const d = await downloadGame(provider, central, g, lastUpdated, { force: opts.force, log, now })
      summary.downloads.push(d)
    }
  }
  if (!toDownload.size) log('Ninguna tienda tiene juegos activos: no se descargó nada.')

  // 4. Copia a cada tienda.
  if (!opts.skipCopy) {
    for (const [t, active] of enabled) {
      const slugs = requested
        ? [...requested].filter((s) => active.has(s) || opts.singleTenant)
        : [...active]
      for (const slug of slugs) {
        const g = bySlug.get(slug)
        if (!g) continue
        summary.copies.push(await copyGame(central, t, g, { log, now }))
      }
      // Historial de precios de las cartas que la tienda tiene en inventario.
      try {
        const h = await copyHistory(central, t, { now })
        if (h === null) summary.warnings.push(`${t.name}: le falta la migración del historial de precios; se omite.`)
        else if (h.rows) log(`  → ${t.name}: historial ${JSON.stringify(h)}`)
      } catch (e) {
        summary.warnings.push(`${t.name}: historial de precios: ${errMsg(e)}`)
      }
    }
  }
  return summary
}

const HISTORY_CHUNK = 200
/** Días hacia atrás que se vuelven a copiar del historial de cartas que ya lo tienen. */
const HISTORY_OVERLAP_DAYS = 3

/**
 * Copia el historial de precios de las cartas del inventario de una tienda:
 * completo para las que aún no lo tienen y los últimos días para las demás.
 * Idempotente (upsert por carta + subtipo + fecha). null = falta la migración.
 */
export async function copyHistory(
  central: CentralStore,
  tenant: TenantStore,
  { now = () => new Date() }: { now?: () => Date } = {},
): Promise<{ cards: number; rows: number } | null> {
  const targets = await tenant.historyTargets()
  if (targets === null) return null
  const since = new Date(now().getTime() - HISTORY_OVERLAP_DAYS * 864e5).toISOString().slice(0, 10)
  let rows = 0
  for (const [ids, from] of [
    [targets.filter((t) => !t.has_history).map((t) => t.tcg_product_id), null],
    [targets.filter((t) => t.has_history).map((t) => t.tcg_product_id), since],
  ] as const) {
    for (let i = 0; i < ids.length; i += HISTORY_CHUNK) {
      const page = await central.exportHistory(ids.slice(i, i + HISTORY_CHUNK), from)
      if (page.length) await tenant.upsertHistory(page)
      rows += page.length
    }
  }
  return { cards: targets.length, rows }
}

// =====================================================================
// Descarga de un juego: proveedor → central
// =====================================================================
export async function downloadGame(
  provider: PriceProvider,
  central: CentralStore,
  game: CentralGame,
  lastUpdated: Date | null,
  { force = false, log = () => {}, now = () => new Date() }: { force?: boolean; log?: (m: string) => void; now?: () => Date } = {},
): Promise<DownloadSummary> {
  const counts: Record<string, number> = {}
  const errors: SetError[] = []
  const runId = await central.startRun({ game_id: game.id, kind: 'download', provider: provider.id })

  if (!force && lastUpdated && time(game.source_updated_at) >= lastUpdated.getTime()) {
    log(`${game.display_name}: sin cambios en el proveedor desde ${game.source_updated_at}.`)
    await central.finishRun(runId, { status: 'skipped', counts })
    return { slug: game.slug, status: 'skipped', counts, errors }
  }
  if (game.external_id == null) {
    const error = 'El juego no tiene ID del proveedor.'
    await central.finishRun(runId, { status: 'error', error })
    return { slug: game.slug, status: 'error', counts, errors, error }
  }

  const fetchedAt = (lastUpdated ?? now()).toISOString()
  try {
    const sets = await provider.listSets(game.external_id)
    const stored = new Map((await central.upsertSets(game.id, sets)).map((s) => [s.external_id, s]))
    counts.sets = sets.length
    let done = 0
    for (const set of sets) {
      done++
      const cs = stored.get(set.externalId)
      try {
        if (!cs) throw new Error('el set no quedó guardado')
        const fresh =
          !force && cs.products_modified_on && set.modifiedOn && time(cs.products_modified_on) >= time(set.modifiedOn)
        if (!fresh) {
          const products = await provider.listProducts(game.external_id, set.externalId)
          const singles = products.filter((p) => p.isSingle)
          counts.sealed_skipped = (counts.sealed_skipped ?? 0) + products.length - singles.length
          counts.sets_products = (counts.sets_products ?? 0) + 1
          if (!singles.length) {
            add(counts, await central.upsertProducts(cs.id, [], set.modifiedOn), 'products')
          }
          for (let i = 0; i < singles.length; i += PRODUCT_CHUNK) {
            const last = i + PRODUCT_CHUNK >= singles.length
            const c = await central.upsertProducts(cs.id, singles.slice(i, i + PRODUCT_CHUNK), last ? set.modifiedOn : null)
            add(counts, c, 'products')
          }
          if (!singles.length) continue // set solo de sellado: sin precios que bajar
        } else if (cs.product_count === 0) {
          continue // set sin singles y sin cambios
        }
        const prices = await provider.listPrices(game.external_id, set.externalId)
        for (let i = 0; i < prices.length; i += PRICE_CHUNK) {
          add(counts, await central.upsertPrices(cs.id, prices.slice(i, i + PRICE_CHUNK), provider.id, fetchedAt), 'prices')
        }
      } catch (e) {
        errors.push({ set: set.name, external_id: set.externalId, error: errMsg(e) })
        log(`  ⚠️ ${game.display_name} · ${set.name}: ${errMsg(e)}`)
      }
      if (done % 25 === 0) log(`  ${game.display_name}: ${done}/${sets.length} sets`)
    }
    const status: RunStatus = !errors.length ? 'ok' : errors.length < sets.length ? 'partial' : 'error'
    await central.finishRun(runId, { status, counts, errors })
    // Solo una corrida completa marca el dato como al día (si no, la siguiente reintenta).
    await central.markGameSynced(game.id, status === 'ok' ? fetchedAt : null)
    if (status === 'ok') game.source_updated_at = fetchedAt
    log(`${game.display_name}: ${status} ${JSON.stringify(counts)}${errors.length ? ` · ${errors.length} set(s) con error` : ''}`)
    return { slug: game.slug, status, counts, errors }
  } catch (e) {
    const error = errMsg(e)
    await central.finishRun(runId, { status: 'error', counts, errors, error })
    log(`${game.display_name}: error ${error}`)
    return { slug: game.slug, status: 'error', counts, errors, error }
  }
}

// =====================================================================
// Copia de un juego: central → una tienda (solo lo que cambió)
// =====================================================================
export async function copyGame(
  central: CentralStore,
  tenant: TenantStore,
  game: CentralGame,
  { log = () => {}, now = () => new Date() }: { log?: (m: string) => void; now?: () => Date } = {},
): Promise<CopySummary> {
  const counts: Record<string, number> = {}
  const runId = await central.startRun({ game_id: game.id, kind: 'copy', target: tenant.ref })
  try {
    const current = await tenant.getGame(game.id)
    await tenant.updateGame(game.id, { catalog_status: 'downloading', status_message: null, status_at: now().toISOString() })

    const sets = await central.listSets(game.id)
    await tenant.upsertSets(sets)
    counts.sets = sets.length

    // Productos que cambiaron desde la última copia.
    let productsMark = current?.products_copied_through ?? null
    counts.products = 0
    for (let after = 0; ; ) {
      const page = await central.exportProducts(game.id, current?.products_copied_through ?? null, after, COPY_PAGE)
      if (!page.length) break
      await tenant.upsertProducts(page.map(({ updated_at: _u, ...row }) => row))
      counts.products += page.length
      for (const p of page) if (!productsMark || time(p.updated_at) > time(productsMark)) productsMark = p.updated_at
      after = page[page.length - 1].id
      if (page.length < COPY_PAGE) break
    }

    // Precios que cambiaron desde la última copia.
    let pricesMark = current?.prices_copied_through ?? null
    counts.prices = 0
    for (let afterId = 0, afterSub = ''; ; ) {
      const page = await central.exportPrices(game.id, current?.prices_copied_through ?? null, afterId, afterSub, COPY_PAGE)
      if (!page.length) break
      await tenant.upsertPrices(page.map(({ updated_at: _u, ...row }) => row))
      counts.prices += page.length
      for (const p of page) if (!pricesMark || time(p.updated_at) > time(pricesMark)) pricesMark = p.updated_at
      afterId = page[page.length - 1].product_id
      afterSub = page[page.length - 1].subtype
      if (page.length < COPY_PAGE) break
    }

    const productCount = await tenant.countProducts(game.id)
    await tenant.updateGame(game.id, {
      catalog_status: 'ready',
      status_message: null,
      status_at: now().toISOString(),
      product_count: productCount,
      prices_as_of: game.source_updated_at,
      last_synced_at: now().toISOString(),
      products_copied_through: productsMark,
      prices_copied_through: pricesMark,
    })
    await central.finishRun(runId, { status: 'ok', counts })
    log(`  → ${tenant.name}: ${game.display_name} ${JSON.stringify(counts)}`)
    return { tenant: tenant.ref, slug: game.slug, status: 'ok', counts }
  } catch (e) {
    const error = errMsg(e)
    await tenant
      .updateGame(game.id, { catalog_status: 'error', status_message: error.slice(0, 500), status_at: now().toISOString() })
      .catch(() => {})
    await central.finishRun(runId, { status: 'error', counts, error })
    log(`  → ${tenant.name}: ${game.display_name} error ${error}`)
    return { tenant: tenant.ref, slug: game.slug, status: 'error', counts, error }
  }
}
