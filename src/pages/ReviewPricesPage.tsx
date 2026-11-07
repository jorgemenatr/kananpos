import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { LanguageTag } from '../components/LanguageTag'
import { ProductImage } from '../components/ProductImage'
import { SuggestedPriceLine, suggestionFor } from '../components/singles/SuggestedPrice'
import { formatInt, formatMoney } from '../lib/format'
import { dataAgeLabel, marginPct, needsReview, priceDiffPct, type Suggestion } from '../lib/pricing'
import { applySinglePrices, singlesReference, usePricingRules, type SingleReference } from '../lib/singles'
import { isNetworkError } from '../lib/supabase'
import { inventoryStore } from '../store/inventoryStore'

const errorText = (e: unknown) =>
  isNetworkError(e) ? 'Sin conexión: intenta cuando vuelva el internet.' : (e as Error).message

interface Row {
  ref: SingleReference
  s: Extract<Suggestion, { status: 'ok' }>
  diff: number
}

/**
 * Singles cuyo precio de venta difiere del sugerido más del % de la tienda.
 * Se aplican uno por uno o los seleccionados, siempre con confirmación.
 */
export function ReviewPricesPage() {
  const rules = usePricingRules()
  const [refs, setRefs] = useState<SingleReference[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [threshold, setThreshold] = useState<string | null>(null)
  const [withoutStock, setWithoutStock] = useState(false)
  const [game, setGame] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    setError(null)
    singlesReference(null)
      .then(setRefs)
      .catch((e) => setError(errorText(e)))
  }, [])
  useEffect(load, [load])

  const th = threshold == null ? rules.reviewThresholdPct : Number(threshold.replace(',', '.'))
  const games = useMemo(() => {
    const m = new Map<number, string>()
    for (const r of refs ?? []) m.set(r.game_id, r.game_name)
    return [...m]
  }, [refs])

  const { rows, noReference } = useMemo(() => {
    const out: Row[] = []
    let noRef = 0
    for (const ref of refs ?? []) {
      if (!withoutStock && ref.quantity + ref.warehouse_quantity <= 0) continue
      if (game != null && ref.game_id !== game) continue
      const s = suggestionFor(ref, ref.card_condition, rules)
      if (s.status === 'no_reference') noRef++
      if (s.status !== 'ok' || !needsReview(ref.price, s, Number.isFinite(th) ? th : 0)) continue
      out.push({ ref, s, diff: priceDiffPct(ref.price, s.price) })
    }
    out.sort((a, b) => b.diff - a.diff)
    return { rows: out, noReference: noRef }
  }, [refs, rules, th, withoutStock, game])

  // Lo seleccionado que ya no está en la lista se suelta.
  const visible = new Set(rows.map((r) => r.ref.product_id))
  const chosen = rows.filter((r) => selected.has(r.ref.product_id))

  async function apply(list: Row[]) {
    if (!list.length || busy) return
    const text =
      list.length === 1
        ? `¿Cambiar el precio de "${list[0].ref.name}" de ${formatMoney(list[0].ref.price)} a ${formatMoney(list[0].s.price)}?`
        : `¿Aplicar el precio sugerido a ${formatInt(list.length)} singles?\n\nSolo cambia el precio de venta de los seleccionados.`
    if (!window.confirm(text)) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await applySinglePrices(list.map((x) => ({ product_id: x.ref.product_id, price: x.s.price, expected_price: x.ref.price })))
      setMsg({
        ok: true,
        text:
          `Se aplicó el precio sugerido a ${formatInt(r.applied)} single(s).` +
          (r.skipped.length ? ` ${formatInt(r.skipped.length)} no se tocaron porque su precio cambió mientras tanto.` : ''),
      })
      setSelected(new Set())
      load()
      void inventoryStore.refreshProducts()
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) })
    } finally {
      setBusy(false)
    }
  }

  const asOf = refs?.reduce<string | null>((m, r) => (r.prices_as_of && (!m || r.prices_as_of > m) ? r.prices_as_of : m), null) ?? null
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.ref.product_id))

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div>
        <h1 className="hidden text-title-lg uppercase md:block">Revisar precios</h1>
        <p className="text-caption text-ink-muted">
          Singles en inventario cuyo precio de venta difiere del sugerido. Nada cambia hasta que lo apliques.
          {asOf && ` Precios de referencia ${dataAgeLabel(asOf)}.`}
        </p>
      </div>

      {rules.usdMxnRate == null && (
        <p className="notice bg-warning-bg text-warning-fg">
          <Icon name="alert" className="mt-0.5" />
          <span>
            <Link to="/configuracion#singles" className="underline">
              Configura tu tipo de cambio para ver precios sugeridos
            </Link>
            .
          </span>
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-40">
          <label className="field-label" htmlFor="rp-th">
            Difiere más de (%)
          </label>
          <input
            id="rp-th"
            className="field tabular-nums"
            inputMode="decimal"
            value={threshold ?? String(rules.reviewThresholdPct)}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </div>
        {games.length > 1 && (
          <div>
            <label className="field-label" htmlFor="rp-game">
              Juego
            </label>
            <select id="rp-game" className="field cursor-pointer" value={game ?? ''} onChange={(e) => setGame(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Todos</option>
              {games.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        )}
        <label className="flex cursor-pointer items-center gap-2 pb-2">
          <input type="checkbox" checked={withoutStock} onChange={(e) => setWithoutStock(e.target.checked)} />
          Incluir singles sin piezas
        </label>
        <button
          type="button"
          className="btn btn-primary ml-auto"
          disabled={busy || !chosen.length}
          onClick={() => void apply(chosen)}
        >
          <Icon name="check" />
          {busy ? 'Aplicando…' : `Aplicar a seleccionados (${formatInt(chosen.length)})`}
        </button>
      </div>

      {msg && (
        <p className={`notice ${msg.ok ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg'}`} role="status">
          <Icon name={msg.ok ? 'check' : 'alert'} className="mt-0.5" />
          {msg.text}
        </p>
      )}
      {error && <p className="notice bg-danger-bg text-danger-fg">{error}</p>}
      {!refs && !error && <p className="text-ink-subtle">Cargando…</p>}

      {refs && (
        <section className="card flex flex-col">
          <div className="flex items-center gap-3 border-b border-line px-3 py-2 text-caption text-ink-muted">
            <input
              type="checkbox"
              aria-label="Seleccionar todos"
              checked={allChecked}
              disabled={!rows.length}
              onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.ref.product_id)) : new Set())}
            />
            <span>
              {formatInt(rows.length)} por revisar
              {noReference > 0 && ` · ${formatInt(noReference)} sin precio de referencia`}
            </span>
          </div>
          {!rows.length && (
            <p className="py-10 text-center text-ink-subtle">
              {refs.length ? 'Todos tus singles están dentro del margen. 🎉' : 'Todavía no hay singles en el inventario.'}
            </p>
          )}
          <ul className="flex flex-col divide-y divide-line">
            {rows.map(({ ref, s, diff }) => {
              const marginNow = marginPct(ref.price, ref.fifo_cost)
              const marginNew = marginPct(s.price, ref.fifo_cost)
              const up = s.price > ref.price
              return (
                <li key={ref.product_id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Seleccionar ${ref.name}`}
                    checked={selected.has(ref.product_id) && visible.has(ref.product_id)}
                    onChange={(e) =>
                      setSelected((cur) => {
                        const next = new Set(cur)
                        if (e.target.checked) next.add(ref.product_id)
                        else next.delete(ref.product_id)
                        return next
                      })
                    }
                  />
                  <ProductImage path={ref.image_url} alt="" className="h-14 w-10 shrink-0 rounded-xs" />
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="text-label break-words text-ink">
                      <LanguageTag language={ref.language} className="mr-1.5" />
                      {ref.name}
                    </p>
                    <p className="text-caption text-ink-muted">
                      {ref.game_name} · {formatInt(ref.quantity)} en tienda
                      {ref.warehouse_quantity > 0 && ` · ${formatInt(ref.warehouse_quantity)} en bodega`} ·{' '}
                      <span className="font-mono">{ref.barcode}</span>
                    </p>
                    {ref.fifo_cost != null && (
                      <p className="text-caption text-ink-muted">
                        Costo {formatMoney(ref.fifo_cost)} · Venta {formatMoney(ref.price)} · Margen{' '}
                        {marginNow == null ? '—' : `${Math.round(marginNow)}%`}
                        {marginNew != null && ` → ${Math.round(marginNew)}% con el sugerido`}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-4 text-right">
                    <div>
                      <p className="text-caption text-ink-muted">Actual</p>
                      <p className="text-label tabular-nums">{formatMoney(ref.price)}</p>
                    </div>
                    <div>
                      <p className="text-caption text-ink-muted">Sugerido</p>
                      <p className="text-label tabular-nums">{formatMoney(s.price)}</p>
                      <p className={`text-caption tabular-nums ${up ? 'text-success-fg' : 'text-danger-fg'}`}>
                        {up ? '▲' : '▼'} {diff === Infinity ? '—' : `${Math.round(diff)}%`}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void apply([{ ref, s, diff }])}>
                        Aplicar
                      </button>
                      <SuggestedPriceLine suggestion={s} asOf={ref.prices_as_of} isAdmin className="text-left" />
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
