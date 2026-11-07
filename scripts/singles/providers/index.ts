/*
 * Elige el proveedor de precios con la variable CATALOG_PROVIDER
 * (tcgcsv por defecto). Cambiar de fuente es cambiar esa variable.
 */
import type { PriceProvider } from '../types.ts'
import { TcgApiProvider } from './tcgapi.ts'
import { TcgCsvProvider } from './tcgcsv.ts'

export const PROVIDERS = ['tcgcsv', 'tcgapi'] as const
export type ProviderId = (typeof PROVIDERS)[number]

export function createProvider(
  id: string = 'tcgcsv',
  env: Record<string, string | undefined> = process.env,
): PriceProvider {
  switch (id) {
    case 'tcgcsv':
      return new TcgCsvProvider({ userAgent: env.CATALOG_USER_AGENT || undefined })
    case 'tcgapi':
      return new TcgApiProvider({ apiKey: env.TCGAPI_KEY ?? '' })
    default:
      throw new Error(`Proveedor desconocido: "${id}". Disponibles: ${PROVIDERS.join(', ')}`)
  }
}
