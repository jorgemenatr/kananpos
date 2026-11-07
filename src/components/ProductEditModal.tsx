import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { internalCodeLabel, normalizeBarcode } from '../lib/barcode'
import { compressImage } from '../lib/images'
import { formatDateTime, formatInt, formatMoney, parseCount, parseMoney } from '../lib/format'
import { getProductLots } from '../lib/lots'
import { adjustStock, assignBarcode, getCatalogName, getProduct, unlinkProduct, updateProduct } from '../lib/products'
import { useSettings } from '../lib/settings'
import { isNetworkError } from '../lib/supabase'
import {
  LOCATION_LABELS,
  LOCATIONS,
  LOT_ORIGIN_LABELS,
  type LotPick,
  type PreorderDepositType,
  type Product,
  type ProductLanguage,
  type ProductLot,
  type StockLocation,
} from '../lib/types'
import { comboDrinks } from '../store/inventoryStore'
import { useInventory } from '../store/useInventory'
import { CategorySelect } from './CategorySelect'
import { Icon } from './Icon'
import { LanguageSelect } from './LanguageSelect'
import { LanguageTag } from './LanguageTag'
import { languageApplies } from '../lib/language'
import { LocationSelect } from './LocationSelect'
import { LotPicker } from './LotPicker'
import { ProductImage } from './ProductImage'
import { SupplierSelect } from './SupplierSelect'
import { WebcamCapture } from './WebcamCapture'
import { SingleProductReference } from './singles/SuggestedPrice'
import { useAuth } from '../auth/useAuth'

interface Props {
  productId: string
  /** Proveedores ya usados (sugerencias). */
  suppliers: string[]
  onCancel: () => void
  onSaved: (product: Product) => void
  /** Cambios que se aplican al momento (ajuste de existencias, desvincular). */
  onChanged: (product: Product, oldBarcode?: string) => void
}

type Fields = {
  name: string
  price: string
  cost: string
  category: string
  supplier: string
  description: string
  trackStock: boolean
  isPreorder: boolean
  depositType: PreorderDepositType
  depositValue: string
  isCombo: boolean
  language: ProductLanguage | null
}

const moneyText = (n: number | null) => (n == null ? '' : String(n))

/**
 * Editar un producto: nombre, precios, categoría, proveedor, descripción y
 * foto. El código y la cantidad no se editan aquí (la cantidad cambia con
 * escaneos y ventas, para que quede en el historial).
 */
