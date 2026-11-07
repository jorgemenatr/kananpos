/*
 * TcgCsvProvider: datos de TCGplayer vía https://tcgcsv.com (espejo diario,
 * se actualiza cerca de las 20:00 UTC). Reglas de uso (https://tcgcsv.com/docs):
 *
 *   - Sincronizar una vez al día y guardar en nuestra base. Nunca llamarlo
 *     desde el frontend ni desde la app de la tienda (además su CORS lo impide).
 *   - Revisar last-updated.txt antes de bajar todo.
 *   - User-Agent propio de la app ("App/X.Y.Z") y una pausa (≥100 ms) entre
 *     peticiones. Más de 10,000 peticiones al día puede causar un bloqueo.
 *
 * Por eso las peticiones van de una en una (nunca en paralelo) con una pausa
 * entre cada una, y la clase lleva la cuenta de cuántas hizo.
 */
import { isSingle } from '../isSingle.ts'
import type { PriceProvider, ProviderGame, ProviderPrice, ProviderProduct, ProviderSet } from '../types.ts'

export const TCGCSV_BASE = 'https://tcgcsv.com'
export const DEFAULT_USER_AGENT = 'KananPOS-CatalogSync/1.0.0'

export interface TcgCsvOptions {
  baseUrl?: string
  userAgent?: string
  /** Pausa mínima entre peticiones, en ms. */
  delayMs?: number
  retries?: number
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

interface TcgCsvEnvelope<T> {
  success?: boolean
  errors?: string[]
  results?: T[]
}

interface RawCategory {
  categoryId: number
  name: string
  displayName?: string | null
}

interface RawGroup {
  groupId: number
  name: string
  abbreviation?: string | null
  publishedOn?: string | null
  modifiedOn?: string | null
  categoryId: number
}

interface RawProduct {
  productId: number
  name: string
  cleanName?: string | null
  imageUrl?: string | null
  groupId: number
  url?: string | null
  modifiedOn?: string | null
  extendedData?: { name: string; value: string | null }[]
}

interface RawPrice {
  productId: number
  subTypeName: string
  lowPrice: number | null
  midPrice: number | null
  highPrice: number | null
  marketPrice: number | null
  directLowPrice: number | null
}

/** Fechas de TCGCSV vienen sin zona horaria: se toman como UTC. */
export function toIso(value: string | null | undefined): string | null {
  if (!value) return null
  const s = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const text = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).trim()
  return s || null
}

export class TcgCsvProvider implements PriceProvider {
  readonly id = 'tcgcsv'
  /** Peticiones hechas por esta instancia (presupuesto diario de TCGCSV). */
  requestCount = 0

  private readonly baseUrl: string
  private readonly userAgent: string
  private readonly delayMs: number
  private readonly retries: number
  private readonly fetchFn: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  private lastRequestAt = 0

  constructor(opts: TcgCsvOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? TCGCSV_BASE).replace(/\/+$/, '')
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT
    this.delayMs = opts.delayMs ?? 150
    this.retries = opts.retries ?? 3
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis)
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  async lastUpdated(): Promise<Date | null> {
    const body = await this.get('/last-updated.txt', 'text')
    const iso = toIso(String(body).trim())
    return iso ? new Date(iso) : null
  }

  async listGames(): Promise<ProviderGame[]> {
    const rows = await this.results<RawCategory>('/tcgplayer/categories')
    return rows.map((c) => ({
      externalId: c.categoryId,
      name: c.name,
      displayName: text(c.displayName) ?? c.name,
    }))
  }

  async listSets(gameExternalId: number): Promise<ProviderSet[]> {
    const rows = await this.results<RawGroup>(`/tcgplayer/${gameExternalId}/groups`)
    return rows.map((g) => ({
      externalId: g.groupId,
      gameExternalId: g.categoryId ?? gameExternalId,
      name: g.name,
      abbreviation: text(g.abbreviation),
      releaseDate: toIso(g.publishedOn)?.slice(0, 10) ?? null,
      modifiedOn: toIso(g.modifiedOn),
    }))
  }

  async listProducts(gameExternalId: number, setExternalId: number): Promise<ProviderProduct[]> {
    const rows = await this.results<RawProduct>(`/tcgplayer/${gameExternalId}/${setExternalId}/products`)
    return rows.map((p) => normalizeProduct(p, setExternalId))
  }

  async listPrices(gameExternalId: number, setExternalId: number): Promise<ProviderPrice[]> {
    let rows: RawPrice[]
    try {
      rows = await this.results<RawPrice>(`/tcgplayer/${gameExternalId}/${setExternalId}/prices`)
    } catch (e) {
      // Algunos sets (sin productos a la venta) no tienen archivo de precios.
      if (e instanceof HttpError && e.status === 404) return []
      throw e
    }
    return rows
      .filter((r) => r.productId && text(r.subTypeName))
      .map((r) => ({
        tcgplayerProductId: r.productId,
        subtype: String(r.subTypeName).trim(),
        marketUsd: num(r.marketPrice),
        lowUsd: num(r.lowPrice),
        midUsd: num(r.midPrice),
        highUsd: num(r.highPrice),
        directLowUsd: num(r.directLowPrice),
      }))
  }

  // ---------- HTTP ----------
  private async results<T>(path: string): Promise<T[]> {
    const body = (await this.get(path, 'json')) as TcgCsvEnvelope<T>
    if (body.success === false) throw new Error(`${path}: ${body.errors?.join('; ') || 'respuesta sin éxito'}`)
    return body.results ?? []
  }

  /** Una petición a la vez, con pausa entre ellas y reintentos. */
  private get(path: string, as: 'json' | 'text'): Promise<unknown> {
    const run = this.queue.then(() => this.getWithRetry(path, as))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async getWithRetry(path: string, as: 'json' | 'text'): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.delayMs - Date.now()
      if (wait > 0) await this.sleep(wait)
      this.lastRequestAt = Date.now()
      this.requestCount++
      try {
        const res = await this.fetchFn(`${this.baseUrl}${path}`, {
          headers: { 'User-Agent': this.userAgent, Accept: as === 'json' ? 'application/json' : 'text/plain' },
        })
        if (!res.ok) throw new HttpError(res.status, `${path}: HTTP ${res.status}`)
        return as === 'json' ? await res.json() : await res.text()
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 0
        // 4xx (salvo 429) no se arregla reintentando.
        const retriable = status === 0 || status === 429 || status >= 500
        if (!retriable || attempt >= this.retries) throw e
        await this.sleep(1000 * 2 ** attempt)
      }
    }
  }
}

export function normalizeProduct(p: RawProduct, setExternalId: number): ProviderProduct {
  const extendedData: Record<string, string> = {}
  for (const e of p.extendedData ?? []) {
    const v = text(e.value)
    if (e.name && v) extendedData[e.name] = v
  }
  return {
    tcgplayerProductId: p.productId,
    setExternalId: p.groupId ?? setExternalId,
    name: p.name,
    cleanName: text(p.cleanName),
    number: extendedData.Number ?? null,
    rarity: extendedData.Rarity ?? null,
    imageUrl: text(p.imageUrl),
    url: text(p.url),
    isSingle: isSingle(extendedData),
    extendedData,
    modifiedOn: toIso(p.modifiedOn),
  }
}
