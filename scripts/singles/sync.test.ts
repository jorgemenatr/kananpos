import { beforeEach, describe, expect, it } from 'vitest'
import type { CuratedGame, ResolvedGame } from './games.ts'
import {
  copyHistory,
  runSync,
  type HistoryRow,
  type CentralGame,
  type CentralStore,
  type CopyPrice,
  type CopyProduct,
  type CopySet,
  type RunStatus,
  type SetError,
  type TenantGame,
  type TenantGamePatch,
  type TenantStore,
} from './sync.ts'
import type { PriceProvider, ProviderPrice, ProviderProduct, ProviderSet, UpsertCounts } from './types.ts'

// ---------------------------------------------------------------------
// Dobles en memoria
// ---------------------------------------------------------------------
let tick = 0
const stamp = () => new Date(Date.UTC(2026, 10, 7, 0, 0, tick++)).toISOString()

class FakeProvider implements PriceProvider {
  readonly id = 'fake'
  updated = new Date('2026-11-06T20:05:28Z')
  calls: string[] = []
  failingSets = new Set<number>()
  sets: Record<number, ProviderSet[]> = {}
  products: Record<number, ProviderProduct[]> = {}
  prices: Record<number, ProviderPrice[]> = {}

  async lastUpdated() {
    return this.updated
  }
  async listGames() {
    return [
      { externalId: 3, name: 'Pokemon', displayName: 'Pokemon' },
      { externalId: 1, name: 'Magic', displayName: 'Magic: The Gathering' },
      { externalId: 71, name: 'Lorcana TCG', displayName: 'Disney Lorcana' },
    ]
  }
  async listSets(game: number) {
    this.calls.push(`sets:${game}`)
    return this.sets[game] ?? []
  }
  async listProducts(_game: number, set: number) {
    this.calls.push(`products:${set}`)
    if (this.failingSets.has(set)) throw new Error('HTTP 500')
    return this.products[set] ?? []
  }
  async listPrices(_game: number, set: number) {
    this.calls.push(`prices:${set}`)
    return this.prices[set] ?? []
  }
}

const set = (game: number, id: number, modifiedOn = '2026-01-01T00:00:00.000Z'): ProviderSet => ({
  externalId: id,
  gameExternalId: game,
  name: `Set ${id}`,
  abbreviation: null,
  releaseDate: '2026-01-01',
  modifiedOn,
})

const card = (id: number, setId: number, single = true): ProviderProduct => ({
  tcgplayerProductId: id,
  setExternalId: setId,
  name: `Carta ${id}`,
  cleanName: null,
  number: single ? String(id) : null,
  rarity: single ? 'Common' : null,
  imageUrl: null,
  url: null,
  isSingle: single,
  extendedData: {},
  modifiedOn: null,
})

const price = (id: number, market: number | null, subtype = 'Normal'): ProviderPrice => ({
  tcgplayerProductId: id,
  subtype,
  marketUsd: market,
  lowUsd: null,
  midUsd: market,
  highUsd: null,
  directLowUsd: null,
})

class FakeCentral implements CentralStore {
  games: CentralGame[] = []
  sets = new Map<number, { id: number; game_id: number; s: ProviderSet; products_modified_on: string | null }>()
  products = new Map<number, CopyProduct & { sig: string }>()
  prices = new Map<string, CopyPrice & { game_id: number }>()
  runs: { id: number; game_id: number; kind: string; target?: string | null; status?: RunStatus; errors?: SetError[] }[] = []
  history: HistoryRow[] = []

