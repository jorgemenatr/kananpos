import { useState } from 'react'
import { Link } from 'react-router-dom'
import { formatMoney } from '../../lib/format'
import { dataAgeLabel, marginPct, suggestPrice, type CardCondition, type PricingRules, type Suggestion } from '../../lib/pricing'
import { applySinglePrices, usePricingRules, useSingleRefs } from '../../lib/singles'
import { Icon } from '../Icon'

export interface ReferenceData {
  market_usd: number | null
  mid_usd: number | null
  /** Fecha del dato del proveedor. */
  prices_as_of: string | null
}

export function suggestionFor(ref: ReferenceData | null | undefined, condition: CardCondition | null | undefined, rules: PricingRules): Suggestion {
  if (!ref || !condition) return { status: 'no_reference' }
  return suggestPrice({ marketUsd: ref.market_usd, midUsd: ref.mid_usd }, condition, rules)
}

/** Desglose del sugerido: "US$9.25 × $20.00 × 100% NM = $185.00" y sus notas. */
export function breakdownText(s: Suggestion): string {
  if (s.status !== 'ok') return ''
  return [`${s.breakdown} = ${formatMoney(s.raw)}`, ...s.notes].join('\n')
}

/**
 * "Ref. $185 · actualizado hoy". Al pasar el cursor (o tocarlo) muestra el
 * desglose. Sin tipo de cambio: aviso para configurarlo.
 */
export function SuggestedPriceLine({
  suggestion,
  asOf,
  isAdmin,
  inline,
  className = '',
}: {
  suggestion: Suggestion
  asOf: string | null
  isAdmin?: boolean
  /** Dentro de otro botón (lista del POS): solo texto, el desglose al pasar el cursor. */
  inline?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  if (suggestion.status === 'no_rate') {
    if (inline) return isAdmin ? <span className={`text-caption text-warning-fg ${className}`}>Sin tipo de cambio</span> : null
    return (
      <p className={`text-caption text-warning-fg ${className}`}>
        {isAdmin ? (
          <Link to="/configuracion#singles" className="underline" onClick={(e) => e.stopPropagation()}>
            Configura tu tipo de cambio para ver precios sugeridos
          </Link>
        ) : (
          'Configura tu tipo de cambio para ver precios sugeridos'
        )}
      </p>
    )
  }
  if (suggestion.status === 'no_reference') {
    if (inline) return <span className={`text-caption text-ink-subtle ${className}`}>Sin precio de referencia</span>
    return <p className={`text-caption text-ink-subtle ${className}`}>Sin precio de referencia</p>
  }
  const text = breakdownText(suggestion)
  if (inline) {
    return (
      <span title={text} className={`cursor-help text-caption text-ink-muted ${className}`}>
        Ref. <span className="font-semibold text-ink tabular-nums">{formatMoney(suggestion.price)}</span> · {dataAgeLabel(asOf)}
      </span>
    )
  }
  return (
    <span className={`relative inline-block ${className}`}>
      <button
        type="button"
        title={text}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        className="cursor-help text-caption text-ink-muted underline decoration-dotted underline-offset-2 hover:text-ink"
      >
        Ref. <span className="font-semibold text-ink tabular-nums">{formatMoney(suggestion.price)}</span> · {dataAgeLabel(asOf)}
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute top-full left-0 z-30 mt-1 block w-max max-w-72 border border-line bg-surface px-3 py-2 text-caption whitespace-pre-line text-ink shadow-popover"
        >
          {text}
        </span>
      )}
    </span>
  )
}

/** Precio actual, sugerido, fecha del dato, margen y botón "Aplicar precio sugerido" (ficha del single). */
export function SuggestedPricePanel({
  productId,
  productName,
  currentPrice,
  reference,
  condition,
  rules,
  fifoCost,
  isAdmin,
  onApplied,
}: {
  productId: string
  productName: string
  currentPrice: number
  reference: ReferenceData | null
  condition: CardCondition | null
  rules: PricingRules
  fifoCost: number | null
  isAdmin: boolean
  onApplied?: (price: number) => void
}) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const s = suggestionFor(reference, condition, rules)
  const margin = marginPct(currentPrice, fifoCost)

  async function apply() {
    if (s.status !== 'ok' || busy) return
    if (!window.confirm(`¿Cambiar el precio de venta de "${productName}" de ${formatMoney(currentPrice)} a ${formatMoney(s.price)}?`)) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await applySinglePrices([{ product_id: productId, price: s.price, expected_price: currentPrice }])
      if (r.applied) {
        setMsg({ ok: true, text: `Nuevo precio: ${formatMoney(s.price)}.` })
        onApplied?.(s.price)
      } else {
        setMsg({ ok: false, text: 'No se aplicó: el precio cambió mientras tanto. Vuelve a abrir la ficha.' })
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 border border-line bg-subtle p-3">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <p>
          <span className="text-caption text-ink-muted">Precio de venta </span>
          <span className="text-label tabular-nums">{formatMoney(currentPrice)}</span>
        </p>
        {s.status === 'ok' && (
          <p>
            <span className="text-caption text-ink-muted">Sugerido </span>
            <span className="text-label tabular-nums">{formatMoney(s.price)}</span>
          </p>
        )}
        <SuggestedPriceLine suggestion={s} asOf={reference?.prices_as_of ?? null} isAdmin={isAdmin} />
      </div>
      {s.status === 'ok' && <p className="text-caption whitespace-pre-line text-ink-muted">{breakdownText(s)}</p>}
      {isAdmin && fifoCost != null && (
        <p className="text-caption text-ink-muted">
          Costo {formatMoney(fifoCost)} · Venta {formatMoney(currentPrice)} · Margen{' '}
          <span className={margin != null && margin < 0 ? 'text-danger-fg' : 'text-ink'}>{margin == null ? '—' : `${Math.round(margin)}%`}</span>
        </p>
      )}
      {isAdmin && s.status === 'ok' && s.price !== currentPrice && (
        <div>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void apply()}>
            <Icon name="check" />
            {busy ? 'Aplicando…' : 'Aplicar precio sugerido'}
          </button>
        </div>
      )}
      {msg && <p className={`text-caption ${msg.ok ? 'text-success-fg' : 'text-danger-fg'}`}>{msg.text}</p>}
    </div>
  )
}

/** Bloque de la ficha de un producto que es single: carga su referencia y muestra el panel. */
export function SingleProductReference({
  product,
  isAdmin,
  onApplied,
}: {
  product: { id: string; name: string; price: number; card_condition?: CardCondition | null }
  isAdmin: boolean
  onApplied?: (price: number) => void
}) {
  const rules = usePricingRules()
  const refs = useSingleRefs([product.id])
  const ref = refs.get(product.id)
  if (!ref) return <p className="text-caption text-ink-subtle">Cargando precio de referencia…</p>
  return (
    <div className="flex flex-col gap-1">
      <p className="text-caption text-ink-muted">
        Single: {ref.card_name}
        {ref.card_number ? ` (${ref.card_number})` : ''} · {ref.set_name} · {ref.tcg_subtype} · {ref.card_condition} · {ref.game_name}
      </p>
      <SuggestedPricePanel
        productId={product.id}
        productName={product.name}
        currentPrice={product.price}
        reference={ref}
        condition={product.card_condition ?? ref.card_condition}
        rules={rules}
        fifoCost={ref.fifo_cost}
        isAdmin={isAdmin}
        onApplied={onApplied}
      />
    </div>
  )
}
