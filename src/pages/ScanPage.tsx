import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ProductFormModal } from '../components/ProductFormModal'
import { Icon } from '../components/Icon'
import { LocationSelect } from '../components/LocationSelect'
import { LotPicker } from '../components/LotPicker'
import { MoreMenu } from '../components/MoreMenu'
import { ProductImage } from '../components/ProductImage'
import { LanguageTag, useLanguageLookup } from '../components/LanguageTag'
import { ProductPicker } from '../components/pos/ProductPicker'
import { SupplierSelect } from '../components/SupplierSelect'
import { useKeepFocus } from '../components/useKeepFocus'
import { isInternalCode, normalizeBarcode } from '../lib/barcode'
import { exportCsv, exportXlsx, buildInventoryRows } from '../lib/export'
import { formatInt, formatMoney, parseCount, parseMoney } from '../lib/format'
import { createBurstDetector } from '../lib/scannerBurst'
import { exportName } from '../lib/settings'
import { sounds } from '../lib/sounds'
import { LOCATION_LABELS, type LotPick, type ScanMode, type StockLocation } from '../lib/types'
import { inventoryStore, qtyAt, tracksStock, type CachedProduct, type ScanContext } from '../store/inventoryStore'
import { useInventory } from '../store/useInventory'

type Feedback =
  | { kind: 'success' | 'pending' | 'created' | 'undo'; title: string; product: Pick<CachedProduct, 'name' | 'barcode' | 'image_url' | 'language'>; quantityAfter: number; detail: string; note?: string }
  | { kind: 'error'; title: string; detail?: string }
  | { kind: 'idle' }

// Cada resultado usa su estado del sistema: fondo -bg, texto -fg y borde -solid.
const STYLES: Record<Feedback['kind'], string> = {
  idle: 'border-dashed border-control bg-surface text-ink-muted',
  success: 'border-success-solid bg-success-bg text-success-fg',
  pending: 'border-warning-solid bg-warning-bg text-warning-fg',
  created: 'border-info-solid bg-info-bg text-info-fg',
  undo: 'border-brand bg-brand-soft text-brand-ink',
  error: 'border-danger-solid bg-danger-bg text-danger-fg',
}

function loadPref(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}
function savePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* no crítico */
  }
}

