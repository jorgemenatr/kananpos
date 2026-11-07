import { describe, expect, it } from 'vitest'
import { copySealed, LEGACY_SOURCES, planSealed, type SealedCentral, type SealedRow, type SealedTenant } from './sealed.ts'

const row = (id: number, source: string): SealedRow => ({
  id,
  category_id: 3,
  game: 'Pokemon',
  source,
  group_id: 1,
  set_name: 'Set',
  set_code: null,
  name: `Producto ${id}`,
  description: null,
  image_url: null,
  upc: null,
  market_price: 10,
  released_on: null,
  tcgplayer_url: null,
  source_modified_on: null,
  imported_at: '2026-11-09T00:00:00Z',
})

class Tenant implements SealedTenant {
  readonly ref: string
  readonly name: string
  sources: string[] | null
  rows = new Map<number, Record<string, unknown>>()
  constructor(name: string, sources: string[] | null) {
    this.ref = name
    this.name = name
    this.sources = sources
  }
  async enabledSources() {
    return this.sources
  }
  async upsert(rows: Record<string, unknown>[]) {
    for (const r of rows) this.rows.set(r.id as number, r)
  }
}

const known = new Set(['pokemon', 'magic', 'yugioh', 'lorcana', 'flesh-and-blood', 'dragon-shield', 'ultra-pro-pokemon', 'one-piece'])

describe('catálogo de sellado vía el central', () => {
  it('descarga una sola vez la unión de las fuentes de todas las tiendas', async () => {
    const plan = await planSealed([new Tenant('a', ['pokemon', 'dragon-shield']), new Tenant('b', ['pokemon', 'one-piece', 'rara'])], known)
    expect(plan.download).toEqual(['dragon-shield', 'one-piece', 'pokemon'])
    expect(plan.tenants.map((t) => t.sources)).toEqual([['pokemon', 'dragon-shield'], ['pokemon', 'one-piece']])
    expect(plan.warnings).toEqual(['b: fuentes desconocidas (se ignoran): rara'])
  })

  it('con --juegos solo esas fuentes; base vieja sin categorías usa las de siempre', async () => {
    const vieja = new Tenant('vieja', null)
    const plan = await planSealed([new Tenant('a', ['pokemon', 'magic']), vieja], known, ['magic'])
    expect(plan.download).toEqual(['magic'])
    expect(plan.tenants.map((t) => [t.sources, t.withSource])).toEqual([
      [['magic'], true],
      [['magic'], false],
    ])
    const all = await planSealed([vieja], known)
    expect(all.download).toEqual([...LEGACY_SOURCES].sort())
  })

  it('copia a cada tienda solo sus fuentes, por páginas, sin duplicar', async () => {
    const data: Record<string, SealedRow[]> = {
      pokemon: Array.from({ length: 2500 }, (_, i) => row(i + 1, 'pokemon')),
      magic: [row(9001, 'magic')],
    }
    const pages: string[] = []
    const central: SealedCentral = {
      page: async (source, after, limit) => {
        pages.push(`${source}>${after}`)
        return (data[source] ?? []).filter((r) => r.id > after).slice(0, limit)
      },
    }
    const t = new Tenant('a', ['pokemon'])
    expect(await copySealed(central, t, ['pokemon'], true)).toEqual({ pokemon: 2500 })
    expect(pages).toEqual(['pokemon>0', 'pokemon>1000', 'pokemon>2000'])
    expect(t.rows.size).toBe(2500)
    expect([...t.rows.values()].some((r) => r.source === 'magic')).toBe(false)
    await copySealed(central, t, ['pokemon'], true)
    expect(t.rows.size).toBe(2500)
  })

  it('a una base sin la columna source se le copia sin ella', async () => {
    const central: SealedCentral = { page: async (_s, after) => (after ? [] : [row(1, 'pokemon')]) }
    const t = new Tenant('vieja', null)
    await copySealed(central, t, ['pokemon'], false)
    expect('source' in t.rows.get(1)!).toBe(false)
  })
})
