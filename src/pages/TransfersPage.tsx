import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LanguageTag, nameWithLanguage, useLanguageLookup } from '../components/LanguageTag'
import { Icon } from '../components/Icon'
import { ProductImage } from '../components/ProductImage'
import { ProductPicker } from '../components/pos/ProductPicker'
import { formatDateTime, formatInt, formatMoney, parseCount } from '../lib/format'
import { isNetworkError } from '../lib/supabase'
import { createTransfer, getTransferLots, listTransfers, TransferStockError } from '../lib/transfers'
import { LOCATION_LABELS, type StockLocation, type TransferLotRow, type TransferRow } from '../lib/types'
import { sounds } from '../lib/sounds'
import { inventoryStore, qtyAt, type CachedProduct } from '../store/inventoryStore'
import { useInventory } from '../store/useInventory'

/*
 * Movimiento de bodega (solo admin): pasa piezas de bodega a tienda (o al
 * revés). Se confirma todo junto con una sola llamada: si a algún producto no
 * le alcanza el origen, no se mueve nada. Un error se corrige con otro
 * movimiento en sentido contrario.
 */

interface Line {
  barcode: string
  productId: string
  name: string
  imagePath: string | null
  qtyText: string
}

const other = (l: StockLocation): StockLocation => (l === 'store' ? 'warehouse' : 'store')

