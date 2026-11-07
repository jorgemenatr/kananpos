/*
 * Modelos internos del catálogo de singles y la interfaz de los proveedores
 * de precios. Cada proveedor (TCGCSV hoy, tcgapi.dev después) traduce su
 * respuesta a estos tipos; el resto del código no sabe de dónde vienen.
 *
 * Los IDs que recibe y devuelve un proveedor son los de TCGplayer
 * (categoryId, groupId, productId). Todos los proveedores que usamos están
 * construidos sobre TCGplayer, así que esos IDs sirven para cruzar fuentes.
 */

export interface ProviderGame {
  /** categoryId de TCGplayer. */
  externalId: number
  /** Nombre interno en el proveedor ("Magic"). */
  name: string
  /** Nombre para mostrar en el proveedor ("Magic: The Gathering"). */
  displayName: string
}

export interface ProviderSet {
  /** groupId de TCGplayer. */
  externalId: number
  gameExternalId: number
  name: string
  abbreviation: string | null
  /** AAAA-MM-DD */
  releaseDate: string | null
  /** ISO 8601. Cambia cuando se agregan o quitan productos del set. */
  modifiedOn: string | null
}

export interface ProviderProduct {
  /** productId de TCGplayer. */
  tcgplayerProductId: number
  setExternalId: number
  name: string
  cleanName: string | null
  number: string | null
  rarity: string | null
  imageUrl: string | null
  url: string | null
  /** Carta suelta (ver isSingle.ts). El sellado y las Code Cards quedan fuera. */
  isSingle: boolean
  /** Datos extra del proveedor (texto de la carta, tipo, HP…). */
  extendedData: Record<string, string>
  modifiedOn: string | null
}

export interface ProviderPrice {
  tcgplayerProductId: number
  /** Normal, Foil, Holofoil, Reverse Holofoil, 1st Edition… */
  subtype: string
  marketUsd: number | null
  lowUsd: number | null
  midUsd: number | null
  highUsd: number | null
  directLowUsd: number | null
}

/**
 * Fuente de catálogo y precios. Solo la usa el job del servidor: nunca el
 * frontend ni la app de la tienda.
 */
export interface PriceProvider {
  /** Se guarda en tcg_prices.source y en las corridas. */
  readonly id: string
  /** Fecha de la última actualización de los datos del proveedor (null si no la publica). */
  lastUpdated(): Promise<Date | null>
  listGames(): Promise<ProviderGame[]>
  listSets(gameExternalId: number): Promise<ProviderSet[]>
  listProducts(gameExternalId: number, setExternalId: number): Promise<ProviderProduct[]>
  listPrices(gameExternalId: number, setExternalId: number): Promise<ProviderPrice[]>
}

/** Conteos que devuelven los upserts del catálogo central. */
export interface UpsertCounts {
  inserted: number
  updated: number
  unchanged: number
  ignored?: number
}