  async upsertGames(rows: ResolvedGame[]) {
    for (const r of rows) {
      const g = this.games.find((x) => x.slug === r.slug)
      if (g) Object.assign(g, { external_id: r.external_id, name: r.name, display_name: r.display_name })
      else this.games.push({ id: this.games.length + 1, ...r, is_supported: true, source_updated_at: null })
    }
    return this.games
  }
  async upsertSets(gameId: number, sets: ProviderSet[]) {
    for (const s of sets) {
      const cur = this.sets.get(s.externalId)
      if (cur) cur.s = s
      else this.sets.set(s.externalId, { id: this.sets.size + 1, game_id: gameId, s, products_modified_on: null })
    }
    return [...this.sets.values()]
      .filter((x) => x.game_id === gameId)
      .map((x) => ({
        id: x.id,
        external_id: x.s.externalId,
        name: x.s.name,
        source_modified_on: x.s.modifiedOn,
        products_modified_on: x.products_modified_on,
        product_count: [...this.products.values()].filter((p) => p.set_id === x.id).length,
      }))
  }
  async upsertProducts(setId: number, products: ProviderProduct[], modifiedOn: string | null): Promise<UpsertCounts> {
    const st = [...this.sets.values()].find((x) => x.id === setId)!
    const c = { inserted: 0, updated: 0, unchanged: 0 }
    for (const p of products) {
      const sig = JSON.stringify([p.name, p.number, p.rarity])
      const cur = this.products.get(p.tcgplayerProductId)
      if (cur && cur.sig === sig) c.unchanged++
      else {
        if (cur) c.updated++
        else c.inserted++
        this.products.set(p.tcgplayerProductId, {
          id: cur?.id ?? p.tcgplayerProductId * 10,
          game_id: st.game_id,
          set_id: setId,
          tcgplayer_product_id: p.tcgplayerProductId,
          name: p.name,
          clean_name: p.cleanName,
          number: p.number,
          rarity: p.rarity,
          image_url: p.imageUrl,
          updated_at: stamp(),
          sig,
        })
      }
    }
    if (modifiedOn) st.products_modified_on = modifiedOn
    return c
  }
  async upsertPrices(setId: number, prices: ProviderPrice[], _source: string, fetchedAt: string): Promise<UpsertCounts> {
    const c = { inserted: 0, updated: 0, unchanged: 0, ignored: 0 }
    for (const p of prices) {
      const prod = this.products.get(p.tcgplayerProductId)
      if (!prod || prod.set_id !== setId) {
        c.ignored++
        continue
      }
      const key = `${prod.id}|${p.subtype}`
      const cur = this.prices.get(key)
      if (cur && cur.market_usd === p.marketUsd && cur.mid_usd === p.midUsd) {
        c.unchanged++
        continue
      }
      if (cur) c.updated++
      else c.inserted++
      // Como el SQL: el historial no guarda filas sin market ni mid.
      if (p.marketUsd != null || p.midUsd != null) this.history.push({ product_id: prod.id, subtype: p.subtype, price_date: fetchedAt.slice(0, 10), market_usd: p.marketUsd, mid_usd: p.midUsd })
      this.prices.set(key, {
        product_id: prod.id,
        game_id: prod.game_id,
        subtype: p.subtype,
        market_usd: p.marketUsd,
        low_usd: p.lowUsd,
        mid_usd: p.midUsd,
        high_usd: p.highUsd,
        fetched_at: fetchedAt,
        updated_at: stamp(),
      })
    }
    return c
  }
  async startRun(run: { game_id: number; kind: 'download' | 'copy'; target?: string | null }) {
    this.runs.push({ id: this.runs.length + 1, ...run })
    return this.runs.length
  }
  async finishRun(id: number, r: { status: RunStatus; errors?: SetError[] }) {
    Object.assign(this.runs[id - 1], { status: r.status, errors: r.errors })
  }
  async markGameSynced(gameId: number, sourceUpdatedAt: string | null) {
    const g = this.games.find((x) => x.id === gameId)!
    if (sourceUpdatedAt) g.source_updated_at = sourceUpdatedAt
  }
  async listSets(gameId: number): Promise<CopySet[]> {
    return [...this.sets.values()]
      .filter((x) => x.game_id === gameId)
      .map((x) => ({ id: x.id, game_id: gameId, external_id: x.s.externalId, name: x.s.name, abbreviation: null, release_date: null }))
  }
  async exportProducts(gameId: number, since: string | null, afterId: number, limit: number) {
    return [...this.products.values()]
      .filter((p) => p.game_id === gameId && (!since || p.updated_at >= since) && p.id > afterId)
      .sort((a, b) => a.id - b.id)
      .slice(0, limit)
      .map(({ sig: _s, ...p }) => p)
  }
  async exportPrices(gameId: number, since: string | null, afterId: number, afterSub: string, limit: number) {
    return [...this.prices.values()]
      .filter(
        (p) =>
          p.game_id === gameId &&
          (!since || p.updated_at >= since) &&
          (p.product_id > afterId || (p.product_id === afterId && p.subtype > afterSub)),
      )
      .sort((a, b) => a.product_id - b.product_id || a.subtype.localeCompare(b.subtype))
      .slice(0, limit)
      .map(({ game_id: _g, ...p }) => p)
  }
  async exportHistory(ids: number[], since: string | null) {
    this.historyCalls.push({ ids: [...ids], since })
    return this.history.filter((h) => ids.includes(h.product_id) && (!since || h.price_date >= since))
  }
  historyCalls: { ids: number[]; since: string | null }[] = []
}

