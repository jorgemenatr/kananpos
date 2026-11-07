/*
 * Lista curada de juegos (juegos.json) → IDs reales del proveedor.
 */
import { readFileSync } from 'node:fs'
import type { ProviderGame } from './types.ts'

export interface CuratedGame {
  slug: string
  nombre: string
  /** Nombre de la categoría en el proveedor (name o displayName). */
  proveedor: string
}

export interface ResolvedGame {
  slug: string
  provider: string
  external_id: number
  name: string
  display_name: string
  sort_order: number
}

export function loadCuratedGames(): CuratedGame[] {
  const file = new URL('./juegos.json', import.meta.url)
  const data = JSON.parse(readFileSync(file, 'utf8')) as { juegos: CuratedGame[] }
  const slugs = new Set<string>()
  for (const g of data.juegos) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(g.slug)) throw new Error(`juegos.json: slug inválido "${g.slug}"`)
    if (slugs.has(g.slug)) throw new Error(`juegos.json: slug repetido "${g.slug}"`)
    slugs.add(g.slug)
  }
  return data.juegos
}

const norm = (s: string) => s.trim().toLowerCase()

/** Busca cada juego de la lista en las categorías del proveedor. Falla si alguno no aparece. */
export function resolveGames(curated: CuratedGame[], providerGames: ProviderGame[], providerId: string): ResolvedGame[] {
  const missing: string[] = []
  const resolved = curated.flatMap((g, i) => {
    const target = norm(g.proveedor)
    const matches = providerGames.filter((p) => norm(p.name) === target || norm(p.displayName) === target)
    if (matches.length !== 1) {
      missing.push(`${g.slug} ("${g.proveedor}": ${matches.length ? 'varias coincidencias' : 'no existe'})`)
      return []
    }
    const m = matches[0]
    return [{ slug: g.slug, provider: providerId, external_id: m.externalId, name: m.name, display_name: g.nombre, sort_order: i + 1 }]
  })
  if (missing.length) {
    throw new Error(`No encontré estos juegos en el proveedor ${providerId}: ${missing.join('; ')}. Revisa scripts/singles/juegos.json.`)
  }
  return resolved
}
