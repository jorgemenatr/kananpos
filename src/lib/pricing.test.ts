import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RULES,
  applyRounding,
  dataAgeLabel,
  marginPct,
  needsReview,
  priceDiffPct,
  suggestPrice,
  type PricingRules,
} from './pricing'

const rules = (patch: Partial<PricingRules> = {}): PricingRules => ({ ...DEFAULT_RULES, usdMxnRate: 20, rounding: 'none', minPrice: 0, ...patch })
const ok = (s: ReturnType<typeof suggestPrice>) => {
  if (s.status !== 'ok') throw new Error(`esperaba sugerido, vino ${s.status}`)
  return s
}

describe('suggestPrice', () => {
  it('market × tipo de cambio × % NM, con el desglose', () => {
    const s = ok(suggestPrice({ marketUsd: 9.25, midUsd: 10 }, 'NM', rules()))
    expect(s.price).toBe(185)
    expect(s.breakdown).toBe('US$9.25 × $20.00 × 100% NM')
    expect(s.usdSource).toBe('market')
    expect(s.notes).toEqual([])
  })

  it('usa el tipo de cambio de la tienda', () => {
    expect(ok(suggestPrice({ marketUsd: 10, midUsd: null }, 'NM', rules({ usdMxnRate: 18.5 }))).price).toBe(185)
    expect(ok(suggestPrice({ marketUsd: 10, midUsd: null }, 'NM', rules({ usdMxnRate: 21 }))).price).toBe(210)
  })

  it('aplica el multiplicador y lo muestra en el desglose', () => {
    const s = ok(suggestPrice({ marketUsd: 10, midUsd: null }, 'NM', rules({ multiplier: 1.1 })))
    expect(s.price).toBe(220)
    expect(s.breakdown).toBe('US$10.00 × $20.00 × 1.10 × 100% NM')
    expect(ok(suggestPrice({ marketUsd: 10, midUsd: null }, 'NM', rules({ multiplier: 0.9 }))).price).toBe(180)
  })

  it('aplica el % del estado de la carta', () => {
    const ref = { marketUsd: 10, midUsd: null }
    expect(ok(suggestPrice(ref, 'LP', rules())).price).toBe(170)
    expect(ok(suggestPrice(ref, 'MP', rules())).price).toBe(140)
    expect(ok(suggestPrice(ref, 'HP', rules())).price).toBe(100)
    expect(ok(suggestPrice(ref, 'DMG', rules())).price).toBe(60)
    const custom = rules({ conditionPercentages: { NM: 100, LP: 90, MP: 75, HP: 55, DMG: 25 } })
    const s = ok(suggestPrice(ref, 'LP', custom))
    expect(s.price).toBe(180)
    expect(s.breakdown).toBe('US$10.00 × $20.00 × 90% LP')
  })

  it('redondea al peso, a $5 y a $10 (al más cercano)', () => {
    const ref = { marketUsd: 9.37, midUsd: null } // 187.40
    expect(ok(suggestPrice(ref, 'NM', rules({ rounding: 'none' }))).price).toBe(187.4)
    expect(ok(suggestPrice(ref, 'NM', rules({ rounding: 'peso' }))).price).toBe(187)
    expect(ok(suggestPrice(ref, 'NM', rules({ rounding: '5' }))).price).toBe(185)
    expect(ok(suggestPrice(ref, 'NM', rules({ rounding: '10' }))).price).toBe(190)
    const s = ok(suggestPrice(ref, 'NM', rules({ rounding: '10' })))
    expect(s.raw).toBe(187.4)
    expect(s.notes).toEqual(['$187.40 redondeado a $10.'])
  })

  it('redondeo sin errores de flotantes', () => {
    expect(applyRounding(1.005, 'none')).toBe(1.01)
    expect(applyRounding(187.5, 'peso')).toBe(188)
    expect(applyRounding(182.5, '5')).toBe(185)
    expect(applyRounding(4.99, '10')).toBe(0)
  })

  it('sube al precio mínimo', () => {
    const s = ok(suggestPrice({ marketUsd: 0.1, midUsd: null }, 'NM', rules({ minPrice: 5, rounding: 'peso' })))
    expect(s.raw).toBe(2)
    expect(s.price).toBe(5)
    expect(s.minApplied).toBe(true)
    expect(s.notes).toContain('Se subió al precio mínimo ($5.00).')
    // El mínimo va después del redondeo: $4.40 → $0 a $10 → $5.
    expect(ok(suggestPrice({ marketUsd: 0.22, midUsd: null }, 'NM', rules({ minPrice: 5, rounding: '10' }))).price).toBe(5)
    // Arriba del mínimo no cambia nada.
    expect(ok(suggestPrice({ marketUsd: 1, midUsd: null }, 'NM', rules({ minPrice: 5 }))).minApplied).toBe(false)
  })

  it('sin precio de mercado usa el precio medio', () => {
    const s = ok(suggestPrice({ marketUsd: null, midUsd: 4 }, 'NM', rules()))
    expect(s.price).toBe(80)
    expect(s.usdSource).toBe('mid')
    expect(s.notes).toEqual(['Sin precio de mercado: se usó el precio medio.'])
    expect(ok(suggestPrice({ marketUsd: 0, midUsd: 4 }, 'NM', rules())).usdSource).toBe('mid')
  })

  it('sin market ni mid: sin precio de referencia', () => {
    expect(suggestPrice({ marketUsd: null, midUsd: null }, 'NM', rules())).toEqual({ status: 'no_reference' })
    expect(suggestPrice({ marketUsd: undefined, midUsd: 0 }, 'NM', rules())).toEqual({ status: 'no_reference' })
  })

  it('sin tipo de cambio configurado no hay sugerido', () => {
    expect(suggestPrice({ marketUsd: 9.25, midUsd: 10 }, 'NM', rules({ usdMxnRate: null }))).toEqual({ status: 'no_rate' })
    expect(suggestPrice({ marketUsd: 9.25, midUsd: 10 }, 'NM', rules({ usdMxnRate: 0 }))).toEqual({ status: 'no_rate' })
    // Aunque tampoco haya referencia: primero se pide el tipo de cambio.
    expect(suggestPrice({ marketUsd: null, midUsd: null }, 'NM', rules({ usdMxnRate: null }))).toEqual({ status: 'no_rate' })
  })

  it('combina todo: tipo de cambio, multiplicador, estado, redondeo y mínimo', () => {
    // 12.34 × 19.80 × 1.15 × 70% = 196.687 → 196.69 → $195 (a $5)
    const s = ok(
      suggestPrice({ marketUsd: 12.34, midUsd: 15 }, 'MP', rules({ usdMxnRate: 19.8, multiplier: 1.15, rounding: '5', minPrice: 5 })),
    )
    expect(s.raw).toBe(196.69)
    expect(s.price).toBe(195)
    expect(s.breakdown).toBe('US$12.34 × $19.80 × 1.15 × 70% MP')
  })
})