export function ProductEditModal({ productId, suppliers, onCancel, onSaved, onChanged }: Props) {
  const [product, setProduct] = useState<Product | null>(null)
  const [fields, setFields] = useState<Fields | null>(null)
  // undefined = sin cambios; null = quitar; Blob = foto nueva.
  const [image, setImage] = useState<Blob | null | undefined>(undefined)
  const [preview, setPreview] = useState<string | null>(null)
  const [camera, setCamera] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const [catalogName, setCatalogName] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const { products } = useInventory()
  const settings = useSettings()
  const { profile } = useAuth()
  const drinks = comboDrinks(products, settings.comboDrinksCategory).filter((p) => p.id !== productId)

  useEffect(() => {
    getProduct(productId)
      .then((p) => {
        if (!p) return setError('No se encontró el producto.')
        setProduct(p)
        setFields({
          name: p.name,
          price: moneyText(p.price),
          cost: moneyText(p.cost),
          category: p.category ?? '',
          supplier: p.supplier ?? '',
          description: p.description ?? '',
          trackStock: p.track_stock,
          isPreorder: p.is_preorder ?? false,
          depositType: p.preorder_deposit_type ?? 'percent',
          depositValue: moneyText(p.preorder_deposit_value ?? 0),
          isCombo: p.is_combo ?? false,
          language: p.language ?? null,
        })
        setTimeout(() => nameRef.current?.focus(), 0)
        if (p.catalog_product_id != null) void getCatalogName(p.catalog_product_id).then(setCatalogName)
      })
      .catch((e) => setError(isNetworkError(e) ? 'Sin conexión: editar un producto necesita internet.' : (e as Error).message))
  }, [productId])

  useEffect(() => {
    if (!image) return setPreview(null)
    const url = URL.createObjectURL(image)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [image])

  const set = (key: keyof Fields) => (e: { target: { value: string } }) =>
    setFields((f) => (f ? { ...f, [key]: e.target.value } : f))

  async function setImageFrom(blob: Blob) {
    try {
      setImage(await compressImage(blob))
      setCamera(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo procesar la imagen')
    }
  }

  /** Ajuste o desvinculado ya guardado: refleja el producto sin cerrar el formulario. */
  function applied(p: Product, message: string) {
    const oldBarcode = product?.barcode
    setProduct(p)
    if (p.catalog_product_id == null) setCatalogName(null)
    setDone(message)
    onChanged(p, oldBarcode)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (saving || !fields || !product) return
    setError(null)
    const name = fields.name.trim()
    const price = parseMoney(fields.price)
    const cost = parseMoney(fields.cost)
    if (!name) return setError('El nombre es obligatorio.')
    if (price === null || Number.isNaN(price)) return setError('El precio de venta es obligatorio y debe ser un número válido.')
    if (Number.isNaN(cost)) return setError('El costo debe ser un número válido.')
    const depositValue = parseMoney(fields.depositValue) ?? 0
    if (fields.isPreorder) {
      if (Number.isNaN(depositValue) || depositValue < 0) return setError('El anticipo debe ser un número válido.')
      if (fields.depositType === 'percent' && depositValue > 100) return setError('El anticipo en porcentaje no puede pasar de 100.')
    }
    setSaving(true)
    try {
      const saved = await updateProduct(
        product.id,
        {
          name,
          price,
          cost,
          category: fields.category,
          supplier: fields.supplier,
          description: fields.description,
          trackStock: fields.trackStock,
          isPreorder: fields.isPreorder,
          preorderDepositType: fields.depositType,
          preorderDepositValue: Number.isNaN(depositValue) ? 0 : depositValue,
          isCombo: fields.isCombo,
          language: fields.language,
        },
        image,
      )
      onSaved(saved)
    } catch (err) {
      setError(isNetworkError(err) ? 'Sin conexión: no se guardaron los cambios.' : (err as Error).message)
      setSaving(false)
    }
  }

  const input = 'field'
  const label = 'field-label'
  const currentImage = image === undefined ? product?.image_url : null

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4" role="dialog" aria-modal="true" aria-labelledby="pe-title">
      <form
        noValidate
        onSubmit={onSubmit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        className="max-h-full w-full max-w-2xl overflow-auto dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div className="min-w-0">
            <h2 id="pe-title" className="flex flex-wrap items-center gap-2 text-title">
              Editar producto
              <LanguageTag language={product?.language} />
            </h2>
            {product && (
              <p className="mt-1 text-ink-muted">
                Código: <span className="font-mono text-ink">{product.barcode}</span> ·{' '}
                {product.track_stock ? (
                  <>
                    Tienda: <span className="text-ink tabular-nums">{formatInt(product.quantity)}</span> · Bodega:{' '}
                    <span className="text-ink tabular-nums">{formatInt(product.warehouse_quantity)}</span>
                  </>
                ) : (
                  'Sin inventario'
                )}
              </p>
            )}
          </div>
          <button type="button" onClick={onCancel} className="btn btn-ghost">
            <Icon name="x" />
            Cancelar<span className="hidden md:inline"> (Esc)</span>
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          {!fields && !error && <p className="py-6 text-center text-ink-subtle">Cargando producto…</p>}

          {fields && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="md:col-span-2">
                <label className={label} htmlFor="pe-name">Nombre *</label>
                <input id="pe-name" ref={nameRef} className={input} value={fields.name} onChange={set('name')} autoComplete="off" />
              </div>
              <div>
                <label className={label} htmlFor="pe-price">Precio de venta * ($)</label>
                <input id="pe-price" className={`${input} tabular-nums`} value={fields.price} onChange={set('price')} inputMode="decimal" autoComplete="off" />
              </div>
              <div>
                <label className={label} htmlFor="pe-cost">Costo ($)</label>
                <input id="pe-cost" className={`${input} tabular-nums`} value={fields.cost} onChange={set('cost')} inputMode="decimal" autoComplete="off" />
              </div>
              {product?.tcg_product_id != null && (
                <div className="md:col-span-2">
                  <SingleProductReference
                    product={product}
                    isAdmin={profile?.role === 'admin'}
                    onApplied={(price) => {
                      setFields((f) => (f ? { ...f, price: moneyText(price) } : f))
                      applied({ ...product, price }, `Se aplicó el precio sugerido: ${formatMoney(price)}.`)
                    }}
                  />
                </div>
              )}
              <div>
                <label className={label} htmlFor="pe-category">Categoría</label>
                <CategorySelect id="pe-category" value={fields.category} onChange={(category) => setFields((f) => (f ? { ...f, category } : f))} />
              </div>
              <div>
                <label className={label} htmlFor="pe-supplier">Proveedor</label>
                <input id="pe-supplier" className={input} value={fields.supplier} onChange={set('supplier')} list="pe-suppliers" autoComplete="off" />
                <datalist id="pe-suppliers">{suppliers.map((s) => <option key={s} value={s} />)}</datalist>
              </div>
              {(languageApplies(fields.category) || fields.language || product?.language) && (
                <div className="md:col-span-2">
                  <span className={label}>Idioma</span>
                  <LanguageSelect value={fields.language} onChange={(language) => setFields((f) => (f ? { ...f, language } : f))} />
                  <span className="mt-1 block text-caption text-ink-muted">
                    El de inglés y el de español son productos distintos, cada uno con su código de barras.
                  </span>
                </div>
              )}
              <div className="md:col-span-2">
                <label className={label} htmlFor="pe-description">Descripción</label>
                <textarea id="pe-description" rows={3} className="field h-auto py-2" value={fields.description} onChange={set('description')} />
              </div>
              <div className="md:col-span-2">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={!fields.trackStock}
                    disabled={product?.track_stock !== false && ((product?.quantity ?? 0) !== 0 || (product?.warehouse_quantity ?? 0) !== 0)}
                    onChange={(e) => setFields((f) => (f ? { ...f, trackStock: !e.target.checked, isPreorder: e.target.checked ? false : f.isPreorder } : f))}
                  />
                  <span>
                    <span className="text-label text-ink">Sin control de inventario</span>
                    <span className="block text-caption text-ink-muted">
                      Para comida, torneos y servicios: se venden sin revisar ni descontar existencias.
                      {product?.track_stock !== false &&
                        ((product?.quantity ?? 0) !== 0 || (product?.warehouse_quantity ?? 0) !== 0) &&
                        ' Primero deja sus existencias de tienda y bodega en 0.'}
                    </span>
                  </span>
                </label>
              </div>
              <div className="md:col-span-2 rounded-md border border-line p-4">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={fields.isPreorder}
                    disabled={!fields.trackStock}
                    onChange={(e) => setFields((f) => (f ? { ...f, isPreorder: e.target.checked } : f))}
                  />
                  <span>
                    <span className="text-label text-ink">Preventa</span>
                    <span className="block text-caption text-ink-muted">
                      Se vende con anticipo aunque aún no llegue: las piezas quedan comprometidas y se entregan cuando el cliente
                      termina de pagar. Apágalo cuando ya no quieras prevender.
                      {!fields.trackStock && ' Solo productos con control de inventario.'}
                      {(product?.preorder_reserved ?? 0) > 0 && ` Hoy hay ${formatInt(product?.preorder_reserved ?? 0)} pieza(s) comprometidas.`}
                    </span>
                  </span>
                </label>
                {fields.isPreorder && (
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <div>
                      <label className={label} htmlFor="pe-deposit-type">Anticipo mínimo</label>
                      <select
                        id="pe-deposit-type"
                        value={fields.depositType}
                        onChange={(e) => setFields((f) => (f ? { ...f, depositType: e.target.value as PreorderDepositType } : f))}
                        className="field cursor-pointer"
                      >
                        <option value="percent">Porcentaje del precio</option>
                        <option value="amount">Monto por pieza</option>
                      </select>
                    </div>
                    <div>
                      <label className={label} htmlFor="pe-deposit-value">{fields.depositType === 'percent' ? '%' : '$ por pieza'}</label>
                      <input
                        id="pe-deposit-value"
                        className={`${input} w-32 tabular-nums`}
                        value={fields.depositValue}
                        onChange={set('depositValue')}
                        inputMode="decimal"
                        autoComplete="off"
                      />
                    </div>
                  </div>
                )}
              </div>
              <div className="md:col-span-2 rounded-md border border-line p-4">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={fields.isCombo}
                    onChange={(e) => setFields((f) => (f ? { ...f, isCombo: e.target.checked } : f))}
                  />
                  <span>
                    <span className="text-label text-ink">Combo: incluye una bebida a elegir</span>
                    <span className="block text-caption text-ink-muted">
                      {settings.comboDrinksCategory
                        ? `Al venderlo se elige entre las ${drinks.length} bebidas de ${settings.comboDrinksCategory}. La bebida va incluida ($0) y descuenta su propio inventario. Para cambiar la lista, mueve productos a esa categoría.`
                        : 'Falta elegir el grupo de bebidas de los combos en Configuración → Operación.'}
                    </span>
                  </span>
                </label>
              </div>
              <div className="md:col-span-2">
                <span className={label}>Imagen</span>
                <div className="flex flex-wrap items-start gap-4">
                  {preview ? (
                    <img src={preview} alt="Vista previa" className="size-28 rounded-md border border-line object-contain" />
                  ) : (
                    <ProductImage path={currentImage ?? null} alt="" className="size-28 rounded-md" />
                  )}
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
                    {(preview || currentImage) && (
                      <button type="button" onClick={() => setImage(null)} className="btn btn-danger">
                        Quitar
                      </button>
                    )}
                    {image !== undefined && (
                      <button type="button" onClick={() => setImage(undefined)} className="btn btn-ghost">
                        Deshacer cambio de foto
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {product && fields && (
            <>
              {done && (
                <p className="notice bg-success-bg text-success-fg" role="status">
                  <Icon name="check" className="mt-0.5" />
                  {done}
                </p>
              )}
              {product.track_stock && (
                <StockSection
                  product={product}
                  onAdjusted={(p, location) =>
                    applied(
                      p,
                      `Existencias de ${LOCATION_LABELS[location].toLowerCase()} ajustadas a ${formatInt(location === 'store' ? p.quantity : p.warehouse_quantity)}. Quedó en el historial.`,
                    )
                  }
                />
              )}
              {product.is_internal_code && (
                <CorrectionSection
                  title="Asignar código de barras"
                  summary={
                    <>
                      Tiene el código interno <span className="font-mono text-ink">{product.barcode}</span>
                    </>
                  }
                  help="Escanea o escribe el código de barras del producto. El código interno deja de funcionar: tira su etiqueta impresa."
                  action="Asignar código"
                  valueLabel="Código de barras"
                  valueInputMode="text"
                  valueMissing="Escribe o escanea el código de barras."
                  confirm="Asignar"
                  run={async (value) => {
                    const p = await assignBarcode(product.id, normalizeBarcode(value))
                    applied(p, `Código ${p.barcode} asignado. Ya puedes escanearlo para vender.`)
                  }}
                />
              )}
              <CorrectionSection
                title="Código de barras y catálogo"
                summary={
                  <>
                    {product.is_internal_code ? 'Código interno ' : 'Código '}
                    <span className="font-mono text-ink">{product.barcode}</span>
                    {product.catalog_product_id != null && (
                      <>
                        {' '}
                        · Vinculado al catálogo: <span className="text-ink">{catalogName ?? `#${product.catalog_product_id}`}</span>
                      </>
                    )}
                  </>
                }
                help={
                  product.is_internal_code
                    ? 'Quita el vínculo con el catálogo TCGplayer. Los datos del producto no cambian.'
                    : `El producto se queda con un código interno ${internalCodeLabel()} y pierde el vínculo con el catálogo. Si después escaneas este código, se tomará como nuevo y podrás asignarlo al producto correcto del catálogo.`
                }
                action={product.is_internal_code ? 'Desvincular del catálogo' : 'Desvincular código'}
                disabled={product.is_internal_code && product.catalog_product_id == null}
                reasonPlaceholder="Ej. Se escaneó el código de otro producto / el catálogo lo vinculó mal"
                confirm="Desvincular"
                danger
                run={async (_value, reason) => {
                  const p = await unlinkProduct(product.id, reason)
                  applied(
                    p,
                    p.barcode === product.barcode
                      ? 'Producto desvinculado del catálogo.'
                      : `Código ${product.barcode} desvinculado. El producto ahora es ${p.barcode} (imprime su etiqueta nueva).`,
                  )
                }}
              />
            </>
          )}

          {camera && <WebcamCapture onCapture={(b) => void setImageFrom(b)} onClose={() => setCamera(false)} />}

          {error && (
            <p className="notice bg-danger-bg text-danger-fg">
              <Icon name="alert" className="mt-0.5" />
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-line bg-subtle px-6 py-4">
          <button type="submit" disabled={saving || !fields} className="btn btn-primary btn-lg w-full sm:w-auto">
            <Icon name="check" size={20} />
            {saving ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * Corrección que se aplica al momento (queda en el historial). Con
 * reasonPlaceholder pide motivo; con valueLabel pide un valor (p. ej. la
 * cantidad correcta).
 */
function CorrectionSection({
  title,
  summary,
  help,
  action,
  valueLabel,
  valueInputMode = 'numeric',
  valueMissing,
  placeholder,
  reasonPlaceholder,
  confirm,
  danger,
  disabled,
  run,
}: {
  title: string
  summary: ReactNode
  help?: string
  action: string
  valueLabel?: string
  valueInputMode?: 'numeric' | 'text'
  /** Error si falta el valor (por defecto: "Escribe la <valueLabel>."). */
  valueMissing?: string
  placeholder?: string
  /** Sin él no se pide motivo. */
  reasonPlaceholder?: string
  confirm: string
  danger?: boolean
  disabled?: boolean
  run: (value: string, reason: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function apply() {
    if (busy) return
    setError(null)
    if (valueLabel && !value.trim()) return setError(valueMissing ?? `Escribe la ${valueLabel.toLowerCase()}.`)
    if (reasonPlaceholder !== undefined && !reason.trim()) return setError('El motivo es obligatorio.')
    setBusy(true)
    try {
      await run(value, reason)
      setOpen(false)
      setValue('')
      setReason('')
    } catch (e) {
      setError(isNetworkError(e) ? 'Sin conexión: intenta cuando vuelva el internet.' : (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-md border border-line p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto min-w-0">
          <p className="text-label">{title}</p>
          <p className="text-ink-muted">{summary}</p>
        </div>
        {!open && (
          <button type="button" onClick={() => setOpen(true)} disabled={disabled} className="btn btn-secondary btn-sm">
            {action}
          </button>
        )}
      </div>
      {open && (
        // No es un <form> (ya estamos dentro de uno): Enter aplica la corrección.
        <div
          className="mt-3 space-y-3"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void apply()
            }
          }}
        >
          {help && <p className="text-caption text-ink-muted">{help}</p>}
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            {valueLabel && (
              <div className={reasonPlaceholder !== undefined ? '' : 'sm:col-span-2'}>
                <label className="field-label" htmlFor={`cs-${title}-value`}>{valueLabel} *</label>
                <input
                  id={`cs-${title}-value`}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  inputMode={valueInputMode}
                  placeholder={placeholder}
                  autoFocus
                  autoComplete="off"
                  className="field tabular-nums"
                />
              </div>
            )}
            {reasonPlaceholder !== undefined && (
              <div className={valueLabel ? '' : 'sm:col-span-2'}>
                <label className="field-label" htmlFor={`cs-${title}-reason`}>Motivo *</label>
                <input
                  id={`cs-${title}-reason`}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={reasonPlaceholder}
                  autoFocus={!valueLabel}
                  autoComplete="off"
                  className="field"
                />
              </div>
            )}
          </div>
          {error && (
            <p className="notice bg-danger-bg text-danger-fg">
              <Icon name="alert" className="mt-0.5" />
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setError(null)
              }}
              className="btn btn-ghost btn-sm"
            >
              Cancelar
            </button>
            <button type="button" onClick={() => void apply()} disabled={busy} className={`btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`}>
              {busy ? 'Aplicando…' : confirm}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * Existencias por ubicación: lotes activos (proveedor, costo, cantidad) y el
 * ajuste de una ubicación (merma / entrada manual) con su motivo. Al bajar,
 * se elige de qué lote salen las piezas.
 */
function StockSection({ product, onAdjusted }: { product: Product; onAdjusted: (p: Product, location: StockLocation) => void }) {
  const [lots, setLots] = useState<ProductLot[] | null>(null)
  const [lotsError, setLotsError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [location, setLocation] = useState<StockLocation>('store')
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const [supplierId, setSupplierId] = useState<string | null>(product.supplier_id)
  const [costText, setCostText] = useState(product.cost == null ? '' : String(product.cost))
  const [picking, setPicking] = useState<{ remove: number; qty: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    getProductLots(product.id)
      .then(setLots)
      .catch((e) => setLotsError(isNetworkError(e) ? 'Sin conexión: no se pudieron cargar los lotes.' : (e as Error).message))
  }, [product.id])

  useEffect(reload, [reload, product.quantity, product.warehouse_quantity])

  const current = location === 'store' ? product.quantity : product.warehouse_quantity
  const qty = value.trim() ? parseCount(value) : NaN
  const goesUp = !Number.isNaN(qty) && qty > current

  async function run(picks: LotPick[] | null) {
    setBusy(true)
    setError(null)
    try {
      const cost = parseMoney(costText)
      const p = await adjustStock(product.id, qty, reason, {
        location,
        lots: picks,
        supplierId: goesUp ? supplierId : null,
        unitCost: goesUp && cost !== null && !Number.isNaN(cost) ? cost : null,
      })
      setOpen(false)
      setValue('')
      setReason('')
      onAdjusted(p, location)
    } catch (e) {
      setError(isNetworkError(e) ? 'Sin conexión: intenta cuando vuelva el internet.' : (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function apply() {
    if (busy) return
    setError(null)
    if (Number.isNaN(qty)) return setError('La cantidad correcta debe ser un número entero (0 o más).')
    if (qty === current) return setError(`La cantidad en ${LOCATION_LABELS[location].toLowerCase()} ya es ${formatInt(qty)}.`)
    if (!reason.trim()) return setError('El motivo es obligatorio.')
    if (goesUp && Number.isNaN(parseMoney(costText))) return setError('El costo debe ser un número válido.')
    if (goesUp) return void run(null)
    // Baja: con un solo lote ahí no hay que elegir.
    const here = (lots ?? []).filter((l) => l.location === location)
    if (here.length === 1) return void run([{ lot_id: here[0].lot_id, quantity: current - qty }])
    setPicking({ remove: current - qty, qty })
  }

  return (
    <section className="rounded-md border border-line p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto min-w-0">
          <p className="text-label">Existencias y lotes</p>
          <p className="text-ink-muted">
            Tienda <span className="font-medium text-ink tabular-nums">{formatInt(product.quantity)}</span> · Bodega{' '}
            <span className="font-medium text-ink tabular-nums">{formatInt(product.warehouse_quantity)}</span> · Total{' '}
            <span className="font-medium text-ink tabular-nums">{formatInt(product.quantity + product.warehouse_quantity)}</span>
          </p>
        </div>
        {!open && (
          <button type="button" onClick={() => setOpen(true)} className="btn btn-secondary btn-sm">
            Ajustar existencias
          </button>
        )}
      </div>

      {lotsError && <p className="mt-2 text-caption text-danger-fg">{lotsError}</p>}
      {lots && lots.length > 0 && (
        <div className="mt-3 space-y-3">
          {LOCATIONS.map((loc) => {
            const here = lots.filter((l) => l.location === loc)
            if (!here.length) return null
            return (
              <div key={loc}>
                <p className="mb-1 text-caption font-medium text-ink-muted">{LOCATION_LABELS[loc]}</p>
                <ul className="divide-y divide-line rounded-md border border-line">
                  {here.map((l) => (
                    <li key={`${l.lot_id}-${loc}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
                      <span className="font-medium">Lote {l.number}</span>
                      <span className="text-ink-muted">{l.supplier_name ?? 'Sin proveedor'}</span>
                      <span className="tabular-nums">{formatMoney(l.unit_cost)} c/u</span>
                      <span className="text-caption text-ink-subtle">
                        {LOT_ORIGIN_LABELS[l.origin]}
                        {l.purchase_folio ? ` ${l.purchase_folio}` : ''} · {formatDateTime(l.received_at)}
                      </span>
                      <span className="ml-auto text-heading tabular-nums">{formatInt(l.quantity)} pzas</span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      )}
      {lots && lots.length === 0 && <p className="mt-2 text-caption text-ink-subtle">Sin piezas en ningún lote.</p>}

      {open && (
        // No es un <form> (ya estamos dentro de uno): Enter aplica el ajuste.
        <div
          className="mt-4 space-y-3 border-t border-line pt-4"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              apply()
            }
          }}
        >
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <span className="field-label">Ubicación</span>
              <LocationSelect value={location} onChange={setLocation} />
            </div>
            <p className="pb-2 text-ink-muted">
              Hay <span className="font-medium text-ink tabular-nums">{formatInt(current)}</span>
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <div>
              <label className="field-label" htmlFor="ss-value">Cantidad correcta *</label>
              <input
                id="ss-value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                inputMode="numeric"
                placeholder="Ej. 3"
                autoFocus
                autoComplete="off"
                className="field tabular-nums"
              />
            </div>
            <div>
              <label className="field-label" htmlFor="ss-reason">Motivo *</label>
              <input
                id="ss-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ej. Merma / producto dañado / se encontraron piezas"
                autoComplete="off"
                className="field"
              />
            </div>
          </div>
          {goesUp && (
            <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
              <div>
                <label className="field-label" htmlFor="ss-supplier">Proveedor del lote nuevo</label>
                <SupplierSelect id="ss-supplier" value={supplierId} onChange={(id) => setSupplierId(id)} noneLabel="Sin proveedor" />
              </div>
              <div>
                <label className="field-label" htmlFor="ss-cost">Costo unitario ($)</label>
                <input
                  id="ss-cost"
                  value={costText}
                  onChange={(e) => setCostText(e.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  className="field tabular-nums"
                />
              </div>
            </div>
          )}
          {!Number.isNaN(qty) && qty < current && (
            <p className="text-caption text-ink-muted">
              Salen {formatInt(current - qty)} pzas
              {(lots ?? []).filter((l) => l.location === location).length > 1 ? ': te pediremos de qué lote.' : '.'}
            </p>
          )}
          {error && (
            <p className="notice bg-danger-bg text-danger-fg">
              <Icon name="alert" className="mt-0.5" />
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setError(null)
              }}
              className="btn btn-ghost btn-sm"
            >
              Cancelar
            </button>
            <button type="button" onClick={apply} disabled={busy} className="btn btn-primary btn-sm">
              {busy ? 'Aplicando…' : 'Aplicar ajuste'}
            </button>
          </div>
        </div>
      )}

      {picking && (
        <LotPicker
          productId={product.id}
          productName={product.name}
          location={location}
          remove={picking.remove}
          purpose={reason.trim() || 'Ajuste'}
          onCancel={() => setPicking(null)}
          onConfirm={(picks) => {
            setPicking(null)
            void run(picks)
          }}
        />
      )}
    </section>
  )
}