class FakeTenant implements TenantStore {
  readonly ref: string
  readonly name: string
  enabled: number[] | null
  games = new Map<number, TenantGame & TenantGamePatch & { slug: string }>()
  sets = new Map<number, CopySet>()
  products = new Map<number, Omit<CopyProduct, 'updated_at'>>()
  prices = new Map<string, Omit<CopyPrice, 'updated_at'>>()
  writes = { products: 0, prices: 0 }
  /** Cartas (ids del catálogo) que la tienda tiene en inventario. */
  inventory: number[] = []
  history = new Map<string, HistoryRow>()

  constructor(ref: string, enabled: number[] | null) {
    this.ref = ref
    this.name = ref
    this.enabled = enabled
  }
  async enabledGameIds() {
    return this.enabled
  }
  async upsertGames(games: CentralGame[]) {
    for (const g of games) {
      const cur = this.games.get(g.id)
      this.games.set(g.id, {
        ...(cur ?? { catalog_status: 'empty', products_copied_through: null, prices_copied_through: null }),
        id: g.id,
        slug: g.slug,
      })
    }
  }
  async getGame(id: number) {
    return this.games.get(id) ?? null
  }
  async updateGame(id: number, patch: TenantGamePatch) {
    Object.assign(this.games.get(id)!, patch)
  }
  async upsertSets(rows: CopySet[]) {
    for (const r of rows) this.sets.set(r.id, r)
  }
  async upsertProducts(rows: Omit<CopyProduct, 'updated_at'>[]) {
    this.writes.products += rows.length
    for (const r of rows) this.products.set(r.id, r)
  }
  async upsertPrices(rows: Omit<CopyPrice, 'updated_at'>[]) {
    this.writes.prices += rows.length
    for (const r of rows) this.prices.set(`${r.product_id}|${r.subtype}`, r)
  }
  async countProducts(gameId: number) {
    return [...this.products.values()].filter((p) => p.game_id === gameId).length
  }
  async historyTargets() {
    return this.inventory.map((id) => ({ tcg_product_id: id, has_history: [...this.history.values()].some((h) => h.product_id === id) }))
  }
  async upsertHistory(rows: HistoryRow[]) {
    for (const r of rows) this.history.set(`${r.product_id}|${r.subtype}|${r.price_date}`, r)
  }
}

const CURATED: CuratedGame[] = [
  { slug: 'pokemon', nombre: 'Pokémon', proveedor: 'Pokemon' },
  { slug: 'magic', nombre: 'Magic: The Gathering', proveedor: 'Magic' },
  { slug: 'lorcana', nombre: 'Disney Lorcana', proveedor: 'Lorcana TCG' },
]
// ids en el central (orden de la lista curada)
const POKEMON = 1
const MAGIC = 2
const LORCANA = 3

let provider: FakeProvider
let central: FakeCentral

beforeEach(() => {
  tick = 0
  provider = new FakeProvider()
  central = new FakeCentral()
  provider.sets = { 3: [set(3, 100), set(3, 101)], 1: [set(1, 200)], 71: [set(71, 300)] }
  provider.products = {
    100: [card(1, 100), card(2, 100), card(3, 100, false)], // 3 = sellado
    101: [card(4, 101)],
    200: [card(5, 200)],
    300: [card(6, 300)],
  }
  provider.prices = {
    100: [price(1, 9.25), price(1, 20, 'Holofoil'), price(2, null), price(3, 120)],
    101: [price(4, 1.5)],
    200: [price(5, 3)],
    300: [price(6, 0.5)],
  }
})

