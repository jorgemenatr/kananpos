import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { formatDateTime, formatInt, parseMoney } from '../../lib/format'
import { CONDITIONS, CONDITION_LABELS, ROUNDING_LABELS, type CardCondition, type Rounding } from '../../lib/pricing'
import {
  fxRateHistory,
  gameStock,
  listGames,
  setGameEnabled,
  updatePricingRules,
  usePricingRules,
  type FxRateChange,
  type TcgGameSetting,
} from '../../lib/singles'
import { isNetworkError } from '../../lib/supabase'
import { Icon } from '../Icon'

const errorText = (e: unknown) =>
  isNetworkError(e) ? 'Sin conexión: intenta cuando vuelva el internet.' : (e as Error).message

/** Configuración → Singles y juegos: juegos activos y reglas de precio. */
export function SinglesConfig() {
  const { hash } = useLocation()
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (hash === '#singles') ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [hash])

  return (
    <section ref={ref} id="singles" className="card flex scroll-mt-4 flex-col gap-5 p-4">
      <div>
        <h2 className="text-title">Singles y juegos</h2>
        <p className="text-caption text-ink-muted">
          Cartas sueltas con precio de referencia del mercado (TCGplayer, en dólares). El catálogo se actualiza solo cada día a
          las 5:00. El precio de venta nunca cambia solo: tú decides cuándo aplicar el sugerido.
        </p>
      </div>
      <GamesBlock />
      <PricingRulesBlock />
    </section>
  )
}

// ---------------------------------------------------------------------
// a) Juegos
// ---------------------------------------------------------------------
function statusBadge(g: TcgGameSetting) {
  if (!g.enabled && g.catalog_status !== 'ready') return null
  switch (g.catalog_status) {
    case 'pending':
      return <span className="badge badge-warning">{g.status_message === 'Descarga solicitada' ? 'Descargando catálogo…' : 'Pendiente de descarga'}</span>
    case 'downloading':
      return <span className="badge badge-warning">Descargando catálogo…</span>
    case 'ready':
      return g.enabled ? <span className="badge badge-success">Listo</span> : null
    case 'error':
      return <span className="badge badge-danger">Error al descargar</span>
    default:
      return null
  }
}

