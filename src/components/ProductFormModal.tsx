import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { internalCodeLabel } from '../lib/barcode'
import { catalogThumb, fetchCatalogImage, searchCatalog } from '../lib/catalog'
import { categoryForCatalog } from '../lib/categories'
import { compressImage } from '../lib/images'
import { formatDateTime, parseCount, parseMoney } from '../lib/format'
import { findUnlink } from '../lib/products'
import { createBurstDetector } from '../lib/scannerBurst'
import { languageApplies, suggestedLanguage } from '../lib/language'
import { useSettings } from '../lib/settings'
import type { CatalogItem, ProductLanguage, StockLocation } from '../lib/types'
import { inventoryStore, type CreateOutcome } from '../store/inventoryStore'
import { useInventory } from '../store/useInventory'
import { CatalogSearch } from './CatalogSearch'
import { CategorySelect } from './CategorySelect'
import { Icon } from './Icon'
import { LanguageSelect } from './LanguageSelect'
import { LocationSelect } from './LocationSelect'
import { WebcamCapture } from './WebcamCapture'

interface Props {
  /** null = producto sin código (se genera un código interno al guardar). */
  barcode: string | null
  defaultQuantity: number
  /** Dónde está la cantidad inicial (por defecto Tienda). */
  defaultLocation?: StockLocation
  /**
   * Se puede capturar cantidad inicial. Por defecto, solo mientras el
   * inventario inicial esté abierto; en Compras nunca (las piezas entran con
   * la compra).
   */
  allowInitialQuantity?: boolean
  /** Texto bajo el título (p. ej. de dónde se da de alta). */
  hint?: string
  onCancel: () => void
  /** cost: el costo capturado (para precargarlo en la compra). */
  onSaved: (outcome: Extract<CreateOutcome, { type: 'ok' }>, extra: { cost: number | null }) => void
}

type Fields = {
  name: string
  price: string
  cost: string
  category: string
  supplier: string
  quantity: string
  description: string
}

