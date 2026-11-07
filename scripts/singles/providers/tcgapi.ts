/*
 * TcgApiProvider: https://tcgapi.dev (fuente futura, plan Pro con precios por
 * estado de la carta). SOLO LA ESTRUCTURA: falta implementar cada método.
 *
 * La API key va únicamente en variables de entorno del servidor
 * (TCGAPI_KEY, en los secrets de GitHub Actions). Nunca en el frontend ni en
 * variables VITE_.
 *
 * Para activarlo: implementar los métodos, normalizar a los tipos de
 * ../types.ts (los IDs deben ser los de TCGplayer para que el catálogo central
 * siga cruzando con lo que ya está guardado) y correr el job con
 * CATALOG_PROVIDER=tcgapi.
 */
import type { PriceProvider, ProviderGame, ProviderPrice, ProviderProduct, ProviderSet } from '../types.ts'

export interface TcgApiOptions {
  apiKey: string
  baseUrl?: string
  fetch?: typeof fetch
}

export class TcgApiProvider implements PriceProvider {
  readonly id = 'tcgapi'
  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(opts: TcgApiOptions) {
    if (!opts.apiKey) throw new Error('Falta TCGAPI_KEY (variable de entorno del servidor).')
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? 'https://api.tcgapi.dev').replace(/\/+$/, '')
  }

  async lastUpdated(): Promise<Date | null> {
    // TODO: si la API publica la fecha de su última actualización, leerla aquí.
    return null
  }

  async listGames(): Promise<ProviderGame[]> {
    // TODO: GET juegos → { externalId: categoryId de TCGplayer, name, displayName }
    return this.todo('listGames')
  }

  async listSets(_gameExternalId: number): Promise<ProviderSet[]> {
    // TODO: GET sets del juego → ProviderSet (externalId = groupId de TCGplayer)
    return this.todo('listSets')
  }

  async listProducts(_gameExternalId: number, _setExternalId: number): Promise<ProviderProduct[]> {
    // TODO: GET cartas del set → ProviderProduct (usar isSingle() o el tipo que dé la API)
    return this.todo('listProducts')
  }

  async listPrices(_gameExternalId: number, _setExternalId: number): Promise<ProviderPrice[]> {
    // TODO: GET precios del set → ProviderPrice. El plan Pro trae precio por
    // estado (NM/LP/…): cuando se use, agregar la condición al modelo.
    return this.todo('listPrices')
  }

  private todo(method: string): never {
    void this.apiKey
    throw new Error(`TcgApiProvider.${method} no está implementado todavía (${this.baseUrl}).`)
  }
}
