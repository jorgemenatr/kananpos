import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LanguageTag, useLanguageLookup } from '../components/LanguageTag'
import { Icon } from '../components/Icon'
import { LocationSelect } from '../components/LocationSelect'
import { ProductFormModal } from '../components/ProductFormModal'
import { ProductImage } from '../components/ProductImage'
import { SupplierSelect } from '../components/SupplierSelect'
import { ProductPicker } from '../components/pos/ProductPicker'
import { formatDateTime, formatInt, formatMoney, parseCount, parseMoney } from '../lib/format'
import { getProduct } from '../lib/products'
import { isInternalCode } from '../lib/barcode'
import { cancelPurchase, getPurchaseItems, listPurchases, updatePurchase } from '../lib/purchases'
import { sounds } from '../lib/sounds'
import { isNetworkError } from '../lib/supabase'
import { LOCATION_LABELS, type PurchaseItemRow, type PurchaseRow, type StockLocation } from '../lib/types'
import { inventoryStore, tracksStock, type CachedProduct, type PurchaseDraft } from '../store/inventoryStore'
import { useInventory } from '../store/useInventory'

/*
 * Compras (solo admin): registrar la mercancía que llega de un proveedor.
 * Cada renglón crea un lote con su costo en la ubicación donde llega
 * (Tienda por defecto). Una compra se corrige (proveedor, costos) o se
 * cancela solo mientras ninguna de sus piezas se haya vendido, movido o
 * ajustado; folio y notas se pueden cambiar siempre.
 *
 * Se captura con el lector: escanear otra vez el mismo producto suma una
 * pieza, y un código que no existe abre el alta ahí mismo (sin cantidad: las
 * piezas entran con la compra). Sin conexión la compra se guarda en la cola y
 * se registra sola al volver el internet.
 */

interface Line {
  key: string
  productId: string
  barcode: string
  name: string
  imagePath: string | null
  qtyText: string
  costText: string
}

const errText = (e: unknown) => (isNetworkError(e) ? 'Sin conexión: intenta cuando vuelva el internet.' : (e as Error).message)