export function ScanPage() {
  const { products, recent, online } = useInventory()
  const languages = useLanguageLookup()
  const [code, setCode] = useState('')
  const [mode, setModeState] = useState<ScanMode>(() => (loadPref('hachiko.mode', 'add') === 'set' ? 'set' : 'add'))
  const [qtyText, setQtyText] = useState(() => loadPref('hachiko.qty', '1'))
  const [feedback, setFeedback] = useState<Feedback>({ kind: 'idle' })
  const [modal, setModal] = useState<{ barcode: string | null; defaultQuantity: number } | null>(null)
  // Sesión de conteo: ubicación, proveedor y costo de lo que se escanea. Siempre
  // empieza en Tienda; Bodega es para casos especiales. Cambiar cualquiera de
  // los tres abre una sesión nueva (lotes nuevos).
  const [location, setLocation] = useState<StockLocation>('store')
  const [supplierId, setSupplierId] = useState<string | null>(null)
  const [costText, setCostText] = useState('')
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID())
  const [lotChoice, setLotChoice] = useState<{ product: CachedProduct; remove: number; quantity: number } | null>(null)
  const [exporting, setExporting] = useState(false)
  const scanRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const qtyRef = useRef<HTMLInputElement>(null)
  const qtyOnFocus = useRef(qtyText)
  const qtyIdle = useRef<number | undefined>(undefined)
  const qtyDetector = useRef(createBurstDetector())

  useKeepFocus(scanRef, modal === null && lotChoice === null)

  const unitCost = parseMoney(costText)
  const costValid = !Number.isNaN(unitCost)
  const ctx: ScanContext = { location, supplierId, unitCost: costValid ? unitCost : null, sessionId }

  function newSession(patch: () => void) {
    patch()
    setSessionId(crypto.randomUUID())
    focusScan()
  }

  const focusScan = useCallback(() => setTimeout(() => scanRef.current?.focus(), 0), [])

  const quantity = parseCount(qtyText, mode === 'add' ? 1 : 0)
  const qtyValid = !Number.isNaN(quantity)

  useEffect(() => {
    if (qtyValid) savePref('hachiko.qty', qtyText.trim())
  }, [qtyText, qtyValid])

  const totals = useMemo(() => {
    let pieces = 0
    const list = Object.values(products)
    for (const p of list) pieces += qtyAt(p, location)
    return { products: list.length, pieces }
  }, [products, location])

  function setMode(m: ScanMode) {
    setModeState(m)
    savePref('hachiko.mode', m)
    focusScan()
  }

  function updateQty(text: string) {
    setQtyText(text)
    // Si se deja el campo de cantidad sin tocar, el foco regresa al escaneo.
    window.clearTimeout(qtyIdle.current)
    qtyIdle.current = window.setTimeout(() => {
      if (document.activeElement === qtyRef.current) scanRef.current?.focus()
    }, 4000)
  }

  async function processScan(raw: string, qtyStr = qtyText, lots?: LotPick[]) {
    const barcode = normalizeBarcode(raw)
    if (!barcode) return
    if (!costValid) {
      sounds.error()
      setFeedback({ kind: 'error', title: 'Costo inválido', detail: 'Corrige el costo de la sesión (o déjalo vacío para usar el último de cada producto).' })
      return
    }
    const quantity = parseCount(qtyStr, mode === 'add' ? 1 : 0)
    if (Number.isNaN(quantity)) {
      sounds.error()
      setFeedback({
        kind: 'error',
        title: 'Cantidad por escaneo inválida',
        detail: mode === 'add' ? 'Debe ser un número entero mayor o igual a 1.' : 'Debe ser un número entero (0 o más).',
      })
      return
    }
    const out = await inventoryStore.scan(barcode, mode, quantity, ctx, lots)
    if (out.type === 'choose_lot') {
      sounds.pending()
      setFeedback({ kind: 'idle' })
      setLotChoice({ product: out.product, remove: out.remove, quantity })
      return
    }
    if (out.type === 'error') {
      sounds.error()
      setFeedback({ kind: 'error', title: 'No se pudo registrar el escaneo', detail: out.message })
      return
    }
    if (out.type === 'not_found') {
      sounds.newProduct()
      setFeedback({ kind: 'idle' })
      setModal({ barcode: out.barcode, defaultQuantity: quantity })
      return
    }
    if (out.pending) sounds.pending()
    else sounds.success()
    const where = location === 'warehouse' ? ' en bodega' : ''
    setFeedback({
      kind: out.pending ? 'pending' : 'success',
      title: out.pending ? `Guardado sin conexión (pendiente)${where}` : `${out.mode === 'add' ? 'Sumado' : 'Total fijado'}${where}`,
      product: out.product,
      quantityAfter: out.quantityAfter,
      detail: out.mode === 'add' ? `+${formatInt(out.delta)}` : `Fijado en ${formatInt(out.quantityAfter)} (${out.delta >= 0 ? '+' : ''}${formatInt(out.delta)})`,
    })
  }

  // Enter del lector (o del teclado) procesa el código. Se maneja en keydown
  // porque el formulario tiene dos campos y el navegador no lo enviaría solo.
  function onScanKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const value = e.currentTarget.value
    setCode('')
    if (value.trim()) void processScan(value)
  }

  // Si el lector escribe dentro de "Cantidad por escaneo", se trata como escaneo.
  function onQtyKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const scanned = qtyDetector.current.handle(e)
    if (scanned) {
      e.preventDefault()
      const current = e.currentTarget.value
      const stripped = current.endsWith(scanned) ? current.slice(0, -scanned.length).trim() : ''
      const restored = stripped || qtyOnFocus.current
      setQtyText(restored)
      scanRef.current?.focus()
      void processScan(scanned, restored)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      scanRef.current?.focus()
    }
  }

  async function undo() {
    const out = await inventoryStore.undoLast()
    focusScan()
    if (out.type === 'nothing') {
      sounds.error()
      setFeedback({ kind: 'error', title: 'No hay escaneos para deshacer en esta sesión' })
      return
    }
    if (out.type === 'error') {
      sounds.error()
      setFeedback({ kind: 'error', title: 'No se pudo deshacer', detail: out.message })
      return
    }
    sounds.success()
    setFeedback({
      kind: 'undo',
      title: out.pending ? 'Deshecho (pendiente de sincronizar)' : 'Escaneo deshecho',
      product: { name: out.entry.name, barcode: out.entry.barcode, image_url: out.entry.imagePath, language: languages.get(out.entry.barcode) ?? null },
      quantityAfter: out.quantityAfter,
      detail: `${out.entry.delta >= 0 ? '−' : '+'}${formatInt(Math.abs(out.entry.delta))}`,
    })
  }

  async function doExport(kind: 'csv' | 'xlsx') {
    if (exporting) return
    setExporting(true)
    try {
      const rows = await buildInventoryRows()
      if (kind === 'csv') exportCsv(rows, exportName('total'))
      else await exportXlsx(rows, exportName('total'), 'Inventario')
    } catch (e) {
      sounds.error()
      setFeedback({
        kind: 'error',
        title: 'No se pudo exportar',
        detail: online ? (e as Error).message : 'Se necesita conexión para exportar.',
      })
    } finally {
      setExporting(false)
      focusScan()
    }
  }

  const openLabel = (barcode: string) => window.open(`/etiqueta/${encodeURIComponent(barcode)}?print=1`, '_blank')

  return (
    <div className="flex min-h-full flex-col gap-4 p-4 md:p-6">
      {/* Título y acciones de página */}
      <div className="flex flex-wrap items-center gap-3 max-md:justify-end">
        <h1 className="hidden mr-auto text-title-lg uppercase md:block">Agregar</h1>
        <button
          type="button"
          onClick={() => {
            setFeedback({ kind: 'idle' })
            setModal({ barcode: null, defaultQuantity: qtyValid && quantity > 0 ? quantity : 1 })
          }}
          disabled={!online}
          title={online ? undefined : 'Se necesita conexión para generar un código interno'}
          className="btn btn-primary"
        >
          <Icon name="plus" />
          Producto sin código
        </button>
        {online && !exporting && (
          <MoreMenu
            items={[
              { label: 'Exportar CSV', icon: 'download', onClick: () => void doExport('csv') },
              { label: 'Exportar Excel', icon: 'download', onClick: () => void doExport('xlsx') },
            ]}
          />
        )}
      </div>
      {!online && (
        <p className="-mt-2 text-right text-caption text-ink-subtle">
          Sin conexión: exportar y dar de alta productos sin código necesitan internet.
        </p>
      )}

      <div className="grid flex-1 gap-4 lg:grid-cols-[1fr_360px]">
        <section className="flex min-w-0 flex-col gap-4">
          {/* Sesión de conteo: a dónde entra lo escaneado y con qué proveedor y costo */}
          <div
            data-keep-focus
            className={`card flex flex-wrap items-end gap-4 p-4 ${location === 'warehouse' ? 'border-2 border-warning-solid' : ''}`}
          >
            <div>
              <span className="field-label">Contando en</span>
              <LocationSelect value={location} onChange={(l) => newSession(() => setLocation(l))} label="Contando en" />
            </div>
            <div className="min-w-56 flex-1">
              <label className="field-label" htmlFor="scan-supplier">Proveedor</label>
              <SupplierSelect
                id="scan-supplier"
                value={supplierId}
                onChange={(id) => newSession(() => setSupplierId(id))}
                noneLabel="El último de cada producto"
                disabled={!online}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="scan-cost">Costo unitario ($)</label>
              <input
                id="scan-cost"
                value={costText}
                onChange={(e) => setCostText(e.target.value)}
                onBlur={() => costValid && setSessionId(crypto.randomUUID())}
                inputMode="decimal"
                autoComplete="off"
                placeholder="El último"
                aria-invalid={!costValid}
                className={`field w-32 tabular-nums ${costValid ? '' : 'border-danger-fg bg-danger-bg text-danger-fg'}`}
              />
            </div>
            <p className="basis-full text-caption text-ink-muted">
              {location === 'warehouse' ? (
                <span className="font-medium text-warning-fg">
                  Estás contando la BODEGA: lo que escanees no se podrá vender hasta hacer un movimiento a tienda.{' '}
                </span>
              ) : null}
              Lo que se sume entra como un lote{' '}
              {supplierId ? 'de ese proveedor' : 'con el último proveedor de cada producto'} y{' '}
              {unitCost != null && costValid ? `a ${formatMoney(unitCost)} c/u` : 'con su último costo'}.
              {mode === 'set' && ' Si "fijar total" baja la cantidad, te pediremos de qué lote salen las piezas.'}
            </p>
          </div>

          {/* Escaneo */}
          <form onSubmit={(e) => e.preventDefault()} className="card p-5">
            <label htmlFor="scan" className="mb-2 flex items-center gap-2 text-heading">
              <Icon name="barcode" size={20} className="text-brand" />
              Escanea o escribe el código y presiona Enter
            </label>
            <input
              id="scan"
              ref={scanRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={onScanKeyDown}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="h-16 w-full rounded-md border-2 border-control bg-surface px-4 font-mono text-3xl tracking-wider text-ink focus:border-brand max-md:h-14 max-md:text-xl max-md:tracking-normal"
              placeholder="Código de barras…"
            />
            <div className="mt-4 flex flex-wrap items-end gap-4">
              <div data-keep-focus>
                <label htmlFor="qty" className="field-label">
                  {mode === 'add' ? 'Cantidad por escaneo' : 'Total a fijar'}
                </label>
                <input
                  id="qty"
                  ref={qtyRef}
                  value={qtyText}
                  onChange={(e) => updateQty(e.target.value)}
                  onKeyDown={onQtyKeyDown}
                  onFocus={(e) => {
                    qtyOnFocus.current = qtyText
                    e.target.select()
                  }}
                  onBlur={() => !qtyValid && setQtyText(qtyOnFocus.current)}
                  inputMode="numeric"
                  autoComplete="off"
                  aria-invalid={!qtyValid}
                  className={`h-11 w-28 rounded-md border bg-surface px-3 text-center text-title tabular-nums ${qtyValid ? 'border-control text-ink' : 'border-danger-fg bg-danger-bg text-danger-fg'}`}
                />
              </div>
              <div className="seg h-12" role="group" aria-label="Modo">
                {(
                  [
                    ['add', 'Sumar'],
                    ['set', 'Fijar total'],
                  ] as const
                ).map(([m, text]) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    onClick={() => setMode(m)}
                    className="seg-option px-4 text-[15px]"
                  >
                    {text}
                  </button>
                ))}
              </div>
              {mode === 'set' && (
                <p className="notice bg-warning-bg text-warning-fg">
                  <Icon name="alert" className="mt-0.5" />
                  <span>
                    <strong className="font-semibold">Modo fijar total:</strong> cada escaneo deja la cantidad en{' '}
                    {qtyValid ? formatInt(quantity) : '…'}.
                  </span>
                </p>
              )}
            </div>

            {/* Sin código a la mano: buscar por nombre y aplicar la misma cantidad y modo. */}
            <div data-keep-focus className="mt-4 border-t border-line pt-4">
              <ProductPicker
                id="scan-name"
                label={`¿No tienes el código? Busca por nombre: ${mode === 'add' ? 'se suman' : 'se fija el total en'} ${qtyValid ? formatInt(quantity) : '…'} pza(s)`}
                inputRef={nameRef}
                products={products}
                showPrice={false}
                available={(p) => (tracksStock(p) ? 1 : 0)}
                availableText={(p) => `Tienda ${formatInt(p.quantity)} · Bodega ${formatInt(p.warehouse_quantity ?? 0)}`}
                unavailableText={() => 'Sin inventario (no lleva stock)'}
                onPick={(p) => {
                  if (!tracksStock(p)) {
                    sounds.error()
                    setFeedback({ kind: 'error', title: `${p.name} no lleva inventario`, detail: 'Los productos sin control de inventario no reciben piezas.' })
                    return
                  }
                  void processScan(p.barcode).then(focusScan)
                }}
              />
            </div>
          </form>

          {/* Confirmación grande, legible a distancia */}
          <div className={`flex min-h-64 flex-1 items-center gap-6 rounded-lg border-2 p-6 ${STYLES[feedback.kind]}`} aria-live="polite">
            {feedback.kind === 'idle' && (
              <div className="flex w-full flex-col items-center gap-3 text-center">
                <Icon name="barcode" size={40} className="text-ink-subtle" />
                <p className="text-title-lg text-ink-muted">Listo para escanear</p>
              </div>
            )}
            {feedback.kind === 'error' && (
              <div className="flex items-start gap-4">
                <Icon name="x" size={40} className="mt-1" />
                <div>
                  <p className="text-4xl font-semibold tracking-tight">{feedback.title}</p>
                  {feedback.detail && <p className="mt-2 text-xl">{feedback.detail}</p>}
                </div>
              </div>
            )}
            {(feedback.kind === 'success' || feedback.kind === 'pending' || feedback.kind === 'created' || feedback.kind === 'undo') && (
              <>
                <ProductImage path={feedback.product.image_url} alt={feedback.product.name} className="size-44 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-heading">
                    <Icon name={feedback.kind === 'undo' ? 'undo' : feedback.kind === 'pending' ? 'wifi-off' : 'check'} size={20} />
                    {feedback.title}
                  </p>
                  <LanguageTag language={feedback.product.language} size="lg" className="mt-2" />
                  <p className="mt-1 truncate text-5xl font-semibold tracking-tight text-ink" title={feedback.product.name}>
                    {feedback.product.name}
                  </p>
                  <p className="mt-1 font-mono text-xl">{feedback.product.barcode}</p>
                  <div className="mt-3 flex items-baseline gap-4 text-ink">
                    <span className="text-7xl font-semibold tracking-tight tabular-nums">{formatInt(feedback.quantityAfter)}</span>
                    <span className="text-2xl font-medium">pzas · {feedback.detail}</span>
                  </div>
                  {feedback.note && <p className="mt-2 text-lg font-medium">{feedback.note}</p>}
                  {feedback.kind === 'created' && isInternalCode(feedback.product.barcode) && (
                    <button type="button" onClick={() => openLabel(feedback.product.barcode)} className="btn btn-secondary btn-lg mt-4">
                      <Icon name="printer" size={20} />
                      Imprimir etiqueta
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          <div>
            <button type="button" onClick={() => void undo()} className="btn btn-secondary max-md:w-full">
              <Icon name="undo" size={20} />
              Deshacer último escaneo
            </button>
          </div>
        </section>

        {/* Lateral: contadores y últimos escaneos */}
        <aside className="flex min-h-0 flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="card p-5">
              <p className="text-label text-ink-muted">Productos distintos</p>
              <p className="mt-1 text-kpi tabular-nums">{formatInt(totals.products)}</p>
            </div>
            <div className="card p-5">
              <p className="text-label text-ink-muted">Piezas en {LOCATION_LABELS[location].toLowerCase()}</p>
              <p className="mt-1 text-kpi tabular-nums">{formatInt(totals.pieces)}</p>
            </div>
          </div>
          <div className="card flex min-h-80 flex-1 flex-col overflow-hidden lg:min-h-0">
            <h2 className="border-b border-line px-5 py-4 text-label tracking-wider text-ink-muted uppercase">Últimos escaneos de esta sesión</h2>
            {recent.length === 0 && <p className="px-5 py-10 text-center text-ink-subtle">Aún no hay escaneos.</p>}
            <ul className="min-h-0 flex-1 divide-y divide-line overflow-auto">
              {recent.map((r) => (
                <li key={r.key} className={`flex items-center gap-3 px-4 py-3 ${r.undone ? 'opacity-60' : ''}`}>
                  <ProductImage path={r.imagePath} alt={r.name} className="size-10 shrink-0 rounded-xs" />
                  <div className="min-w-0 flex-1">
                    <p className={`truncate font-medium ${r.undone ? 'line-through' : ''}`}>
                      <LanguageTag language={languages.get(r.barcode)} className="mr-1.5" />
                      {r.name}
                    </p>
                    <p className="truncate font-mono text-caption text-ink-muted">
                      {r.barcode} · {new Date(r.at).toLocaleTimeString('es-MX')}
                    </p>
                    {(r.pending || r.error || (r.undone && r.movementId)) && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {r.pending && !r.undone && <span className="badge badge-warning px-2 py-0.5 text-caption">Pendiente de sincronizar</span>}
                        {r.undone && r.movementId && <span className="badge badge-neutral px-2 py-0.5 text-caption">Deshecho</span>}
                      </div>
                    )}
                    {r.error && <p className="mt-1 text-caption text-danger-fg">Error: {r.error}</p>}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-heading tabular-nums">
                      {r.kind === 'create' ? 'Alta ' : r.mode === 'set' ? '= ' : '+'}
                      {r.kind === 'create' || r.mode === 'add' ? formatInt(r.amount) : formatInt(r.quantityAfter)}
                    </p>
                    <p className="text-caption text-ink-muted tabular-nums">
                      {r.location === 'warehouse' ? 'bodega' : 'total'} {formatInt(r.quantityAfter)}
                    </p>
                    {isInternalCode(r.barcode) && !r.undone && (
                      <button type="button" onClick={() => openLabel(r.barcode)} className="btn btn-ghost btn-sm mt-1 -mr-2">
                        <Icon name="printer" />
                        Etiqueta
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      {lotChoice && (
        <LotPicker
          productId={lotChoice.product.id}
          productName={lotChoice.product.name}
          location={location}
          remove={lotChoice.remove}
          purpose="Fijar total"
          onCancel={() => {
            setLotChoice(null)
            setFeedback({ kind: 'error', title: 'Escaneo cancelado', detail: 'No se cambió la cantidad.' })
            focusScan()
          }}
          onConfirm={(picks) => {
            const { product, quantity } = lotChoice
            setLotChoice(null)
            focusScan()
            void processScan(product.barcode, String(quantity), picks)
          }}
        />
      )}

      {modal && (
        <ProductFormModal
          barcode={modal.barcode}
          defaultQuantity={modal.defaultQuantity}
          defaultLocation={location}
          onCancel={() => {
            setModal(null)
            focusScan()
          }}
          onSaved={(out) => {
            setModal(null)
            focusScan()
            sounds.success()
            const notes: string[] = []
            if (out.existed) notes.push('El código ya existía: se sumó la cantidad inicial.')
            if (out.imageSkipped) notes.push('La imagen no se guardó por falta de conexión.')
            setFeedback({
              kind: out.pending ? 'pending' : 'created',
              title: out.pending ? 'Producto guardado sin conexión (pendiente)' : out.existed ? 'Producto existente' : 'Producto dado de alta',
              product: out.product,
              quantityAfter: out.quantityAfter,
              detail: out.existed ? 'cantidad sumada' : 'conteo inicial',
              note: notes.join(' ') || undefined,
            })
          }}
        />
      )}
    </div>
  )
}