describe('revisar precios', () => {
  const s185 = suggestPrice({ marketUsd: 9.25, midUsd: null }, 'NM', rules())
  it('diferencia en % contra el precio actual', () => {
    expect(priceDiffPct(150, 185)).toBeCloseTo(23.33, 2)
    expect(priceDiffPct(200, 185)).toBe(7.5)
    expect(priceDiffPct(0, 185)).toBe(Infinity)
  })
  it('solo entra lo que difiere más del umbral', () => {
    expect(needsReview(150, s185, 10)).toBe(true)
    expect(needsReview(180, s185, 10)).toBe(false)
    expect(needsReview(185, s185, 0)).toBe(false)
    expect(needsReview(150, { status: 'no_rate' }, 0)).toBe(false)
    expect(needsReview(150, { status: 'no_reference' }, 0)).toBe(false)
  })
  it('margen contra el costo FIFO', () => {
    expect(marginPct(150, 90)).toBe(40)
    expect(marginPct(150, null)).toBeNull()
    expect(marginPct(0, 90)).toBeNull()
    expect(marginPct(80, 100)).toBe(-25)
  })
})

describe('dataAgeLabel', () => {
  const now = new Date(2026, 10, 7, 12)
  it('hoy, ayer y hace N días', () => {
    expect(dataAgeLabel(new Date(2026, 10, 7, 1).toISOString(), now)).toBe('actualizado hoy')
    expect(dataAgeLabel(new Date(2026, 10, 6, 23).toISOString(), now)).toBe('actualizado ayer')
    expect(dataAgeLabel(new Date(2026, 10, 3, 10).toISOString(), now)).toBe('actualizado hace 4 días')
    expect(dataAgeLabel(null, now)).toBe('sin fecha')
  })
})