function GamesBlock() {
  const [games, setGames] = useState<TcgGameSetting[] | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(() => {
    listGames()
      .then(setGames)
      .catch((e) => setMsg({ ok: false, text: errorText(e) }))
  }, [])
  useEffect(load, [load])

  // Mientras se descarga algún juego, se revisa el estado cada 10 s.
  const loading = games?.some((g) => g.enabled && (g.catalog_status === 'pending' || g.catalog_status === 'downloading'))
  useEffect(() => {
    if (!loading) return
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [loading, load])

  async function toggle(g: TcgGameSetting) {
    if (busy) return
    setMsg(null)
    const enable = !g.enabled
    if (!enable) {
      let stock = 0
      try {
        stock = await gameStock(g.id)
      } catch (e) {
        setMsg({ ok: false, text: errorText(e) })
        return
      }
      if (
        stock > 0 &&
        !window.confirm(
          `La tienda tiene ${formatInt(stock)} pieza(s) de ${g.display_name}.\n\n` +
            'Sus cartas dejarán de aparecer en búsquedas y altas, pero el inventario que ya existe NO se borra (se sigue vendiendo).\n\n' +
            `¿Desactivar ${g.display_name}?`,
        )
      )
        return
    }
    setBusy(g.id)
    try {
      const r = await setGameEnabled(g, enable)
      if (!enable) setMsg({ ok: true, text: `Se desactivó ${g.display_name}.` })
      else if (r.catalog_status === 'ready') setMsg({ ok: true, text: `Se activó ${g.display_name}.` })
      else if (r.requestError) setMsg({ ok: false, text: `Se activó ${g.display_name}, pero no se pudo pedir la descarga: ${r.requestError}` })
      else setMsg({ ok: true, text: `Se activó ${g.display_name}. Descargando su catálogo en segundo plano (puede tardar unos minutos).` })
      load()
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-label">Juegos</h3>
      <p className="text-caption text-ink-muted">
        Solo los juegos activos aparecen al buscar cartas, en el alta de singles y en el mostrador. Desactivar uno no borra su
        inventario.
      </p>
      {!games && !msg && <p className="text-caption text-ink-subtle">Cargando…</p>}
      {games && !games.length && (
        <p className="text-caption text-ink-subtle">
          Todavía no hay juegos: aparecen después de la primera actualización del catálogo.
        </p>
      )}
      {games && games.length > 0 && (
        <ul className="flex flex-col divide-y divide-line border border-line">
          {games.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <button
                type="button"
                role="switch"
                aria-checked={g.enabled}
                aria-label={`${g.enabled ? 'Desactivar' : 'Activar'} ${g.display_name}`}
                disabled={busy !== null}
                onClick={() => void toggle(g)}
                className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-wait disabled:opacity-60 ${g.enabled ? 'bg-brand' : 'bg-control'}`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform ${g.enabled ? 'translate-x-5' : ''}`}
                />
              </button>
              <div className="min-w-0 flex-1">
                <p className={g.enabled ? 'text-label text-ink' : 'text-ink-muted'}>{g.display_name}</p>
                <p className="text-caption text-ink-subtle">
                  {g.product_count > 0 ? `${formatInt(g.product_count)} cartas` : 'Sin catálogo'}
                  {g.prices_as_of && ` · actualizado ${formatDateTime(g.prices_as_of)}`}
                </p>
                {g.catalog_status === 'error' && g.status_message && (
                  <p className="text-caption text-danger-fg">{g.status_message}</p>
                )}
              </div>
              {statusBadge(g)}
            </li>
          ))}
        </ul>
      )}
      {msg && (
        <p className={`notice ${msg.ok ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg'}`} role="status">
          <Icon name={msg.ok ? 'check' : 'alert'} className="mt-0.5" />
          {msg.text}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// b) Reglas de precio
// ---------------------------------------------------------------------
const fmt = (n: number | null) => (n == null ? '' : String(n))

function PricingRulesBlock() {
  const rules = usePricingRules()
  const [rate, setRate] = useState(fmt(rules.usdMxnRate))
  const [multiplier, setMultiplier] = useState(fmt(rules.multiplier))
  const [rounding, setRounding] = useState<Rounding>(rules.rounding)
  const [pcts, setPcts] = useState<Record<CardCondition, string>>(
    Object.fromEntries(CONDITIONS.map((c) => [c, fmt(rules.conditionPercentages[c])])) as Record<CardCondition, string>,
  )
  const [minPrice, setMinPrice] = useState(fmt(rules.minPrice))
  const [threshold, setThreshold] = useState(fmt(rules.reviewThresholdPct))
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string; review?: boolean } | null>(null)
  const [history, setHistory] = useState<FxRateChange[] | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  // Cuando llegan las reglas de la base, se llenan los campos.
  const loadedKey = JSON.stringify(rules)
  useEffect(() => {
    setRate(fmt(rules.usdMxnRate))
    setMultiplier(fmt(rules.multiplier))
    setRounding(rules.rounding)
    setPcts(Object.fromEntries(CONDITIONS.map((c) => [c, fmt(rules.conditionPercentages[c])])) as Record<CardCondition, string>)
    setMinPrice(fmt(rules.minPrice))
    setThreshold(fmt(rules.reviewThresholdPct))
  }, [loadedKey])

  useEffect(() => {
    if (showHistory) void fxRateHistory().then(setHistory).catch(() => setHistory([]))
  }, [showHistory, rules.rateUpdatedAt])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (saving) return
    setMsg(null)
    const r = parseMoney(rate)
    if (r == null || Number.isNaN(r) || r <= 0) return setMsg({ ok: false, text: 'Escribe el tipo de cambio de venta (pesos por 1 dólar), por ejemplo 20.00.' })
    if (r >= 1000) return setMsg({ ok: false, text: 'El tipo de cambio parece demasiado alto.' })
    const m = Number(multiplier.replace(',', '.'))
    if (!Number.isFinite(m) || m <= 0 || m > 10) return setMsg({ ok: false, text: 'El multiplicador debe ser mayor que 0 (1.00 = sin cambio).' })
    const cp = {} as Record<CardCondition, number>
    for (const c of CONDITIONS) {
      const v = Number(pcts[c].replace(',', '.'))
      if (!Number.isFinite(v) || v < 0 || v > 200) return setMsg({ ok: false, text: `El porcentaje de ${c} debe estar entre 0 y 200.` })
      cp[c] = v
    }
    const min = parseMoney(minPrice)
    if (min == null || Number.isNaN(min)) return setMsg({ ok: false, text: 'Escribe el precio mínimo (0 = sin mínimo).' })
    const th = Number(threshold.replace(',', '.'))
    if (!Number.isFinite(th) || th < 0 || th > 1000) return setMsg({ ok: false, text: 'La diferencia para revisar precios debe estar entre 0 y 1000 %.' })

    const rateChanged = r !== rules.usdMxnRate
    setSaving(true)
    try {
      await updatePricingRules({
        usdMxnRate: r,
        multiplier: m,
        rounding,
        conditionPercentages: cp,
        minPrice: min,
        reviewThresholdPct: th,
      })
      setMsg({
        ok: true,
        review: true,
        text: rateChanged
          ? 'Se guardó el tipo de cambio. Los precios sugeridos ya usan el nuevo valor; tus precios de venta no cambiaron.'
          : 'Se guardaron las reglas de precio. Tus precios de venta no cambiaron.',
      })
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
      <h3 className="text-label">Reglas de precio</h3>
      {rules.usdMxnRate == null && (
        <p className="notice bg-warning-bg text-warning-fg">
          <Icon name="alert" className="mt-0.5" />
          Configura tu tipo de cambio para ver precios sugeridos.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-48">
          <label className="field-label" htmlFor="pr-rate">
            Tipo de cambio de venta *
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-subtle">$</span>
            <input
              id="pr-rate"
              className="field pl-7 tabular-nums"
              inputMode="decimal"
              placeholder="20.00"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </div>
        </div>
        <p className="max-w-md pb-2 text-caption text-ink-muted">
          Pesos por 1 dólar: el valor al que tu tienda "vende el dólar". No se consulta ninguna fuente externa.
        </p>
      </div>
      <p className="text-caption text-ink-subtle">
        {rules.rateUpdatedAt
          ? `Última modificación: ${formatDateTime(rules.rateUpdatedAt)}${rules.rateUpdatedBy ? ` por ${rules.rateUpdatedBy}` : ''}. `
          : 'Todavía no se ha configurado. '}
        <button type="button" className="underline" onClick={() => setShowHistory((s) => !s)}>
          {showHistory ? 'Ocultar historial' : 'Ver historial'}
        </button>
      </p>
      {showHistory && (
        <div className="max-h-48 overflow-auto border border-line">
          {!history && <p className="p-2 text-caption text-ink-subtle">Cargando…</p>}
          {history && !history.length && <p className="p-2 text-caption text-ink-subtle">Sin cambios todavía.</p>}
          {history && history.length > 0 && (
            <table className="w-full text-caption">
              <thead className="bg-subtle text-left text-ink-muted">
                <tr>
                  <th className="px-2 py-1 font-medium">Fecha</th>
                  <th className="px-2 py-1 text-right font-medium">Anterior</th>
                  <th className="px-2 py-1 text-right font-medium">Nuevo</th>
                  <th className="px-2 py-1 font-medium">Usuario</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="px-2 py-1">{formatDateTime(h.changed_at)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{h.old_rate == null ? '—' : `$${h.old_rate.toFixed(2)}`}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{h.new_rate == null ? '—' : `$${h.new_rate.toFixed(2)}`}</td>
                    <td className="px-2 py-1">{h.changed_by_name || h.changed_by_email || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="field-label" htmlFor="pr-mult">
            Multiplicador
          </label>
          <input id="pr-mult" className="field tabular-nums" inputMode="decimal" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} />
          <p className="mt-1 text-caption text-ink-subtle">1.00 = precio de mercado; 1.10 = 10 % arriba.</p>
        </div>
        <div>
          <label className="field-label" htmlFor="pr-round">
            Redondeo
          </label>
          <select id="pr-round" className="field cursor-pointer" value={rounding} onChange={(e) => setRounding(e.target.value as Rounding)}>
            {(Object.keys(ROUNDING_LABELS) as Rounding[]).map((r) => (
              <option key={r} value={r}>
                {ROUNDING_LABELS[r]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-caption text-ink-subtle">Al más cercano.</p>
        </div>
        <div>
          <label className="field-label" htmlFor="pr-min">
            Precio mínimo por single
          </label>
          <input id="pr-min" className="field tabular-nums" inputMode="decimal" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} />
        </div>
        <div>
          <label className="field-label" htmlFor="pr-th">
            Revisar si difiere más de (%)
          </label>
          <input id="pr-th" className="field tabular-nums" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        </div>
      </div>

      <fieldset>
        <legend className="field-label">Porcentaje por estado de la carta</legend>
        <div className="grid grid-cols-5 gap-2">
          {CONDITIONS.map((c) => (
            <div key={c}>
              <label className="block text-caption text-ink-muted" htmlFor={`pr-c-${c}`} title={CONDITION_LABELS[c]}>
                {c}
              </label>
              <div className="relative">
                <input
                  id={`pr-c-${c}`}
                  className="field pr-6 tabular-nums"
                  inputMode="decimal"
                  value={pcts[c]}
                  onChange={(e) => setPcts((p) => ({ ...p, [c]: e.target.value }))}
                />
                <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-ink-subtle">%</span>
              </div>
            </div>
          ))}
        </div>
      </fieldset>

      <div>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          <Icon name="check" />
          {saving ? 'Guardando…' : 'Guardar reglas de precio'}
        </button>
      </div>
      {msg && (
        <p className={`notice ${msg.ok ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg'}`} role="status">
          <Icon name={msg.ok ? 'check' : 'alert'} className="mt-0.5" />
          <span>
            {msg.text}
            {msg.review && (
              <>
                {' '}
                <Link to="/revisar-precios" className="font-medium underline">
                  Revisar precios
                </Link>
              </>
            )}
          </span>
        </p>
      )}
    </form>
  )
}