export function TransfersPage() {
  const { products, online } = useInventory()
  const languages = useLanguageLookup()
  const [from, setFrom] = useState<StockLocation>('warehouse')
  const to = other(from)
  const [lines, setLines] = useState<Line[]>([])
  const [note, setNote] = useState('')
  // Al revisar se genera el id: reintentar la confirmación no duplica el movimiento.
  const [review, setReview] = useState<{ id: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Lo disponible que reportó el servidor cuando no alcanzó.
  const [serverAvailable, setServerAvailable] = useState<Record<string, number>>({})
  const [done, setDone] = useState<string | null>(null)
  const [history, setHistory] = useState<TransferRow[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const pickerRef = useRef<HTMLInputElement>(null)

  const loadHistory = useCallback(() => {
    listTransfers()
      .then((h) => {
        setHistory(h)
        setHistoryError(null)
      })
      .catch((e) => setHistoryError(isNetworkError(e) ? 'Sin conexión: el historial necesita internet.' : (e as Error).message))
  }, [])

  useEffect(() => {
    if (online) void inventoryStore.refreshProducts()
    loadHistory()
    // Solo al entrar a la página.
  }, [])

  const available = useCallback((p: CachedProduct) => qtyAt(p, from), [from])

  const rows = useMemo(
    () =>
      lines.map((l) => {
        const p = products[l.barcode]
        const avail = l.productId in serverAvailable ? serverAvailable[l.productId] : p ? qtyAt(p, from) : 0
        const qty = parseCount(l.qtyText, 1)
        return { ...l, avail, qty, invalid: Number.isNaN(qty), short: !Number.isNaN(qty) && qty > avail }
      }),
    [lines, products, from, serverAvailable],
  )
  const pieces = rows.reduce((s, r) => s + (Number.isNaN(r.qty) ? 0 : r.qty), 0)
  const canReview = online && rows.length > 0 && rows.every((r) => !r.invalid && !r.short)

  function invert() {
    setFrom(to)
    setReview(null)
    setServerAvailable({})
    setError(null)
  }

  function add(p: CachedProduct) {
    setDone(null)
    setError(null)
    setReview(null)
    if (p.pending || p.id.startsWith('pending:')) {
      sounds.error()
      setError(`${p.name} aún no se sincroniza. Espera a tener conexión.`)
      return
    }
    setLines((ls) => {
      const existing = ls.find((l) => l.barcode === p.barcode)
      if (existing) {
        const n = parseCount(existing.qtyText, 1)
        return ls.map((l) => (l.barcode === p.barcode ? { ...l, qtyText: String((Number.isNaN(n) ? 0 : n) + 1) } : l))
      }
      return [...ls, { barcode: p.barcode, productId: p.id, name: p.name, imagePath: p.image_url, qtyText: '1' }]
    })
    if (qtyAt(p, from) <= 0) sounds.error()
    else sounds.success()
    setTimeout(() => pickerRef.current?.focus(), 0)
  }

  function setQty(barcode: string, qtyText: string) {
    setReview(null)
    setLines((ls) => ls.map((l) => (l.barcode === barcode ? { ...l, qtyText } : l)))
  }

  async function confirm() {
    if (!review || busy) return
    setBusy(true)
    setError(null)
    try {
      await createTransfer({
        id: review.id,
        from,
        to,
        note,
        items: rows.map((r) => ({ productId: r.productId, quantity: r.qty })),
      })
      sounds.success()
      setDone(`Listo: ${formatInt(pieces)} pzas de ${rows.length} producto(s) pasaron de ${LOCATION_LABELS[from]} a ${LOCATION_LABELS[to]}.`)
      setLines([])
      setNote('')
      setReview(null)
      setServerAvailable({})
      void inventoryStore.refreshProducts()
      loadHistory()
    } catch (e) {
      sounds.error()
      if (e instanceof TransferStockError) {
        setServerAvailable(Object.fromEntries(e.shortages.map((s) => [s.product_id, s.available])))
        setReview(null)
        setError(`No se movió nada. ${e.message}`)
        void inventoryStore.refreshProducts()
      } else {
        setError(isNetworkError(e) ? 'Sin conexión: no se hizo el movimiento. Intenta de nuevo cuando vuelva el internet.' : (e as Error).message)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <h1 className="hidden text-title-lg uppercase md:block">Movimiento de bodega</h1>

      {!online && (
        <p className="notice bg-warning-bg text-warning-fg">
          <Icon name="wifi-off" className="mt-0.5" />
          Sin conexión: los movimientos de bodega necesitan internet.
        </p>
      )}
      {done && (
        <p className="notice bg-success-bg text-success-fg" role="status">
          <Icon name="check" className="mt-0.5" />
          {done}
        </p>
      )}

      <section className="card flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-title-lg max-md:text-title">
            {LOCATION_LABELS[from]} <span className="text-ink-subtle">→</span> {LOCATION_LABELS[to]}
          </p>
          <button type="button" onClick={invert} className="btn btn-secondary">
            <Icon name="swap" />
            Invertir
          </button>
          <p className="basis-full text-caption text-ink-muted">
            {from === 'warehouse'
              ? 'Se mueven primero las piezas de los lotes más viejos (así se venden primero).'
              : 'Se regresan primero las piezas de los lotes más nuevos (la tienda conserva lo más viejo para vender).'}
          </p>
        </div>

        <ProductPicker
          id="tr-product"
          label={`Agregar producto: escanea el código o busca por nombre (se muestra lo que hay en ${LOCATION_LABELS[from].toLowerCase()})`}
          inputRef={pickerRef}
          products={products}
          available={available}
          onPick={add}
          disabled={!online}
          showPrice={false}
          availableText={(_p, n) => `En ${LOCATION_LABELS[from].toLowerCase()}: ${formatInt(n)}`}
          unavailableText={() => `Sin piezas en ${LOCATION_LABELS[from].toLowerCase()}`}
        />

        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-line">
            {/* En el celular cada renglón se acomoda en dos líneas. */}
            <table className="w-full border-collapse text-left max-md:block">
              <thead className="max-md:hidden">
                <tr className="thead-row">
                  <th className="h-control-md px-3 font-medium">Producto</th>
                  <th className="h-control-md px-3 text-right font-medium">En {LOCATION_LABELS[from].toLowerCase()}</th>
                  <th className="h-control-md px-3 text-right font-medium">Mover</th>
                  <th className="h-control-md w-12 px-2" />
                </tr>
              </thead>
              <tbody className="max-md:block">
                {rows.map((r) => (
                  <tr key={r.barcode} className="border-t border-line max-md:grid max-md:grid-cols-[1fr_auto_auto] max-md:items-center max-md:gap-x-3 max-md:gap-y-2 max-md:px-3 max-md:py-3">
                    <td className="px-3 py-2 max-md:col-span-2 max-md:p-0">
                      <div className="flex items-center gap-3">
                        <ProductImage path={r.imagePath} alt="" className="size-10 shrink-0 rounded-xs" />
                        <div className="min-w-0">
                          <p className="font-medium md:truncate">
                            <LanguageTag language={languages.get(r.barcode)} className="mr-1.5" />
                            {r.name}
                          </p>
                          <p className="font-mono text-caption break-all text-ink-subtle md:truncate">{r.barcode}</p>
                        </div>
                      </div>
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums max-md:row-start-2 max-md:self-start max-md:p-0 max-md:text-left ${r.short ? 'font-medium text-danger-fg' : ''}`}>
                      <span className="block text-caption text-ink-muted md:hidden">En {LOCATION_LABELS[from].toLowerCase()}</span>
                      {formatInt(r.avail)}
                    </td>
                    <td className="px-3 py-2 text-right max-md:col-span-2 max-md:row-start-2 max-md:p-0">
                      <span className="block text-caption text-ink-muted md:hidden">Mover</span>
                      <input
                        value={r.qtyText}
                        onChange={(e) => setQty(r.barcode, e.target.value)}
                        inputMode="numeric"
                        autoComplete="off"
                        aria-label={`Piezas a mover de ${r.name}`}
                        aria-invalid={r.invalid || r.short}
                        className={`field h-control-sm w-20 text-right tabular-nums ${r.invalid || r.short ? 'border-danger-fg bg-danger-bg text-danger-fg' : ''}`}
                      />
                      {r.short && (
                        <p className="mt-1 text-caption text-danger-fg">
                          Solo hay {formatInt(r.avail)} en {LOCATION_LABELS[from].toLowerCase()}
                        </p>
                      )}
                    </td>
                    <td className="px-2 py-2 max-md:col-start-3 max-md:row-start-1 max-md:justify-self-end max-md:p-0">
                      <button
                        type="button"
                        onClick={() => {
                          setReview(null)
                          setLines((ls) => ls.filter((l) => l.barcode !== r.barcode))
                        }}
                        aria-label={`Quitar ${r.name}`}
                        className="grid size-8 cursor-pointer place-items-center rounded-md text-ink-muted hover:bg-subtle hover:text-ink"
                      >
                        <Icon name="x" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div>
          <label className="field-label" htmlFor="tr-note">Notas (opcional)</label>
          <input
            id="tr-note"
            value={note}
            onChange={(e) => {
              setNote(e.target.value)
              setReview(null)
            }}
            placeholder="Ej. Reabasto para el torneo del sábado"
            autoComplete="off"
            className="field"
          />
        </div>

        {error && (
          <p className="notice bg-danger-bg text-danger-fg">
            <Icon name="alert" className="mt-0.5" />
            {error}
          </p>
        )}

        {review ? (
          <div className="rounded-md border-2 border-brand bg-brand-soft p-4 text-brand-ink">
            <p className="text-heading">
              Vas a mover {formatInt(pieces)} pzas de {rows.length} producto(s) de {LOCATION_LABELS[from]} a {LOCATION_LABELS[to]}:
            </p>
            <ul className="mt-2 list-disc pl-5">
              {rows.map((r) => (
                <li key={r.barcode}>
                  <span className="tabular-nums">{formatInt(r.qty)}</span> × {nameWithLanguage(r.name, languages.get(r.barcode))}
                </li>
              ))}
            </ul>
            {note.trim() && <p className="mt-2">Notas: {note.trim()}</p>}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => setReview(null)} className="btn btn-ghost">
                Corregir
              </button>
              <button type="button" onClick={() => void confirm()} disabled={busy || !online} className="btn btn-primary btn-lg">
                <Icon name="check" size={20} />
                {busy ? 'Moviendo…' : 'Confirmar movimiento'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setReview({ id: crypto.randomUUID() })}
              disabled={!canReview}
              className="btn btn-primary btn-lg"
            >
              Revisar movimiento
            </button>
          </div>
        )}
      </section>

      <section className="card overflow-hidden">
        <h2 className="border-b border-line px-5 py-4 text-label tracking-wider text-ink-muted uppercase">Historial de movimientos</h2>
        {historyError && <p className="px-5 py-4 text-danger-fg">{historyError}</p>}
        {history && history.length === 0 && <p className="px-5 py-8 text-center text-ink-subtle">Aún no hay movimientos de bodega.</p>}
        {history && history.length > 0 && (
          <ul className="divide-y divide-line">
            {history.map((t) => (
              <TransferItem key={t.id} transfer={t} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function TransferItem({ transfer: t }: { transfer: TransferRow }) {
  const languages = useLanguageLookup()
  const [open, setOpen] = useState(false)
  const [lots, setLots] = useState<TransferLotRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  function toggle() {
    setOpen((o) => !o)
    if (lots || open) return
    getTransferLots(t.id)
      .then(setLots)
      .catch((e) => setError(isNetworkError(e) ? 'Sin conexión.' : (e as Error).message))
  }

  // Agrupado por producto: total y de qué lotes salió.
  const byProduct = useMemo(() => {
    const m = new Map<string, { name: string; barcode: string; total: number; lots: TransferLotRow[] }>()
    for (const l of lots ?? []) {
      const g = m.get(l.product_id) ?? { name: l.product_name, barcode: l.barcode, total: 0, lots: [] }
      g.total += l.quantity
      g.lots.push(l)
      m.set(l.product_id, g)
    }
    return [...m.values()]
  }, [lots])

  return (
    <li>
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-left hover:bg-subtle">
        <span className="font-medium">
          {LOCATION_LABELS[t.from_location]} → {LOCATION_LABELS[t.to_location]}
        </span>
        <span className="text-ink-muted tabular-nums">
          {formatInt(t.piece_count)} pzas · {formatInt(t.item_count)} producto(s)
        </span>
        <span className="text-ink-muted">{t.created_by_name ?? '—'}</span>
        <span className="ml-auto text-caption text-ink-subtle">{formatDateTime(t.created_at)}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} className="text-ink-subtle" />
        {t.note && <span className="basis-full text-caption text-ink-muted">Notas: {t.note}</span>}
      </button>
      {open && (
        <div className="bg-subtle px-5 py-3">
          {error && <p className="text-danger-fg">{error}</p>}
          {!lots && !error && <p className="text-ink-subtle">Cargando…</p>}
          {byProduct.map((g) => (
            <div key={g.barcode} className="py-1">
              <p>
                <span className="font-medium tabular-nums">{formatInt(g.total)}</span> ×{' '}
                <LanguageTag language={languages.get(g.barcode)} className="mr-1.5" />
                {g.name}{' '}
                <span className="font-mono text-caption text-ink-subtle">{g.barcode}</span>
              </p>
              <ul className="pl-4 text-caption text-ink-muted">
                {g.lots.map((l) => (
                  <li key={l.lot_id}>
                    Lote {l.lot_number}: {formatInt(l.quantity)} pzas · {l.supplier_name ?? 'sin proveedor'} · {formatMoney(l.unit_cost)} c/u
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </li>
  )
}
