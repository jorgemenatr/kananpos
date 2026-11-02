import { useMemo } from 'react'
import { LANGUAGE_LABELS, isProductLanguage, type ProductLanguage } from '../lib/types'
import { useInventory } from '../store/useInventory'

interface Props {
  language: ProductLanguage | null | undefined
  /** lg: para la ficha grande del escaneo. */
  size?: 'sm' | 'lg'
  className?: string
}

/** Etiqueta de color con el idioma del producto (no pinta nada si no aplica). */
export function LanguageTag({ language, size = 'sm', className = '' }: Props) {
  if (!isProductLanguage(language)) return null
  return (
    <span className={`lang-tag lang-${language} ${size === 'lg' ? 'lang-tag-lg' : ''} ${className}`}>
      {LANGUAGE_LABELS[language]}
    </span>
  )
}

/** Texto del idioma para buscar ("español" encuentra los productos en español). */
export function languageSearchText(language: ProductLanguage | null | undefined) {
  return isProductLanguage(language) ? LANGUAGE_LABELS[language] : ''
}

/** Nombre con el idioma entre paréntesis, para textos sin etiqueta (listas en una línea, avisos). */
export function nameWithLanguage(name: string, language: ProductLanguage | null | undefined) {
  return isProductLanguage(language) ? `${name} (${LANGUAGE_LABELS[language]})` : name
}

/**
 * Idioma de cada producto según la caché de inventario, por id y por código
 * de barras: para pantallas cuyas filas solo traen el nombre (historial,
 * compras, recientes del escaneo).
 */
export function useLanguageLookup() {
  const { products } = useInventory()
  return useMemo(() => {
    const map = new Map<string, ProductLanguage>()
    for (const p of Object.values(products)) {
      if (!isProductLanguage(p.language)) continue
      map.set(p.id, p.language)
      map.set(p.barcode, p.language)
    }
    return map
  }, [products])
}