export function PurchasesPage() {
  const { products, online, queue } = useInventory()
  const languages = useLanguageLookup()
  const [supplierId, setSupplierId] = useState<string | null>(null)
  const [supplierName, setSupplierName] = useState('')
  // Alta de un producto nuevo desde la compra (null = sin código: código interno).
  const [creating, setCreating] = useState<{ barcode: string | null } | null>(null)
  const [location, setLocation] = useState<StockLocation>('store')
  const [folio, setFolio] = useState('')
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  // Un id por compra capturada: si se reintenta el registro, no se duplica.
  const [purchaseId, setPurchaseId] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [history, setHistory] = useState<PurchaseRow[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const pickerRef = useRef<HTMLInputElement>(null)

  const loadHistory = useCallback(() => {
    listPurchases()
      .then((h) => {
        setHistory(h)
        setHistoryError(null)
      })
      .catch((e) => setHistoryError(errText(e)))
  }, [])

  useEffect(() => {
    if (online) void inventoryStore.refreshProducts()
    loadHistory()
    // Solo al entrar a la página.
  }, [])

  const rows = useMemo(
    () =>
      lines.map((l) => {
        const qty = parseCount(l.qtyText, 1)
        const cost = parseMoney(l.costText)
        const costOk = cost !== null && !Number.isNaN(cost)
        return { ...l, qty, cost: costOk ? cost : NaN, invalid: Number.isNaN(qty) || !costOk }
      }),
    [lines],
  )
  const total = rows.reduce((s, r) => s + (r.invalid ? 0 : r.qty * r.cost), 0)
  const pieces = rows.reduce((s, r) => s + (Number.isNaN(r.qty) ? 0 : r.qty), 0)
  const canSave = !busy && supplierId !== null && rows.length > 0 && rows.every((r) => !r.invalid)

  // Compras capturadas sin conexión que siguen en la cola.
  const pending = useMemo(() => queue.flatMap((q) => (q.kind === 'purchase' ? [q.purchase] : [])), [queue])
  // Al sincronizarse alguna, se recarga la lista.
  const pendingCount = useRef(pending.length)
  useEffect(() => {
    if (pending.length < pendingCount.current) loadHistory()
    pendingCount.current = pending.length
  }, [pending.length, loadHistory])

  const focusPicker = () => setTimeout(() => pickerRef.current?.focus(), 0)

  /** cost: el del alta recién hecha; si no, se precarga el último del producto. */
  function add(p: CachedProduct, cost?: number | null) {
    setDone(null)
    setError(null)
    if (!tracksStock(p)) {
      sounds.error()
      setError(`${p.name} no lleva inventario: no se compra.`)
      return
    }
    sounds.success()
    focusPicker()
    const key = crypto.randomUUID()
    setLines((ls) => {
      // Escanear otra vez el mismo producto suma una pieza a su renglón.
      const existing = ls.find((l) => l.productId === p.id)
      if (existing) {
        const n = parseCount(existing.qtyText, 1)
        return ls.map((l) => (l === existing ? { ...l, qtyText: String((Number.isNaN(n) ? 0 : n) + 1) } : l))
      }
      const costText = cost != null ? String(cost) : ''
      return [...ls, { key, productId: p.id, barcode: p.barcode, name: p.name, imagePath: p.image_url, qtyText: '1', costText }]
    })
    if (cost != null || p.id.startsWith('pending:')) return
    // El costo se precarga con el último del producto (solo si el renglón es nuevo).
    getProduct(p.id)
      .then((full) => {
        if (full?.cost == null) return
        setLines((ls) => ls.map((l) => (l.key === key && l.costText === '' ? { ...l, costText: String(full.cost) } : l)))
      })
      .catch(() => undefined) // sin conexión: el costo se captura a mano
  }

  const patch = (key: string, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)))

  async function save() {
    if (!canSave || !supplierId) return
    setBusy(true)
    setError(null)
    const draft: PurchaseDraft = {
      id: purchaseId,
      supplierId,
      supplierName,
      location,
      folio,
      note,
      items: rows.map((r) => ({ productId: r.productId, barcode: r.barcode, name: r.name, quantity: r.qty, unitCost: r.cost })),
    }
    const out = await inventoryStore.registerPurchase(draft)
    setBusy(false)
    if (out.type === 'error') {
      sounds.error()
      setError(out.message)
      return
    }
    if (out.pending) sounds.pending()
    else sounds.success()
    const summary = `${formatInt(pieces)} pzas por ${formatMoney(total)}, en ${LOCATION_LABELS[location].toLowerCase()}`
    setDone(
      out.pending
        ? `Compra guardada sin conexión (${summary}). Las piezas ya cuentan aquí; se registra sola al volver el internet.`
        : `Compra registrada: ${summary}.`,
    )
    setLines([])
    setFolio('')
    setNote('')
    setLocation('store')
    setPurchaseId(crypto.randomUUID())
    if (!out.pending) {
      void inventoryStore.refreshProducts()
      loadHistory()
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <h1 className="hidden text-title-lg uppercase md:block">Compras</h1>

      {!online && (
        <p className="notice bg-warning-bg text-warning-fg">
          <Icon name="wifi-off" className="mt-0.5" />
          Sin conexión: la compra se guarda y se registra sola al volver el internet. Corregir o cancelar compras, y dar de alta
          productos sin código, necesitan conexión.
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
          <h2 className="mr-auto text-title">Nueva compra</h2>
          <button
            type="button"
            onClick={() => setCreating({ barcode: null })}
            disabled={!online}
            title={online ? undefined : 'Se necesita conexión para generar un código interno'}
            className="btn btn-secondary"
          >
            <Icon name="plus" />
            Producto sin código
          </button>
        </div>
        <div className="grid gap-4 md:grid-cols-[1fr_12rem]">
          <div>
            <label className="field-label" htmlFor="pu-supplier">Proveedor *</label>
            <SupplierSelect
              id="pu-supplier"
              value={supplierId}
              onChange={(id, s) => {
                setSupplierId(id)
                setSupplierName(s?.name ?? '')
              }}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="pu-folio">Folio / factura</label>
            <input id="pu-folio" value={folio} onChange={(e) => setFolio(e.target.value)} autoComplete="off" className="field" />
          </div>
          <div>
            <span className="field-label">Llega a</span>
            <LocationSelect value={location} onChange={setLocation} label="Llega a" />
          </div>
          <div className="md:col-span-2">
            <label className="field-label" htmlFor="pu-note">Notas</label>
            <input id="pu-note" value={note} onChange={(e) => setNote(e.target.value)} autoComplete="off" className="field" />
          </div>
        </div>

        <ProductPicker
          id="pu-product"
          label="Agregar producto: escanea el código o busca por nombre"
          inputRef={pickerRef}
          products={products}
          available={(p) => (tracksStock(p) ? 1 : 0)}
          unavailableText={() => 'Sin inventario (no se compra)'}
          onPick={(p) => add(p)}
          onUnknownCode={(code) => {
            setDone(null)
            setError(null)
            if (isInternalCode(code)) {
              sounds.error()
              setError(`${code} no existe. Los códigos internos se generan con "Producto sin código".`)
              return
            }
            sounds.newProduct()
            setCreating({ barcode: code })
          }}
          showPrice={false}
          availableText={(p) => `Tienda ${formatInt(p.quantity)} · Bodega ${formatInt(p.warehouse_quantity ?? 0)}`}
        />
        <p className="-mt-2 text-caption text-ink-subtle">
          Escanear otra vez un producto suma una pieza. Si el código no existe, se da de alta aquí mismo.
        </p>

        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-line">
            {/* En el celular cada renglón se acomoda en dos líneas. */}
            <table className="w-full border-collapse text-left max-md:block">
              <thead className="max-md:hidden">
                <tr className="thead-row">
                  <th className="h-control-md px-3 font-medium">Producto</th>
                  <th className="h-control-md px-3 text-right font-medium">Cantidad</th>
                  <th className="h-control-md px-3 text-right font-medium">Costo unitario</th>
                  <th className="h-control-md px-3 text-right font-medium">Importe</th>
                  <th className="h-control-md w-12 px-2" />
                </tr>
              </thead>
              <tbody className="max-md:block">
                {rows.map((r) => (
                  <tr key={r.key} className="border-t border-line max-md:grid max-md:grid-cols-[1fr_auto_auto] max-md:items-center max-md:gap-x-3 max-md:gap-y-2 max-md:px-3 max-md:py-3">
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
                    <td className="px-3 py-2 text-right max-md:row-start-2 max-md:p-0 max-md:text-left">
                      <span className="block text-caption text-ink-muted md:hidden">Cantidad</span>
                      <input
                        value={r.qtyText}
                        onChange={(e) => patch(r.key, { qtyText: e.target.value })}
                        inputMode="numeric"
                        autoComplete="off"
                        aria-label={`Cantidad de ${r.name}`}
                        aria-invalid={Number.isNaN(r.qty)}
                        className={`field h-control-sm w-20 text-right tabular-nums max-md:w-14 ${Number.isNaN(r.qty) ? 'border-danger-fg bg-danger-bg text-danger-fg' : ''}`}
                      />
                    </td>
                    <td className="px-3 py-2 text-right max-md:row-start-2 max-md:p-0 max-md:text-left">
                      <span className="block text-caption text-ink-muted md:hidden">Costo unitario</span>
                      <input
                        value={r.costText}
                        onChange={(e) => patch(r.key, { costText: e.target.value })}
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder="0.00"
                        aria-label={`Costo unitario de ${r.name}`}
                        aria-invalid={Number.isNaN(r.cost)}
                        className={`field h-control-sm w-28 text-right tabular-nums max-md:w-22 ${Number.isNaN(r.cost) && r.costText.trim() !== '' ? 'border-danger-fg bg-danger-bg text-danger-fg' : ''}`}
                      />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums max-md:row-start-2 max-md:min-w-22 max-md:p-0">
                      <span className="block text-caption text-ink-muted md:hidden">Importe</span>
                      {r.invalid ? '—' : formatMoney(r.qty * r.cost)}
                    </td>
                    <td className="px-2 py-2 max-md:col-start-3 max-md:row-start-1 max-md:justify-self-end max-md:p-0">
                      <button
                        type="button"
                        onClick={() => setLines((ls) => ls.filter((l) => l.key !== r.key))}
                        aria-label={`Quitar ${r.name}`}
                        className="grid size-8 cursor-pointer place-items-center rounded-md text-ink-muted hover:bg-subtle hover:text-ink"
                      >
                        <Icon name="x" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="max-md:block">
                <tr className="border-t border-line bg-subtle max-md:flex max-md:items-center max-md:gap-3">
                  <td className="px-3 py-2 font-medium">Total</td>
                  <td className="px-3 py-2 text-right tabular-nums max-md:mr-auto max-md:text-ink-muted">{formatInt(pieces)} pzas</td>
                  <td />
                  <td className="px-3 py-2 text-right text-heading tabular-nums">{formatMoney(total)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {error && (
          <p className="notice bg-danger-bg text-danger-fg">
            <Icon name="alert" className="mt-0.5" />
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {supplierId === null && rows.length > 0 && <span className="text-caption text-ink-muted">Elige el proveedor.</span>}
          <button type="button" onClick={() => void save()} disabled={!canSave} className="btn btn-primary btn-lg">
            <Icon name="check" size={20} />
            {busy ? 'Registrando…' : `Registrar compra${rows.length ? ` · ${formatMoney(total)}` : ''}`}
          </button>
        </div>
      </section>

      <section className="card overflow-hidden">
        <h2 className="border-b border-line px-5 py-4 text-label tracking-wider text-ink-muted uppercase">Compras registradas</h2>
        {pending.length > 0 && (
          <ul className="divide-y divide-line border-b border-line">
            {pending.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                <span className="font-medium">{p.supplierName || 'Proveedor'}</span>
                {p.folio && <span className="font-mono text-caption text-ink-muted">{p.folio}</span>}
                <span className="text-ink-muted">→ {LOCATION_LABELS[p.location]}</span>
                <span className="text-ink-muted tabular-nums">{formatInt(p.items.reduce((n, i) => n + i.quantity, 0))} pzas</span>
                <span className="text-heading tabular-nums">{formatMoney(p.items.reduce((n, i) => n + i.quantity * i.unitCost, 0))}</span>
                <span className="badge badge-warning">Pendiente de sincronizar</span>
              </li>
            ))}
          </ul>
        )}
        {historyError && <p className="px-5 py-4 text-danger-fg">{historyError}</p>}
        {history && history.length === 0 && pending.length === 0 && <p className="px-5 py-8 text-center text-ink-subtle">Aún no hay compras.</p>}
        {history && history.length > 0 && (
          <ul className="divide-y divide-line">
            {history.map((p) => (
              <PurchaseItem
                key={p.id}
                purchase={p}
                onChanged={() => {
                  loadHistory()
                  void inventoryStore.refreshProducts()
                }}
              />
            ))}
          </ul>
        )}
      </section>

      {creating && (
        <ProductFormModal
          barcode={creating.barcode}
          defaultQuantity={0}
          allowInitialQuantity={false}
          hint="Las piezas entran con esta compra: aquí solo se dan de alta los datos del producto."
          onCancel={() => {
            setCreating(null)
            focusPicker()
          }}
          onSaved={(out, { cost }) => {
            setCreating(null)
            add(out.product, cost)
          }}
        />
      )}
    </div>
  )
}

function PurchaseItem({ purchase: p, onChanged }: { purchase: PurchaseRow; onChanged: () => void }) {
  const languages = useLanguageLookup()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<PurchaseItemRow[] | null>(null)
  const [mode, setMode] = useState<'view' | 'edit' | 'cancel'>('view')
  const [supplierId, setSupplierId] = useState<string | null>(p.supplier_id)
  const [folio, setFolio] = useState(p.folio ?? '')
  const [note, setNote] = useState(p.note ?? '')
  const [costs, setCosts] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancelled = p.status === 'cancelled'

  function toggle() {
    setOpen((o) => !o)
    if (items) return
    getPurchaseItems(p.id)
      .then((list) => {
        setItems(list)
        setCosts(Object.fromEntries(list.map((i) => [i.id, String(i.unit_cost)])))
      })
      .catch((e) => setError(errText(e)))
  }

  async function saveEdit() {
    if (!supplierId || !items) return
    const changed: { itemId: string; unitCost: number }[] = []
    for (const i of items) {
      const c = parseMoney(costs[i.id] ?? '')
      if (c === null || Number.isNaN(c)) return setError(`Costo inválido en ${i.product_name}.`)
      if (c !== i.unit_cost) changed.push({ itemId: i.id, unitCost: c })
    }
    setBusy(true)
    setError(null)
    try {
      await updatePurchase(p.id, { supplierId, folio, note, costs: changed })
      setMode('view')
      setItems(null)
      setOpen(false)
      onChanged()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  async function doCancel() {
    if (!reason.trim()) return setError('El motivo es obligatorio.')
    setBusy(true)
    setError(null)
    try {
      await cancelPurchase(p.id, reason)
      setMode('view')
      onChanged()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={cancelled ? 'opacity-70' : ''}>
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-left hover:bg-subtle">
        <span className="font-medium">{p.supplier_name}</span>
        {p.folio && <span className="font-mono text-caption text-ink-muted">{p.folio}</span>}
        <span className="text-ink-muted">→ {LOCATION_LABELS[p.location]}</span>
        <span className="text-ink-muted tabular-nums">{formatInt(p.piece_count)} pzas</span>
        <span className="text-heading tabular-nums">{formatMoney(p.total)}</span>
        {cancelled && <span className="badge badge-danger">Cancelada</span>}
        <span className="ml-auto text-caption text-ink-subtle">
          {formatDateTime(p.created_at)} · {p.created_by_name ?? '—'}
        </span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} className="text-ink-subtle" />
      </button>

      {open && (
        <div className="space-y-3 bg-subtle px-5 py-4">
          {cancelled && (
            <p className="text-caption text-danger-fg">
              Cancelada el {p.cancelled_at ? formatDateTime(p.cancelled_at) : '—'} por {p.cancelled_by_name ?? '—'}. Motivo: {p.cancel_reason}
            </p>
          )}
          {p.note && mode !== 'edit' && <p className="text-ink-muted">Notas: {p.note}</p>}

          {mode === 'edit' && (
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <label className="field-label" htmlFor={`pe-sup-${p.id}`}>Proveedor</label>
                <SupplierSelect id={`pe-sup-${p.id}`} value={supplierId} onChange={(id) => setSupplierId(id)} disabled={!p.is_intact} />
              </div>
              <div>
                <label className="field-label" htmlFor={`pe-folio-${p.id}`}>Folio</label>
                <input id={`pe-folio-${p.id}`} value={folio} onChange={(e) => setFolio(e.target.value)} className="field" />
              </div>
              <div>
                <label className="field-label" htmlFor={`pe-note-${p.id}`}>Notas</label>
                <input id={`pe-note-${p.id}`} value={note} onChange={(e) => setNote(e.target.value)} className="field" />
              </div>
            </div>
          )}

          {!items && !error && <p className="text-ink-subtle">Cargando…</p>}
          {items && (
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="text-caption text-ink-muted">
                  <th className="py-1 font-medium">Producto</th>
                  <th className="py-1 text-right font-medium">Cantidad</th>
                  <th className="py-1 text-right font-medium">Costo</th>
                  <th className="py-1 text-right font-medium">Importe</th>
                  <th className="py-1 text-right font-medium">Lote</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} className="border-t border-line">
                    <td className="py-1.5">
                      <LanguageTag language={languages.get(i.product_id)} className="mr-1.5" />
                      {i.product_name} <span className="font-mono text-caption text-ink-subtle">{i.barcode}</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatInt(i.quantity)}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {mode === 'edit' && p.is_intact ? (
                        <input
                          value={costs[i.id] ?? ''}
                          onChange={(e) => setCosts((c) => ({ ...c, [i.id]: e.target.value }))}
                          inputMode="decimal"
                          aria-label={`Costo de ${i.product_name}`}
                          className="field h-control-sm w-24 text-right tabular-nums"
                        />
                      ) : (
                        formatMoney(i.unit_cost)
                      )}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatMoney(i.line_total)}</td>
                    <td className="py-1.5 text-right text-ink-muted tabular-nums">{i.lot_number ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {!cancelled && !p.is_intact && (
            <p className="text-caption text-ink-muted">
              Ya se vendieron, movieron o ajustaron piezas de esta compra: solo se pueden cambiar folio y notas. Para corregir
              cantidades, haz un ajuste desde el producto.
            </p>
          )}

          {mode === 'cancel' && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-64 flex-1">
                <label className="field-label" htmlFor={`pc-reason-${p.id}`}>Motivo de la cancelación *</label>
                <input
                  id={`pc-reason-${p.id}`}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Ej. Se capturó dos veces / el proveedor no la entregó"
                  autoFocus
                  className="field"
                />
              </div>
              <button type="button" onClick={() => setMode('view')} className="btn btn-ghost">
                Volver
              </button>
              <button type="button" onClick={() => void doCancel()} disabled={busy} className="btn btn-danger">
                {busy ? 'Cancelando…' : `Cancelar compra (regresa ${formatInt(p.piece_count)} pzas)`}
              </button>
            </div>
          )}

          {error && (
            <p className="notice bg-danger-bg text-danger-fg">
              <Icon name="alert" className="mt-0.5" />
              {error}
            </p>
          )}

          {!cancelled && items && (
            <div className="flex flex-wrap justify-end gap-2">
              {mode === 'edit' ? (
                <>
                  <button type="button" onClick={() => setMode('view')} className="btn btn-ghost">
                    Descartar
                  </button>
                  <button type="button" onClick={() => void saveEdit()} disabled={busy} className="btn btn-primary">
                    {busy ? 'Guardando…' : 'Guardar corrección'}
                  </button>
                </>
              ) : mode === 'view' ? (
                <>
                  <button type="button" onClick={() => setMode('edit')} className="btn btn-secondary">
                    <Icon name="pencil" />
                    Corregir
                  </button>
                  {p.is_intact && (
                    <button type="button" onClick={() => setMode('cancel')} className="btn btn-danger">
                      Cancelar compra
                    </button>
                  )}
                </>
              ) : null}
            </div>
          )}
        </div>
      )}
    </li>
  )
}
