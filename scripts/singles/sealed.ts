/*
 * Catálogo de PRODUCTO SELLADO y accesorios a través del catálogo central.
 *
 *   1. Junta las fuentes (src/lib/catalogSources.json) que usa cada tienda
 *      (ligadas a sus categorías: enabled_catalog_sources).
 *   2. Las descarga UNA vez de TCGCSV al central con
 *      scripts/importar-catalogo.mjs --central (antes se bajaba una vez por
 *      tienda).
 *   3. Copia a cada tienda solo las filas de sus fuentes (upsert por id:
 *      repetirlo no duplica y nunca borra, así que los vínculos con el
 *      inventario no se pierden).
 */

export interface SealedRow {
  id: number
  category_id: number
  game: string
  source: string | null
  group_id: number
  set_name: string | null
  set_code: string | null
  name: string
  description: string | null
  image_url: string | null
  upc: string | null
  market_price: number | null
  released_on: string | null
  tcgplayer_url: string | null
  source_modified_on: string | null
  imported_at: string
}

export const SEALED_COLUMNS =
  'id,category_id,game,source,group_id,set_name,set_code,name,description,image_url,upc,market_price,released_on,tcgplayer_url,source_modified_on,imported_at'

/** Fuentes de las bases sin categorías configurables (antes de 20261020000200). */
export const LEGACY_SOURCES = ['pokemon', 'magic', 'yugioh', 'lorcana', 'flesh-and-blood', 'dragon-shield', 'ultra-pro-pokemon']

export interface SealedCentral {
  /** Página de filas de una fuente, en orden de id. */
  page(source: string, afterId: number, limit: number): Promise<SealedRow[]>
}

export interface SealedTenant {
  readonly ref: string
  readonly name: string
  /** Fuentes ligadas a sus categorías; null = base sin categorías configurables. */
  enabledSources(): Promise<string[] | null>
  upsert(rows: Record<string, unknown>[]): Promise<void>
}

export interface SealedPlan {
  /** Fuentes a descargar al central (las de todas las tiendas, o las pedidas). */
  download: string[]
  /** Por tienda: fuentes a copiar y si su tabla tiene la columna source. */
  tenants: { tenant: SealedTenant; sources: string[]; withSource: boolean }[]
  warnings: string[]
}

export async function planSealed(tenants: SealedTenant[], known: Set<string>, only?: string[]): Promise<SealedPlan> {
  const plan: SealedPlan = { download: [], tenants: [], warnings: [] }
  const all = new Set<string>()
  for (const t of tenants) {
    try {
      const configured = await t.enabledSources()
      let sources = configured ?? LEGACY_SOURCES
      const unknown = sources.filter((s) => !known.has(s))
      if (unknown.length) plan.warnings.push(`${t.name}: fuentes desconocidas (se ignoran): ${unknown.join(', ')}`)
      sources = sources.filter((s) => known.has(s))
      if (only) sources = sources.filter((s) => only.includes(s))
      sources.forEach((s) => all.add(s))
      plan.tenants.push({ tenant: t, sources, withSource: configured !== null })
    } catch (e) {
      plan.warnings.push(`${t.name}: ${(e as Error).message}`)
    }
  }
  plan.download = only ? only.filter((s) => known.has(s)) : [...all].sort()
  return plan
}

const PAGE = 1000

/** Copia a una tienda las filas de sus fuentes. Devuelve cuántas por fuente. */
export async function copySealed(
  central: SealedCentral,
  tenant: SealedTenant,
  sources: string[],
  withSource: boolean,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const source of sources) {
    counts[source] = 0
    for (let after = 0; ; ) {
      const page = await central.page(source, after, PAGE)
      if (!page.length) break
      // Bases viejas sin la columna source: se copia sin ella.
      const rows = withSource ? page : page.map(({ source: _s, ...r }) => r)
      await tenant.upsert(rows as unknown as Record<string, unknown>[])
      counts[source] += page.length
      after = page[page.length - 1].id
      if (page.length < PAGE) break
    }
  }
  return counts
}
