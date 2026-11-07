/*
 * ¿Es una carta suelta (single)?
 *
 * TCGCSV/TCGplayer mezcla en cada set las cartas con el producto sellado
 * (cajas, sobres, mazos, ETB) y las Code Cards (códigos digitales). La única
 * señal confiable está en extendedData:
 *
 *   1. Rarity = "Code Card"          → NO (código para el juego en línea).
 *   2. Tiene Number                  → SÍ.
 *   3. Tiene Rarity distinta de None → SÍ (Pokémon japonés antiguo y las
 *                                       DON!! de One Piece no traen Number).
 *   4. Lo demás                      → NO (sellado, accesorios, insertos).
 *
 * Revisado con sets reales de los 11 juegos soportados (noviembre 2026).
 * Ejemplos que quedan fuera: "30th Celebration Booster Pack", "Theros Beyond
 * Death - Bundle", "Code Card - 30th Celebration Elite Trainer Box",
 * "Hyperia City Puzzle Insert (Set of 9)", "Ink Drop" (Lorcana) y las Art
 * Cards de Flesh and Blood con rareza "None". Entran aunque el nombre suene a
 * sellado: "Howler Pack" (carta de Star Wars Unlimited), tokens de Magic y
 * Yu-Gi-Oh!. Ver isSingle.test.ts.
 */
export function isSingle(extendedData: Record<string, string | null | undefined>): boolean {
  const number = clean(extendedData.Number)
  const rarity = clean(extendedData.Rarity)
  if (rarity && rarity.toLowerCase() === 'code card') return false
  if (number) return true
  return Boolean(rarity && rarity.toLowerCase() !== 'none')
}

function clean(v: string | null | undefined): string | null {
  const s = v == null ? '' : String(v).trim()
  return s || null
}
