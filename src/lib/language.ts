import type { ProductLanguage } from './types'

const plain = (s: string | null | undefined) =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * ¿Se le pone idioma a este producto? Por ahora solo a Pokémon, que es lo que
 * llega en inglés y en español. Si ya tiene idioma, siempre se muestra.
 */
export function languageApplies(category: string | null | undefined, catalogSource?: string | null) {
  return plain(category).includes('pokemon') || plain(catalogSource).startsWith('pokemon')
}

/** Idioma que se propone al dar de alta (el catálogo de TCGplayer es inglés o japonés). */
export function suggestedLanguage(category: string | null | undefined, catalogSource?: string | null): ProductLanguage | null {
  if (catalogSource === 'pokemon-japan') return 'ja'
  return languageApplies(category, catalogSource) ? 'en' : null
}
