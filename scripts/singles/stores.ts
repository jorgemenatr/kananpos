/*
 * Implementaciones reales de CentralStore y TenantStore sobre PostgREST
 * (service_role). Ver sync.ts para qué hace cada método.
 */
import type { ResolvedGame } from './games.ts'
import { RestError, type RestClient } from './supabase.ts'
import type {
  CentralGame,
  CentralSet,
  CentralStore,
  CopyPrice,
  CopyProduct,
  CopySet,
  HistoryRow,
  RunStatus,
  SetError,
  TenantGame,
  TenantGamePatch,
  TenantStore,
} from './sync.ts'
import type { ProviderPrice, ProviderProduct, ProviderSet, UpsertCounts } from './types.ts'

export class CentralRest implements CentralStore {
  private readonly db: RestClient
  constructor(db: RestClient) {
    this.db = db
  }

  upsertGames(rows: ResolvedGame[]) {
    return this.db.rpc<CentralGame[]>('catalog_upsert_games', { p_rows: rows })
  }

  upsertSets(gameId: number, sets: ProviderSet[]) {
    return this.db.rpc<CentralSet[]>('catalog_upsert_sets', {
      p_game_id: gameId,
      p_rows: sets.map((s) => ({
        external_id: s.externalId,
        name: s.name,
        abbreviation: s.abbreviation,
        release_date: s.releaseDate,
        source_modified_on: s.modifiedOn,
      })),
    })
  }

  upsertProducts(setId: number, products: ProviderProduct[], modifiedOn: string | null) {
    return this.db.rpc<UpsertCounts>('catalog_upsert_products', {
      p_set_id: setId,
      p_modified_on: modifiedOn,
      p_rows: products.map((p) => ({
        tcgplayer_product_id: p.tcgplayerProductId,
        name: p.name,
        clean_name: p.cleanName,
        number: p.number,
        rarity: p.rarity,
        image_url: p.imageUrl,
        url: p.url,
        is_single: p.isSingle,
        extended_data: p.extendedData,
        source_modified_on: p.modifiedOn,
      })),
    })
  }

  upsertPrices(setId: number, prices: ProviderPrice[], source: string, fetchedAt: string) {
    return this.db.rpc<UpsertCounts>('catalog_upsert_prices', {
      p_set_id: setId,
      p_source: source,
      p_fetched_at: fetchedAt,
      p_rows: prices.map((p) => ({
        tcgplayer_product_id: p.tcgplayerProductId,
        subtype: p.subtype,
        market_usd: p.marketUsd,
        low_usd: p.lowUsd,
        mid_usd: p.midUsd,
        high_usd: p.highUsd,
        direct_low_usd: p.directLowUsd,
      })),
    })
  }

  async startRun(run: { game_id: number; kind: 'download' | 'copy'; target?: string | null; provider?: string | null }) {
    const row = await this.db.insert<{ id: number }>('catalog_sync_runs', { ...run })
    return row.id
  }

  async finishRun(
    id: number,
    r: { status: RunStatus; counts?: Record<string, number>; errors?: SetError[]; error?: string | null },
  ) {
    await this.db.patch('catalog_sync_runs', `id=eq.${id}`, {
      status: r.status,
      counts: r.counts ?? {},
      errors: r.errors ?? [],
      error: r.error ?? null,
      finished_at: new Date().toISOString(),
    })
  }

  async markGameSynced(gameId: number, sourceUpdatedAt: string | null) {
    await this.db.patch('tcg_games', `id=eq.${gameId}`, {
      last_synced_at: new Date().toISOString(),
      ...(sourceUpdatedAt ? { source_updated_at: sourceUpdatedAt } : {}),
    })
  }

  listSets(gameId: number) {
    return this.db.select<CopySet>(
      `tcg_sets?select=id,game_id,external_id,name,abbreviation,release_date&game_id=eq.${gameId}&order=id`,
    )
  }

  exportProducts(gameId: number, since: string | null, afterId: number, limit: number) {
    return this.db.rpc<CopyProduct[]>('catalog_export_products', {
      p_game_id: gameId,
      p_since: since,
      p_after_id: afterId,
      p_limit: limit,
    })
  }

  exportPrices(gameId: number, since: string | null, afterProductId: number, afterSubtype: string, limit: number) {
    return this.db.rpc<CopyPrice[]>('catalog_export_prices', {
      p_game_id: gameId,
      p_since: since,
      p_after_product_id: afterProductId,
      p_after_subtype: afterSubtype,
      p_limit: limit,
    })
  }

  exportHistory(productIds: number[], since: string | null) {
    return this.db.rpc<HistoryRow[]>('catalog_export_history', { p_product_ids: productIds, p_since: since })
  }
}

export class TenantRest implements TenantStore {
  readonly ref: string
  readonly name: string
  private readonly db: RestClient

  constructor(ref: string, name: string, db: RestClient) {
    this.ref = ref
    this.name = name
    this.db = db
  }

  async enabledGameIds(): Promise<number[] | null> {
    try {
      const rows = await this.db.select<{ game_id: number }>('store_tcg_settings?select=game_id&enabled=is.true')
      return rows.map((r) => r.game_id)
    } catch (e) {
      // Tabla inexistente: la base aún no tiene la migración de singles.
      if (e instanceof RestError && (e.status === 404 || e.code === 'PGRST205' || e.code === '42P01')) return null
      throw e
    }
  }

  async upsertGames(games: CentralGame[]) {
    // Solo los datos del juego: el estado y las marcas de copia son de la tienda.
    await this.db.upsert(
      'tcg_games',
      games.map((g) => ({
        id: g.id,
        slug: g.slug,
        name: g.name,
        display_name: g.display_name,
        is_supported: g.is_supported,
        sort_order: g.sort_order,
      })),
      'id',
    )
  }

  async getGame(gameId: number) {
    const rows = await this.db.select<TenantGame>(
      `tcg_games?select=id,catalog_status,products_copied_through,prices_copied_through&id=eq.${gameId}`,
    )
    return rows[0] ?? null
  }

  async updateGame(gameId: number, patch: TenantGamePatch) {
    await this.db.patch('tcg_games', `id=eq.${gameId}`, patch)
  }

  upsertSets(rows: CopySet[]) {
    return this.db.upsert('tcg_sets', rows as unknown as Record<string, unknown>[], 'id')
  }

  upsertProducts(rows: Omit<CopyProduct, 'updated_at'>[]) {
    return this.db.upsert('tcg_products', rows as unknown as Record<string, unknown>[], 'id')
  }

  upsertPrices(rows: Omit<CopyPrice, 'updated_at'>[]) {
    return this.db.upsert('tcg_prices', rows as unknown as Record<string, unknown>[], 'product_id,subtype')
  }

  countProducts(gameId: number) {
    return this.db.count('tcg_products', `game_id=eq.${gameId}`)
  }

  async historyTargets() {
    try {
      return await this.db.rpc<{ tcg_product_id: number; has_history: boolean }[]>('tcg_history_targets', {})
    } catch (e) {
      if (e instanceof RestError && (e.status === 404 || e.code === 'PGRST202' || e.code === '42883')) return null
      throw e
    }
  }

  upsertHistory(rows: HistoryRow[]) {
    return this.db.upsert('tcg_price_history', rows as unknown as Record<string, unknown>[], 'product_id,subtype,price_date')
  }
}