export function ProductFormModal({
  barcode,
  defaultQuantity,
  defaultLocation = 'store',
  allowInitialQuantity,
  hint,
  onCancel,
  onSaved,
}: Props) {
  const { products, online } = useInventory()
  const settings = useSettings()
  const withQuantity = allowInitialQuantity ?? settings.initialLoadOpen
  const [location, setLocation] = useState<StockLocation>(defaultLocation)
  const [fields, setFields] = useState<Fields>({
    name: '',
    price: '',
    cost: '',
    category: '',
    supplier: '',
    quantity: String(defaultQuantity),
    description: '',
  })
  const [image, setImage] = useState<Blob | null>(null)
  // De dónde salió la imagen: si es del catálogo, se quita al desvincular.
  const [imageSource, setImageSource] = useState<'user' | 'catalog' | null>(null)
  const [linked, setLinked] = useState<CatalogItem | null>(null)
  const [linkedBy, setLinkedBy] = useState<'barcode' | 'search' | null>(null)
  const [imageLoading, setImageLoading] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [camera, setCamera] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [language, setLanguage] = useState<ProductLanguage | null>(null)
  // Si ya se eligió el idioma a mano, las sugerencias no lo pisan.
  const [languageTouched, setLanguageTouched] = useState(false)
  // El código se desvinculó antes de otro producto: no se vincula solo al catálogo.
  const [unlinked, setUnlinked] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const priceRef = useRef<HTMLInputElement>(null)
  const catalogRef = useRef<HTMLInputElement>(null)
  const detector = useRef(createBurstDetector())
  const linkToken = useRef(0)

  // Al abrir: si el código ya está en el catálogo (UPC), se vincula solo (salvo que
  // ese código se haya desvinculado antes: entonces se elige a mano).
  // Si no, el cursor queda en el buscador del catálogo (o en Nombre sin conexión).
  useEffect(() => {
    let active = true
    if (!online) {
      nameRef.current?.focus()
      return
    }
    catalogRef.current?.focus()
    if (barcode && /^\d{8,14}$/.test(barcode)) {
      const token = linkToken.current
      findUnlink(barcode)
        .catch(() => null)
        .then((prev) => {
          if (prev) {
            if (active) {
              setUnlinked(
                `Este código se desvinculó de "${prev.product_name}" el ${formatDateTime(prev.created_at)}` +
                  `${prev.created_by_name || prev.created_by_email ? ` (${prev.created_by_name || prev.created_by_email})` : ''}. ` +
                  'No se vinculó solo: busca y elige el producto correcto del catálogo.',
              )
            }
            return []
          }
          return searchCatalog(barcode, 5)
        })
        .then((r) => {
          const matches = r.filter((c) => c.upc_match)
          // Si mientras tanto ya se eligió algo a mano, no se pisa.
          if (active && token === linkToken.current && matches.length === 1) {
            applyCatalog(matches[0], 'barcode')
            priceRef.current?.focus()
          }
        })
        .catch(() => undefined) // sin coincidencia automática: se busca a mano
    }
    return () => {
      active = false
    }
    // Solo al abrir el formulario.
  }, [])

  useEffect(() => {
    if (!image) return setPreview(null)
    const url = URL.createObjectURL(image)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [image])

  const suppliers = useMemo(() => {
    const s = new Set<string>()
    for (const p of Object.values(products)) if (p.supplier) s.add(p.supplier)
    return [...s].sort()
  }, [products])

  const set = (key: keyof Fields) => (e: { target: { value: string } }) =>
    setFields((f) => ({ ...f, [key]: e.target.value }))

  /**
   * Idioma que se propone al vincular. El catálogo de TCGplayer trae el UPC de
   * la versión en inglés: si el código escaneado es otro y el producto se
   * eligió a mano, casi siempre es la versión en español.
   */
  function catalogLanguage(item: CatalogItem, by: 'barcode' | 'search', category: string): ProductLanguage | null {
    const suggested = suggestedLanguage(category, item.source)
    if (suggested !== 'en') return suggested
    const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '').replace(/^0+/, '')
    if (by === 'search' && barcode && digits(barcode) && digits(item.upc) && digits(barcode) !== digits(item.upc)) return 'es'
    return 'en'
  }

  function applyCatalog(item: CatalogItem, by: 'barcode' | 'search') {
    const token = ++linkToken.current
    setLinked(item)
    setLinkedBy(by)
    setError(null)
    const category = fields.category || categoryForCatalog(item.source)
    if (!languageTouched) setLanguage(catalogLanguage(item, by, category))
    setFields((f) => ({
      ...f,
      name: item.name,
      category: f.category || categoryForCatalog(item.source),
      description: item.description ?? '',
    }))
    // La foto del catálogo reemplaza a otra del catálogo, nunca a una propia.
    if (imageSource === 'user' || !item.image_url) {
      if (imageSource === 'catalog') {
        setImage(null)
        setImageSource(null)
      }
      return
    }
    setImageLoading(true)
    fetchCatalogImage(item.image_url)
      .then((blob) => {
        if (token !== linkToken.current) return
        setImage(blob)
        setImageSource('catalog')
      })
      .catch(() => {
        if (token !== linkToken.current) return
        setWarning('No se pudo descargar la foto del catálogo. Puedes subir una o tomarla con la cámara.')
      })
      .finally(() => token === linkToken.current && setImageLoading(false))
  }

  function unlink() {
    linkToken.current++
    setLinked(null)
    setLinkedBy(null)
    if (!languageTouched) setLanguage(suggestedLanguage(fields.category))
    setImageLoading(false)
    if (imageSource === 'catalog') {
      setImage(null)
      setImageSource(null)
    }
    setTimeout(() => catalogRef.current?.focus(), 0)
  }

  async function setImageFrom(blob: Blob) {
    try {
      linkToken.current++ // una descarga del catálogo en curso ya no la pisa
      setImageLoading(false)
      setImage(await compressImage(blob))
      setImageSource('user')
      setCamera(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo procesar la imagen')
    }
  }

  // Si el lector "teclea" un código dentro del formulario, no guardamos basura.
  function onKeyDownCapture(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
      return
    }
    const scanned = detector.current.handle(e)
    if (!scanned) return
    e.preventDefault()
    const target = e.target as HTMLInputElement
    const key = target.name as keyof Fields
    if (key in fields) {
      setFields((f) => ({ ...f, [key]: f[key].endsWith(scanned) ? f[key].slice(0, -scanned.length) : f[key] }))
    }
    setWarning(`Se detectó un escaneo (${scanned}) dentro del formulario y se ignoró. Termina de capturar este producto primero.`)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (saving) return
    setError(null)
    const name = fields.name.trim()
    const price = parseMoney(fields.price)
    const cost = parseMoney(fields.cost)
    const quantity = withQuantity ? parseCount(fields.quantity || '0') : 0
    if (!name) return setError('El nombre es obligatorio.')
    if (price === null || Number.isNaN(price)) return setError('El precio de venta es obligatorio y debe ser un número válido.')
    if (Number.isNaN(cost)) return setError('El costo debe ser un número válido.')
    if (Number.isNaN(quantity)) return setError('La cantidad inicial debe ser un número entero (0 o más).')

    setSaving(true)
    const outcome = await inventoryStore.createProduct(
      {
        barcode,
        name,
        price,
        cost,
        category: fields.category,
        supplier: fields.supplier,
        initialQuantity: quantity,
        location,
        description: fields.description,
        catalogProductId: linked?.id ?? null,
        language,
      },
      image,
    )
    setSaving(false)
    if (outcome.type === 'error') return setError(outcome.message)
    onSaved(outcome, { cost })
  }

  const input = 'field'
  const label = 'field-label'

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4" role="dialog" aria-modal="true" aria-labelledby="pf-title">
      <form
        onSubmit={onSubmit}
        onKeyDownCapture={onKeyDownCapture}
        className="max-h-full w-full max-w-2xl overflow-auto dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div>
            <h2 id="pf-title" className="text-title">Producto nuevo</h2>
            <p className="mt-1 text-ink-muted">
              Código:{' '}
              <span className="font-mono text-ink">
                {barcode ?? `se generará un código interno ${internalCodeLabel()} al guardar`}
              </span>
            </p>
            {hint && <p className="mt-1 text-caption text-ink-muted">{hint}</p>}
          </div>
          <button type="button" onClick={onCancel} className="btn btn-ghost">
            <Icon name="x" />
            Cancelar<span className="hidden md:inline"> (Esc)</span>
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          {!online && (
            <p className="notice bg-warning-bg text-warning-fg">
              <Icon name="wifi-off" className="mt-0.5" />
              Sin conexión: el producto se guardará en la cola y se sincronizará después (sin imagen).
            </p>
          )}
          {unlinked && (
            <p className="notice bg-info-bg text-info-fg">
              <Icon name="alert" className="mt-0.5" />
              {unlinked}
            </p>
          )}
          {warning && (
            <p className="notice bg-warning-bg text-warning-fg">
              <Icon name="alert" className="mt-0.5" />
              {warning}
            </p>
          )}

          <div className="rounded-md border border-line bg-subtle p-4">
            {linked ? (
              <div className="flex items-start gap-3">
                {linked.image_url && (
                  <img src={catalogThumb(linked.image_url) ?? ''} alt="" className="size-14 shrink-0 rounded-xs bg-white object-contain" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-label text-success-fg">
                    <Icon name="check" />
                    {linkedBy === 'barcode' ? 'Encontrado en el catálogo por código de barras' : 'Vinculado al catálogo'}
                  </p>
                  <p className="truncate text-heading">{linked.name}</p>
                  <p className="truncate text-ink-muted">
                    {linked.game} · {linked.set_name}
                    {linked.market_price != null && ` · referencia TCGplayer US$ ${linked.market_price.toFixed(2)}`}
                  </p>
                  {linked.linked_barcode && (
                    <p className="mt-2 notice bg-warning-bg text-warning-fg">
                      <Icon name="alert" className="mt-0.5" />
                      Este producto ya está en inventario con el código {linked.linked_barcode}
                      {linked.linked_name && ` (${linked.linked_name})`}. Si es la versión en otro idioma, está bien: elige
                      el idioma abajo.
                    </p>
                  )}
                </div>
                <button type="button" onClick={unlink} className="btn btn-secondary btn-sm">
                  Cambiar
                </button>
              </div>
            ) : online ? (
              <CatalogSearch
                inputRef={catalogRef}
                onSelect={(item) => {
                  applyCatalog(item, 'search')
                  setTimeout(() => priceRef.current?.focus(), 0)
                }}
              />
            ) : (
              <p className="text-ink-muted">El catálogo TCG necesita conexión. Captura los datos a mano.</p>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <label className={label} htmlFor="pf-name">Nombre *</label>
              <input id="pf-name" name="name" ref={nameRef} className={input} value={fields.name} onChange={set('name')} autoComplete="off" />
            </div>
            <div>
              <label className={label} htmlFor="pf-price">Precio de venta * ($)</label>
              <input id="pf-price" name="price" ref={priceRef} className={`${input} tabular-nums`} value={fields.price} onChange={set('price')} inputMode="decimal" autoComplete="off" />
            </div>
            <div>
              <label className={label} htmlFor="pf-cost">Costo ($)</label>
              <input id="pf-cost" name="cost" className={`${input} tabular-nums`} value={fields.cost} onChange={set('cost')} inputMode="decimal" autoComplete="off" />
            </div>
            <div>
              <label className={label} htmlFor="pf-category">Categoría</label>
              <CategorySelect
                id="pf-category"
                value={fields.category}
                onChange={(category) => {
                  setFields((f) => ({ ...f, category }))
                  if (!languageTouched && !linked) setLanguage(suggestedLanguage(category))
                }}
              />
            </div>
            <div>
              <label className={label} htmlFor="pf-supplier">Proveedor</label>
              <input id="pf-supplier" name="supplier" className={input} value={fields.supplier} onChange={set('supplier')} list="pf-suppliers" autoComplete="off" />
              <datalist id="pf-suppliers">{suppliers.map((s) => <option key={s} value={s} />)}</datalist>
            </div>
            {withQuantity && (
              <>
                <div>
                  <label className={label} htmlFor="pf-qty">Cantidad inicial</label>
                  <input id="pf-qty" name="quantity" className={`${input} tabular-nums`} value={fields.quantity} onChange={set('quantity')} inputMode="numeric" autoComplete="off" />
                </div>
                <div className="md:col-span-2">
                  <span className={label}>¿Dónde está?</span>
                  <div className="flex flex-wrap items-center gap-3">
                    <LocationSelect value={location} onChange={setLocation} label="¿Dónde está la cantidad inicial?" />
                    <span className="text-caption text-ink-muted">
                      {location === 'warehouse'
                        ? 'En bodega no se puede vender hasta hacer un movimiento a tienda.'
                        : 'La cantidad inicial entra como el primer lote, con este proveedor y costo.'}
                    </span>
                  </div>
                </div>
              </>
            )}
            {(languageApplies(fields.category, linked?.source) || language) && (
              <div className="md:col-span-2">
                <span className={label}>Idioma</span>
                <LanguageSelect
                  value={language}
                  onChange={(l) => {
                    setLanguage(l)
                    setLanguageTouched(true)
                  }}
                />
                <span className="mt-1 block text-caption text-ink-muted">
                  {linkedBy === 'search' && language === 'es'
                    ? 'El código no es el de la versión en inglés del catálogo: se propone español. Revísalo en la caja.'
                    : 'El de inglés y el de español son productos distintos, cada uno con su código de barras.'}
                </span>
              </div>
            )}
            <div className="md:col-span-2">
              <label className={label} htmlFor="pf-description">Descripción</label>
              <textarea
                id="pf-description"
                name="description"
                rows={3}
                className="field h-auto py-2"
                value={fields.description}
                onChange={set('description')}
              />
            </div>
            <div>
              <span className={label}>Imagen (opcional)</span>
              <div className="flex flex-wrap gap-2">
                <label className="btn btn-secondary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus-ring">
                  <Icon name="upload" />
                  Subir archivo
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) void setImageFrom(f)
                      e.target.value = ''
                    }}
                  />
                </label>
                <button type="button" onClick={() => setCamera(true)} className="btn btn-secondary">
                  <Icon name="camera" />
                  Usar cámara
                </button>
                {image && (
                  <button
                    type="button"
                    onClick={() => {
                      setImage(null)
                      setImageSource(null)
                    }}
                    className="btn btn-danger"
                  >
                    Quitar
                  </button>
                )}
              </div>
            </div>
          </div>

          {camera && <WebcamCapture onCapture={(b) => void setImageFrom(b)} onClose={() => setCamera(false)} />}
          {imageLoading && <p className="text-ink-muted">Descargando foto del catálogo…</p>}
          {preview && <img src={preview} alt="Vista previa" className="max-h-48 rounded-md border border-line" />}

          {error && (
            <p className="notice bg-danger-bg text-danger-fg">
              <Icon name="alert" className="mt-0.5" />
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-line bg-subtle px-6 py-4">
          <button type="submit" disabled={saving || imageLoading} className="btn btn-primary btn-lg w-full sm:w-auto">
            <Icon name="check" size={20} />
            {saving ? 'Guardando…' : 'Guardar producto (Enter)'}
          </button>
        </div>
      </form>
    </div>
  )
}
