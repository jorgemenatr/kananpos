import { describe, expect, it } from 'vitest'
import { TcgCsvProvider, toIso } from './tcgcsv.ts'

type Handler = (url: string) => { status?: number; body: unknown } | Error

function mockFetch(handler: Handler) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    const r = handler(url)
    if (r instanceof Error) throw r
    const status = r.status ?? 200
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
    return new Response(text, { status })
  }) as typeof fetch
  return { fn, calls }
}

const ok = (results: unknown[]) => ({ body: { success: true, errors: [], results } })

function provider(handler: Handler) {
  const m = mockFetch(handler)
  const sleeps: number[] = []
  const p = new TcgCsvProvider({
    fetch: m.fn,
    delayMs: 150,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  return { p, calls: m.calls, sleeps }
}

describe('TcgCsvProvider', () => {
  it('manda el User-Agent de la app (sin correos) en cada petición', async () => {
    const { p, calls } = provider(() => ok([]))
    await p.listGames()
    expect(calls[0].url).toBe('https://tcgcsv.com/tcgplayer/categories')
    expect(calls[0].headers['User-Agent']).toMatch(/^KananPOS-CatalogSync\/\d+\.\d+\.\d+$/)
    expect(calls[0].headers['User-Agent']).not.toMatch(/@/)
  })

  it('hace las peticiones una tras otra, con pausa entre ellas', async () => {
    let active = 0
    let maxActive = 0
    const m = mockFetch(() => ok([]))
    const slowFetch = (async (u: string | URL, i?: RequestInit) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return m.fn(u, i)
    }) as typeof fetch
    const sleeps: number[] = []
    const p = new TcgCsvProvider({ fetch: slowFetch, delayMs: 1000, sleep: async (ms) => void sleeps.push(ms) })
    await Promise.all([p.listSets(1), p.listSets(2), p.listSets(3)])
    expect(maxActive).toBe(1)
    expect(p.requestCount).toBe(3)
    expect(sleeps.filter((s) => s > 0).length).toBeGreaterThanOrEqual(2)
  })

  it('normaliza sets y precios', async () => {
    const { p } = provider((url) =>
      url.endsWith('/groups')
        ? ok([{ groupId: 10, name: 'SV 151', abbreviation: 'MEW', publishedOn: '2023-09-22T00:00:00', modifiedOn: '2025-12-12T22:37:34.34', categoryId: 3 }])
        : ok([
            { productId: 1, subTypeName: 'Holofoil', lowPrice: 1.5, midPrice: 2, highPrice: 9, marketPrice: 2.25, directLowPrice: null },
            { productId: 2, subTypeName: '', lowPrice: 1, midPrice: 1, highPrice: 1, marketPrice: 1, directLowPrice: null },
          ]),
    )
    const [set] = await p.listSets(3)
    expect(set).toEqual({
      externalId: 10,
      gameExternalId: 3,
      name: 'SV 151',
      abbreviation: 'MEW',
      releaseDate: '2023-09-22',
      modifiedOn: '2025-12-12T22:37:34.340Z',
    })
    const prices = await p.listPrices(3, 10)
    expect(prices).toEqual([
      { tcgplayerProductId: 1, subtype: 'Holofoil', marketUsd: 2.25, lowUsd: 1.5, midUsd: 2, highUsd: 9, directLowUsd: null },
    ])
  })

  it('normaliza productos y marca is_single', async () => {
    const { p } = provider(() =>
      ok([
        {
          productId: 5,
          name: 'Charizard ex',
          cleanName: 'Charizard ex',
          imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/5_200w.jpg',
          groupId: 10,
          url: 'https://www.tcgplayer.com/product/5',
          modifiedOn: '2025-01-01T00:00:00',
          extendedData: [
            { name: 'Number', value: '199/165' },
            { name: 'Rarity', value: 'Special Illustration Rare' },
            { name: 'HP', value: null },
          ],
        },
        { productId: 6, name: '151 Booster Bundle', groupId: 10, extendedData: [{ name: 'UPC', value: '123' }] },
      ]),
    )
    const [card, sealed] = await p.listProducts(3, 10)
    expect(card).toMatchObject({
      tcgplayerProductId: 5,
      setExternalId: 10,
      number: '199/165',
      rarity: 'Special Illustration Rare',
      isSingle: true,
      extendedData: { Number: '199/165', Rarity: 'Special Illustration Rare' },
      modifiedOn: '2025-01-01T00:00:00.000Z',
    })
    expect(sealed.isSingle).toBe(false)
  })

  it('reintenta errores 5xx y de red, pero no 4xx', async () => {
    let n = 0
    const { p } = provider(() => (++n < 3 ? (n === 1 ? new Error('ECONNRESET') : { status: 503, body: '' }) : ok([])))
    await expect(p.listGames()).resolves.toEqual([])
    expect(n).toBe(3)

    const bad = provider(() => ({ status: 403, body: '' }))
    await expect(bad.p.listGames()).rejects.toThrow(/403/)
    expect(bad.calls).toHaveLength(1)
  })

  it('un set sin archivo de precios (404) da lista vacía', async () => {
    const { p } = provider(() => ({ status: 404, body: '' }))
    await expect(p.listPrices(3, 10)).resolves.toEqual([])
    await expect(p.listProducts(3, 10)).rejects.toThrow(/404/)
  })

  it('lee last-updated.txt', async () => {
    const { p } = provider(() => ({ body: '2026-11-06T20:05:28+0000\n' }))
    expect((await p.lastUpdated())?.toISOString()).toBe('2026-11-06T20:05:28.000Z')
  })
})

describe('toIso', () => {
  it('toma como UTC las fechas sin zona horaria', () => {
    expect(toIso('2025-12-12T22:37:34.34')).toBe('2025-12-12T22:37:34.340Z')
    expect(toIso('2026-11-06T20:05:28+0000')).toBe('2026-11-06T20:05:28.000Z')
    expect(toIso(null)).toBeNull()
    expect(toIso('basura')).toBeNull()
  })
})