const deps = (tenants: TenantStore[]) => ({ provider, central, tenants, curated: CURATED })

// ---------------------------------------------------------------------
describe('runSync', () => {
  it('solo descarga los juegos activos en alguna tienda y copia a cada una solo los suyos', async () => {
    const a = new FakeTenant('tienda-a', [POKEMON])
    const b = new FakeTenant('tienda-b', [MAGIC])
    const s = await runSync(deps([a, b]))

    expect(s.downloads.map((d) => d.slug).sort()).toEqual(['magic', 'pokemon'])
    expect(provider.calls).not.toContain('sets:71') // nadie vende Lorcana
    expect(s.copies.map((c) => `${c.tenant}:${c.slug}`)).toEqual(['tienda-a:pokemon', 'tienda-b:magic'])

    // Sellado fuera; precios de sellado ignorados.
    expect([...central.products.keys()].sort()).toEqual([1, 2, 4, 5])
    expect(central.prices.size).toBe(5)
    expect(s.downloads.find((d) => d.slug === 'pokemon')?.counts.sealed_skipped).toBe(1)

    // Cada tienda tiene solo su juego, pero conoce todos los juegos (Configuración).
    expect([...a.products.values()].map((p) => p.tcgplayer_product_id).sort()).toEqual([1, 2, 4])
    expect([...b.products.values()].map((p) => p.tcgplayer_product_id)).toEqual([5])
    expect([...a.games.values()].map((g) => g.slug).sort()).toEqual(['lorcana', 'magic', 'pokemon'])
    expect(a.games.get(POKEMON)).toMatchObject({ catalog_status: 'ready', product_count: 3, prices_as_of: '2026-11-06T20:05:28.000Z' })
    expect(a.games.get(LORCANA)?.catalog_status).toBe('empty')
  })

  it('correrla dos veces no duplica ni vuelve a copiar lo que no cambió', async () => {
    const a = new FakeTenant('tienda-a', [POKEMON])
    await runSync(deps([a]))
    const before = { products: central.products.size, prices: central.prices.size, writes: { ...a.writes } }
    provider.calls = []

    const s = await runSync(deps([a]))
    expect(s.downloads[0].status).toBe('skipped') // el proveedor no cambió
    expect(provider.calls).toEqual([])
    expect(central.products.size).toBe(before.products)
    expect(central.prices.size).toBe(before.prices)
    expect(a.products.size).toBe(3)
    // La copia trae solo la frontera de la marca de agua (>=), nada nuevo.
    expect(a.writes.products - before.writes.products).toBeLessThanOrEqual(1)
    expect(a.writes.prices - before.writes.prices).toBeLessThanOrEqual(1)

    // Forzada: vuelve a bajar todo, sin duplicar.
    const f = await runSync(deps([a]), { force: true })
    expect(f.downloads[0].status).toBe('ok')
    expect(f.downloads[0].counts.products_inserted ?? 0).toBe(0)
    expect(f.downloads[0].counts.prices_inserted ?? 0).toBe(0)
    expect(central.products.size).toBe(before.products)
  })

  it('al día siguiente baja precios de todos los sets, pero productos solo de los sets que cambiaron', async () => {
    const a = new FakeTenant('tienda-a', [POKEMON])
    await runSync(deps([a]))
    provider.calls = []
    provider.updated = new Date('2026-11-07T20:05:00Z')
    provider.sets[3] = [set(3, 100), set(3, 101, '2026-11-07T10:00:00.000Z')]
    provider.products[101] = [card(4, 101), card(7, 101)]
    provider.prices[100] = [price(1, 10), price(1, 20, 'Holofoil'), price(2, null)]
    provider.prices[101] = [price(4, 1.5), price(7, 2)]

    const s = await runSync(deps([a]))
    expect(provider.calls).toEqual(['sets:3', 'prices:100', 'products:101', 'prices:101'])
    expect(s.downloads[0].counts).toMatchObject({ products_inserted: 1, prices_updated: 1, prices_inserted: 1 })
    // La tienda recibe solo lo que cambió.
    // (1 nueva + a lo más la fila de la frontera de la marca de agua, que se repite sin daño).
    expect(s.copies[0].counts.products).toBeLessThanOrEqual(2)
    expect(s.copies[0].counts.prices).toBeLessThanOrEqual(3)
    expect(a.prices.get('10|Normal')?.market_usd).toBe(10)
    expect(a.products.size).toBe(4)
  })

  it('si falla un set lo anota y sigue con el siguiente', async () => {
    provider.failingSets.add(100)
    const a = new FakeTenant('tienda-a', [POKEMON])
    const s = await runSync(deps([a]))
    const d = s.downloads[0]
    expect(d.status).toBe('partial')
    expect(d.errors).toEqual([{ set: 'Set 100', external_id: 100, error: 'HTTP 500' }])
    expect([...central.products.keys()]).toEqual([4]) // el otro set sí entró
    expect(central.runs.find((r) => r.kind === 'download')).toMatchObject({ status: 'partial' })
    // Una corrida parcial no marca el juego como al día: la siguiente reintenta.
    expect(central.games.find((g) => g.slug === 'pokemon')?.source_updated_at).toBeNull()
  })

  it('carga inicial de una tienda (--ref --juego): copia aunque todavía no esté activo', async () => {
    const a = new FakeTenant('tienda-a', [])
    const s = await runSync(deps([a]), { games: ['lorcana'], singleTenant: true })
    expect(s.downloads.map((d) => d.slug)).toEqual(['lorcana'])
    expect(s.copies.map((c) => c.slug)).toEqual(['lorcana'])
    expect(a.games.get(LORCANA)?.catalog_status).toBe('ready')

    // Sin --ref, un juego pedido solo se copia a las tiendas que lo tienen activo.
    const b = new FakeTenant('tienda-b', [])
    const s2 = await runSync(deps([b]), { games: ['lorcana'] })
    expect(s2.copies).toEqual([])
  })

  it('omite (con aviso) una tienda sin la migración de singles', async () => {
    const vieja = new FakeTenant('vieja', null)
    const a = new FakeTenant('tienda-a', [MAGIC])
    const s = await runSync(deps([vieja, a]))
    expect(s.warnings).toEqual(['vieja: le falta la migración de singles; se omite.'])
    expect(s.copies.map((c) => c.tenant)).toEqual(['tienda-a'])
  })

  it('rechaza un juego que no está en la lista curada', async () => {
    await expect(runSync(deps([]), { games: ['uno'] })).rejects.toThrow(/Juego desconocido/)
  })

  it('copia el historial solo de las cartas en inventario: completo para las nuevas, reciente para las demás', async () => {
    const a = new FakeTenant('tienda-a', [POKEMON])
    a.inventory = [10] // carta 1 (id central 10)
    await runSync(deps([a]))
    expect([...a.history.values()].map((h) => [h.product_id, h.subtype]).sort()).toEqual([
      [10, 'Holofoil'],
      [10, 'Normal'],
    ])

    // Al día siguiente cambia el precio: la carta ya tiene historial → solo lo reciente.
    provider.updated = new Date('2026-11-07T20:05:00Z')
    provider.prices[100] = [price(1, 10), price(1, 20, 'Holofoil'), price(2, null)]
    central.historyCalls = []
    a.inventory = [10, 20] // y entra la carta 2 al inventario
    await runSync(deps([a]), { now: () => new Date('2026-11-08T11:00:00Z') })
    expect(central.historyCalls).toEqual([
      { ids: [20], since: null },
      { ids: [10], since: '2026-11-05' },
    ])
    expect(a.history.get('10|Normal|2026-11-07')?.market_usd).toBe(10)
    expect(a.history.size).toBe(3)

    // Idempotente.
    await copyHistory(central, a, { now: () => new Date('2026-11-08T11:00:00Z') })
    expect(a.history.size).toBe(3)
  })

  it('omite el historial (con aviso) si a la tienda le falta la migración', async () => {
    const a = new FakeTenant('tienda-a', [POKEMON])
    a.historyTargets = (async () => null) as unknown as FakeTenant['historyTargets']
    const s = await runSync(deps([a]))
    expect(s.warnings).toEqual(['tienda-a: le falta la migración del historial de precios; se omite.'])
  })
})
