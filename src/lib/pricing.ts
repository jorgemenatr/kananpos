/*
 * Precio sugerido de un single. ÚNICA fórmula: la usan la ficha, el POS,
 * el alta de singles y "Revisar precios" (ver pricing.test.ts).
 *
 *   sugerido = market_usd × tipo de cambio × multiplicador × % del estado
 *              → redondeo → precio mínimo
 *
 *   - Sin market_usd se usa mid_usd; sin ninguno: "sin precio de referencia".
 *   - Sin tipo de cambio configurado no hay sugerido ("Configura tu tipo de
 *     cambio para ver precios sugeridos").
 *   - El redondeo va al más cercano (al peso, a $5 o a $10).
 *
 * El sugerido nunca cambia el precio de venta por sí solo: solo se aplica
 * cuando el admin lo confirma.
 */

export type CardCondition = 'NM' | 'LP' | 'MP' | 'HP' | 'DMG'

export const CONDITIONS: CardCondition[] = ['NM', 'LP', 'MP', 'HP', 'DMG']

export const CONDITION_LABELS: Record<CardCondition, string> = {
  NM: 'Near Mint',
  LP: 'Lightly Played',
  MP: 'Moderately Played',
  HP: 'Heavily Played',
  DMG: 'Damaged',
}

export type Rounding = 'none' | 'peso' | '5' | '10'

export const ROUNDING_LABELS: Record<Rounding, string> = {
  none: 'Sin redondeo',
  peso: 'Al peso',
  '5': 'A $5',
  '10': 'A $10',
}

export interface PricingRules {
  /** MXN por 1 USD que define la tienda. null = no configurado. */
  usdMxnRate: number | null
  multiplier: number
  rounding: Rounding
  /** % del precio NM para cada estado (NM 100, LP 85…). */
  conditionPercentages: Record<CardCondition, number>
  minPrice: number
  /** "Revisar precios": diferencia mínima (%) entre el precio actual y el sugerido. */
  reviewThresholdPct: number
}

export const DEFAULT_CONDITION_PERCENTAGES: Record<CardCondition, number> = { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 30 }

export const DEFAULT_RULES: PricingRules = {
  usdMxnRate: null,
  multiplier: 1,
  rounding: 'peso',
  conditionPercentages: DEFAULT_CONDITION_PERCENTAGES,
  minPrice: 5,
  reviewThresholdPct: 10,
}

export interface ReferencePrice {
  marketUsd: number | null | undefined
  midUsd: number | null | undefined
}

export type Suggestion =
  | {
      status: 'ok'
      /** Precio sugerido final (MXN). */
      price: number
      /** Antes de redondear y del mínimo. */
      raw: number
      usd: number
      usdSource: 'market' | 'mid'
      rate: number
      multiplier: number
      condition: CardCondition
      conditionPct: number
      rounding: Rounding
      /** Se subió al precio mínimo. */
      minApplied: boolean
      /** "US$9.25 × $20.00 × 100% NM" */
      breakdown: string
      /** Renglones extra del desglose (precio medio, redondeo, mínimo). */
      notes: string[]
    }
  | { status: 'no_rate' }
  | { status: 'no_reference' }

const valid = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

/** Redondea a 2 decimales sin el error de los flotantes (1.005 → 1.01). */
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export function applyRounding(value: number, rounding: Rounding): number {
  switch (rounding) {
    case 'peso':
      return Math.round(round2(value))
    case '5':
      return Math.round(round2(value) / 5) * 5
    case '10':
      return Math.round(round2(value) / 10) * 10
    default:
      return round2(value)
  }
}

const usdFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const mxnFmt = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pctFmt = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 })
const multFmt = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 3 })

export const formatUsd = (n: number) => `US$${usdFmt.format(n)}`
const formatMxn = (n: number) => `$${mxnFmt.format(n)}`

export function suggestPrice(ref: ReferencePrice, condition: CardCondition, rules: PricingRules): Suggestion {
  if (!valid(rules.usdMxnRate)) return { status: 'no_rate' }
  const usdSource = valid(ref.marketUsd) ? 'market' : valid(ref.midUsd) ? 'mid' : null
  if (!usdSource) return { status: 'no_reference' }
  const usd = (usdSource === 'market' ? ref.marketUsd : ref.midUsd) as number
  const rate = rules.usdMxnRate
  const multiplier = valid(rules.multiplier) ? rules.multiplier : 1
  const conditionPct = rules.conditionPercentages[condition] ?? DEFAULT_CONDITION_PERCENTAGES[condition]

  const raw = round2((usd * rate * multiplier * conditionPct) / 100)
  const rounded = applyRounding(raw, rules.rounding)
  const minPrice = Math.max(0, rules.minPrice || 0)
  const minApplied = rounded < minPrice
  const price = round2(minApplied ? minPrice : rounded)

  const parts = [formatUsd(usd), formatMxn(rate)]
  if (multiplier !== 1) parts.push(multFmt.format(multiplier))
  parts.push(`${pctFmt.format(conditionPct)}% ${condition}`)
  const notes: string[] = []
  if (usdSource === 'mid') notes.push('Sin precio de mercado: se usó el precio medio.')
  if (rules.rounding !== 'none' && rounded !== raw) notes.push(`${formatMxn(raw)} redondeado ${ROUNDING_LABELS[rules.rounding].toLowerCase()}.`)
  if (minApplied) notes.push(`Se subió al precio mínimo (${formatMxn(minPrice)}).`)

  return {
    status: 'ok',
    price,
    raw,
    usd,
    usdSource,
    rate,
    multiplier,
    condition,
    conditionPct,
    rounding: rules.rounding,
    minApplied,
    breakdown: parts.join(' × '),
    notes,
  }
}

/** Diferencia (%) del precio actual contra el sugerido. Precio actual 0 = infinita. */
export function priceDiffPct(current: number, suggested: number): number {
  if (current <= 0) return suggested > 0 ? Infinity : 0
  return (Math.abs(suggested - current) / current) * 100
}

/** ¿Va en "Revisar precios"? (difiere más del umbral de la tienda). */
export function needsReview(current: number, suggestion: Suggestion, thresholdPct: number): boolean {
  return suggestion.status === 'ok' && round2(suggestion.price) !== round2(current) && priceDiffPct(current, suggestion.price) > thresholdPct
}

/** Margen sobre el precio de venta: Costo $90 · Venta $150 → 40 %. null sin costo o sin precio. */
export function marginPct(price: number, cost: number | null | undefined): number | null {
  if (cost == null || !Number.isFinite(cost) || price <= 0) return null
  return ((price - cost) / price) * 100
}

/** "actualizado hoy", "actualizado ayer", "actualizado hace 3 días" (días del calendario local). */
export function dataAgeLabel(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'sin fecha'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'sin fecha'
  const day = (x: Date) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate())
  const days = Math.round((day(now) - day(d)) / 864e5)
  if (days <= 0) return 'actualizado hoy'
  if (days === 1) return 'actualizado ayer'
  return `actualizado hace ${days} días`
}
