import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAuth } from '../auth/useAuth'
import { FiltersButton } from '../components/FiltersButton'
import { Icon } from '../components/Icon'
import { LanguageTag, languageSearchText } from '../components/LanguageTag'
import { MoreMenu } from '../components/MoreMenu'
import { NewProductDialog } from '../components/NewProductDialog'
import { ProductDetailModal } from '../components/ProductDetailModal'
import { ProductEditModal } from '../components/ProductEditModal'
import { ProductImage } from '../components/ProductImage'
import { Segmented } from '../components/Segmented'
import { mainCategory, matchesCategory, useCategories } from '../lib/categories'
import { buildInventoryRows, exportCsv, exportXlsx, type StockScope } from '../lib/export'
import { formatInt, formatMoney } from '../lib/format'
import { exportName } from '../lib/settings'
import { inventoryStore, tracksStock, type CachedProduct } from '../store/inventoryStore'
import { useInventory } from '../store/useInventory'

/*
 * Inventario: consulta de productos en cuadrícula (fotos) o lista (tabla).
 * Lee la copia local del catálogo de productos (la misma que usa Escaneo),
 * así que también funciona sin conexión.
 *
 * Tienda | Bodega | Total escoge qué existencias se muestran, suman y
 * exportan. "Sin stock" y "stock bajo" se calculan SIEMPRE con la tienda
 * (es lo que se puede vender), sin importar el filtro. Los productos sin
 * inventario (comida, torneos) nunca cuentan como sin stock.
 */

type View = 'grid' | 'list'
type SortKey = 'name' | 'barcode' | 'category' | 'quantity' | 'price'
type StockFilter = 'all' | 'in' | 'out' | 'alert'

/** Stock bajo en tienda: 2 piezas o menos. */
const LOW_STOCK = 2

type StoreStatus = 'out' | 'low' | 'ok'
const storeStatus = (p: CachedProduct): StoreStatus =>
  !tracksStock(p) ? 'ok' : p.quantity <= 0 ? 'out' : p.quantity <= LOW_STOCK ? 'low' : 'ok'

const scopeQty = (p: CachedProduct, scope: StockScope) =>
  scope === 'store' ? p.quantity : scope === 'warehouse' ? (p.warehouse_quantity ?? 0) : p.quantity + (p.warehouse_quantity ?? 0)

const SCOPE_LABELS: Record<StockScope, string> = { store: 'en tienda', warehouse: 'en bodega', total: 'en total' }

const VIEW_KEY = 'hachiko.inventario.vista'

/** Singles en la vista: sin (por defecto), con, o solo singles. */
type SinglesMode = 'exclude' | 'include' | 'only'
const PAGE = 60
const collator = new Intl.Collator('es-MX', { sensitivity: 'base', numeric: true })

function loadView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

export function InventoryPage() {
  const { products, productsLoaded, online } = useInventory()
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [editing, setEditing] = useState<string | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  // Singles (cartas sueltas): fuera por defecto, para que no llenen la vista normal.
  const [singles, setSingles] = useState<SinglesMode>('exclude')
  const [view, setViewState] = useState<View>(loadView)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [stock, setStock] = useState<StockFilter>('all')
  const [scope, setScope] = useState<StockScope>('total')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [limit, setLimit] = useState(PAGE)

  // Al entrar, trae lo más reciente del servidor (si hay red; si no, se queda la copia local).
  useEffect(() => {
    if (online) void inventoryStore.refreshProducts()
    // Solo al entrar a la página.
  }, [])

  function setView(v: View) {
    setViewState(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* no crítico */
    }
  }

  const everything = useMemo(() => Object.values(products), [products])
  const hasSingles = useMemo(() => everything.some((p) => p.tcg_product_id), [everything])
  const all = useMemo(
    () =>
      singles === 'include'
        ? everything
        : everything.filter((p) => (singles === 'only' ? !!p.tcg_product_id : !p.tcg_product_id)),
    [everything, singles],
  )
  const { tree, values: categoryValues } = useCategories()

  // Categorías que ya no existen (productos viejos): se pueden filtrar igual.
  const legacyCategories = useMemo(
    () =>
      [...new Set(all.map((p) => p.category).filter((c): c is string => !!c && !categoryValues.has(c)))].sort(
        collator.compare,
      ),
    [all, categoryValues],
  )
  const selectedMain = tree.find((c) => c.value === mainCategory(category))

  const suppliers = useMemo(
    () => [...new Set(all.map((p) => p.supplier).filter((s): s is string => !!s))].sort(collator.compare),
    [all],
  )

  const countByMain = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of all) {
      const c = mainCategory(p.category)
      if (c) m.set(c, (m.get(c) ?? 0) + 1)
      if (p.category && p.category !== c) m.set(p.category, (m.get(p.category) ?? 0) + 1)
    }
    return m
  }, [all])

  const filtered = useMemo(() => {
    const words = normalize(search.trim()).split(/\s+/).filter(Boolean)
    const list = all.filter((p) => {
      if (!matchesCategory(p.category, category)) return false
      if (stock === 'in' && scopeQty(p, scope) <= 0) return false
      if (stock === 'out' && (scopeQty(p, scope) > 0 || !tracksStock(p))) return false
      if (stock === 'alert' && storeStatus(p) === 'ok') return false
      if (!words.length) return true
      const text = normalize(`${p.name} ${p.barcode} ${p.category ?? ''} ${p.supplier ?? ''} ${languageSearchText(p.language)}`)
      return words.every((w) => text.includes(w))
    })
    const { key, dir } = sort
    return list.sort((a, b) => {
      const r =
        key === 'quantity'
          ? scopeQty(a, scope) - scopeQty(b, scope)
          : key === 'price'
            ? a.price - b.price
            : collator.compare(a[key] ?? '', b[key] ?? '')
      return r * dir || collator.compare(a.name, b.name)
    })
  }, [all, search, category, stock, sort, scope])

  // Al cambiar los filtros se vuelve a la primera página.
  useEffect(() => setLimit(PAGE), [search, category, stock, sort, view, scope, singles])

  const visible = useMemo(() => filtered.slice(0, limit), [filtered, limit])

  const totals = useMemo(() => {
    let pieces = 0
    let value = 0
    let out = 0
    let low = 0
    for (const p of filtered) {
      const q = Math.max(0, scopeQty(p, scope))
      pieces += q
      value += q * p.price
      const st = storeStatus(p)
      if (st === 'out') out++
      else if (st === 'low') low++
    }
    return { products: filtered.length, pieces, value, out, low }
  }, [filtered, scope])

  async function doExport(kind: 'csv' | 'xlsx') {
    if (exporting) return
    setExporting(true)
    setExportError(null)
    try {
      const rows = await buildInventoryRows(scope)
      const name = exportName(scope === 'store' ? 'tienda' : scope === 'warehouse' ? 'bodega' : 'total')
      if (kind === 'csv') exportCsv(rows, name)
      else await exportXlsx(rows, name, 'Inventario')
    } catch (e) {
      setExportError(online ? (e as Error).message : 'Se necesita conexión para exportar.')
    } finally {
      setExporting(false)
    }
  }

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'quantity' || key === 'price' ? -1 : 1 }))
  }

  const filtersActive = search.trim() !== '' || category !== '' || stock !== 'all' || singles !== 'exclude'
  // En el celular, Tienda/Bodega/Total también va dentro de Filtros.
  const mobileFiltersActive = filtersActive || scope !== 'total'
  // En el celular las categorías, la búsqueda y los filtros van plegados.
  const [showFilters, setShowFilters] = useState(false)
  const filtersClass = showFilters ? '' : 'max-md:hidden'

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="hidden mr-auto text-title-lg uppercase md:block">Inventario</h1>
        <FiltersButton open={showFilters} active={mobileFiltersActive} onToggle={() => setShowFilters((v) => !v)} className="mr-auto" />
        <div className={`max-md:order-last max-md:w-full ${filtersClass}`}>
          <Segmented
          value={scope}
          onChange={setScope}
          label="Existencias"
          options={[
            { value: 'store', label: 'Tienda', icon: 'store' },
            { value: 'warehouse', label: 'Bodega', icon: 'box' },
            { value: 'total', label: 'Total' },
          ]}
          />
        </div>
        <div className="seg" role="group" aria-label="Vista">
          {(
            [
              ['grid', 'grid', 'Cuadrícula'],
              ['list', 'list', 'Lista'],
            ] as const
          ).map(([v, icon, text]) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className="seg-option"
            >
              <Icon name={icon} />
              <span className="max-md:sr-only">{text}</span>
            </button>
          ))}
        </div>
        {isAdmin && (
          <button type="button" onClick={() => setCreating(true)} className="btn btn-primary">
            <Icon name="plus" />
            <span className="max-md:sr-only">Nuevo producto</span>
          </button>
        )}
        {isAdmin && (
          <MoreMenu
            items={[
              { label: 'Movimiento de bodega', icon: 'swap', to: '/movimiento-bodega' },
              ...(online && !exporting
                ? [
                    { label: 'Exportar CSV', icon: 'download' as const, onClick: () => void doExport('csv') },
                    { label: 'Exportar Excel', icon: 'download' as const, onClick: () => void doExport('xlsx') },
                  ]
                : []),
            ]}
          />
        )}
      </div>

      {created && (
        <p className="notice bg-success-bg text-success-fg" role="status">
          <Icon name="check" className="mt-0.5" />
          {created}
        </p>
      )}

      {exportError && (
        <p className="notice bg-danger-bg text-danger-fg">
          <Icon name="alert" className="mt-0.5" />
          No se pudo exportar: {exportError}
        </p>
      )}

      {/* Resumen: solo en pantallas grandes. */}
      <div className="hidden grid-cols-2 gap-3 md:grid lg:grid-cols-4">
        <div className="card p-4">
          <p className="stat-label text-ink-muted">Productos</p>
          <p className="text-kpi tabular-nums">{formatInt(totals.products)}</p>
        </div>
        <div className="card p-4">
          <p className="stat-label text-ink-muted">Piezas {SCOPE_LABELS[scope]}</p>
          <p className="text-kpi tabular-nums">{formatInt(totals.pieces)}</p>
        </div>
        <div className="card p-4">
          <p className="stat-label text-ink-muted">Valor a precio de venta ({SCOPE_LABELS[scope]})</p>
          <p className="text-kpi tabular-nums">{formatMoney(totals.value)}</p>
        </div>
        <button
          type="button"
          onClick={() => setStock((s) => (s === 'alert' ? 'all' : 'alert'))}
          aria-pressed={stock === 'alert'}
          className={`card cursor-pointer p-4 text-left hover:bg-subtle ${stock === 'alert' ? 'border-2 border-brand' : ''}`}
        >
          <p className="stat-label text-ink-muted">Alertas de tienda</p>
          <p className="text-kpi tabular-nums">
            <span className={totals.out ? 'text-danger-fg' : ''}>{formatInt(totals.out)}</span>
            <span className="text-heading text-ink-muted"> sin stock · </span>
            <span className={totals.low ? 'text-warning-fg' : ''}>{formatInt(totals.low)}</span>
            <span className="text-heading text-ink-muted"> bajos</span>
          </p>
        </button>
      </div>

      {/* Categorías */}
      <div className={`flex flex-col gap-2 ${filtersClass}`}>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Categoría">
          <Chip active={category === ''} onClick={() => setCategory('')}>
            Todas
          </Chip>
          {tree.map((c) => (
            <Chip
              key={c.id}
              active={mainCategory(category) === c.value}
              count={countByMain.get(c.value)}
              onClick={() => setCategory(c.value)}
            >
              {c.name}
            </Chip>
          ))}
          {legacyCategories.map((c) => (
            <Chip key={c} active={category === c} count={countByMain.get(c)} onClick={() => setCategory(c)} subtle>
              {c}
            </Chip>
          ))}
        </div>
        {!!selectedMain?.children.length && (
          <div className="flex flex-wrap gap-2 border-l-2 border-line pl-3" role="group" aria-label="Subcategoría">
            <Chip active={category === selectedMain.value} onClick={() => setCategory(selectedMain.value)} small>
              Todo {selectedMain.name}
            </Chip>
            {selectedMain.children.map((s) => (
              <Chip
                key={s.id}
                active={category === s.value}
                count={countByMain.get(s.value)}
                onClick={() => setCategory(s.value)}
                small
              >
                {s.name}
              </Chip>
            ))}
          </div>
        )}
      </div>

      {/* Filtros */}
      <div className={`flex flex-wrap items-center gap-3 ${filtersClass}`}>
        <label className="search-field w-full max-w-sm">
          <Icon name="search" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, código o categoría"
            aria-label="Buscar por nombre, código o categoría"
            className="min-w-0 flex-1 bg-transparent text-ink outline-none focus-visible:outline-none"
          />
        </label>
        <select
          value={stock}
          onChange={(e) => setStock(e.target.value as StockFilter)}
          aria-label="Existencias"
          className="field w-auto cursor-pointer"
        >
          <option value="all">Con y sin stock</option>
          <option value="in">Con stock ({SCOPE_LABELS[scope]})</option>
          <option value="out">Sin stock ({SCOPE_LABELS[scope]})</option>
          <option value="alert">Sin stock o bajo en tienda</option>
        </select>
        {(hasSingles || singles !== 'exclude') && (
          <select
            value={singles}
            onChange={(e) => setSingles(e.target.value as SinglesMode)}
            aria-label="Singles"
            className="field w-auto cursor-pointer"
          >
            <option value="exclude">Sin singles</option>
            <option value="include">Con singles</option>
            <option value="only">Solo singles</option>
          </select>
        )}
        {/* En la lista de md+ se ordena con los encabezados (en el celular la lista no los tiene). */}
        <select
          value={`${sort.key}:${sort.dir}`}
          onChange={(e) => {
            const [key, dir] = e.target.value.split(':')
            setSort({ key: key as SortKey, dir: Number(dir) as 1 | -1 })
          }}
          aria-label="Ordenar"
          className={`field w-auto cursor-pointer ${view === 'list' ? 'md:hidden' : ''}`}
        >
          <option value="name:1">Nombre (A–Z)</option>
          <option value="quantity:-1">Más stock</option>
          <option value="quantity:1">Menos stock</option>
          <option value="price:-1">Precio más alto</option>
          <option value="price:1">Precio más bajo</option>
        </select>
        {filtersActive && (
          <button
            type="button"
            onClick={() => {
              setSearch('')
              setCategory('')
              setStock('all')
              setSingles('exclude')
            }}
            className="btn btn-ghost btn-sm"
          >
            <Icon name="x" />
            Quitar filtros
          </button>
        )}
      </div>

      {!productsLoaded && <p className="py-10 text-center text-ink-subtle">Cargando inventario…</p>}
      {productsLoaded && filtered.length === 0 && (
        <p className="card px-4 py-10 text-center text-ink-subtle">
          {everything.length === 0 ? 'Aún no hay productos. Dalos de alta desde Escaneo.' : 'Ningún producto coincide con los filtros.'}
        </p>
      )}

      {visible.length > 0 && view === 'grid' && (
        <ProductGrid products={visible} scope={scope} onEdit={isAdmin ? setEditing : undefined} onOpen={setViewing} />
      )}
      {visible.length > 0 && view === 'list' && (
        <ProductTable products={visible} scope={scope} sort={sort} onSort={toggleSort} onEdit={isAdmin ? setEditing : undefined} onOpen={setViewing} />
      )}

      {filtered.length > visible.length && (
        <div className="flex items-center justify-between gap-4">
          <span className="text-caption text-ink-muted">
            Mostrando {formatInt(visible.length)} de {formatInt(filtered.length)}
          </span>
          <button type="button" onClick={() => setLimit((l) => l + PAGE)} className="btn btn-secondary">
            Mostrar más
          </button>
        </div>
      )}

      {creating && (
        <NewProductDialog
          onCancel={() => setCreating(false)}
          onSaved={(out) => {
            setCreating(false)
            setCreated(
              `${out.existed ? 'Ya existía' : out.pending ? 'Guardado sin conexión (pendiente)' : 'Se dio de alta'}: ${out.product.name} (${out.product.barcode}). ` +
                'Si no lleva inventario (comida, torneos), márcalo así con el lápiz.',
            )
          }}
        />
      )}

      {viewing && (
        <ProductDetailModal
          productId={viewing}
          onClose={() => setViewing(null)}
          onEdit={
            isAdmin
              ? () => {
                  setEditing(viewing)
                  setViewing(null)
                }
              : undefined
          }
        />
      )}

      {editing && (
        <ProductEditModal
          productId={editing}
          suppliers={suppliers}
          onCancel={() => setEditing(null)}
          onChanged={(p, oldBarcode) => inventoryStore.productEdited(p, oldBarcode)}
          onSaved={(p) => {
            inventoryStore.productEdited(p)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function Chip({
  active,
  count,
  onClick,
  small,
  subtle,
  children,
}: {
  active: boolean
  count?: number
  onClick: () => void
  small?: boolean
  subtle?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`choice ${small ? 'choice-sm' : 'h-control-md'} ${subtle && !active ? 'text-ink-subtle' : ''}`}
    >
      {children}
      {count != null && <span className="tabular-nums opacity-70">{formatInt(count)}</span>}
    </button>
  )
}

/** Un producto aún en la cola (sin id real) no se puede editar. */
const editable = (p: CachedProduct) => !p.pending && !p.id.startsWith('pending:')

function EditButton({ product, onEdit }: { product: CachedProduct; onEdit?: (id: string) => void }) {
  if (!onEdit || !editable(product)) return null
  return (
    <button
      type="button"
      onClick={() => onEdit(product.id)}
      title="Editar producto"
      aria-label={`Editar ${product.name}`}
      className="grid size-9 shrink-0 cursor-pointer place-items-center text-ink-muted hover:bg-subtle hover:text-ink"
    >
      <Icon name="pencil" />
    </button>
  )
}

/** Abre la vista general del producto (tocar la foto o el nombre). */
function OpenButton({
  product,
  onOpen,
  className = '',
  children,
}: {
  product: CachedProduct
  onOpen?: (id: string) => void
  className?: string
  children: ReactNode
}) {
  if (!onOpen || !editable(product)) return <div className={className}>{children}</div>
  return (
    <button
      type="button"
      onClick={() => onOpen(product.id)}
      title="Ver producto"
      className={`block cursor-pointer text-left hover:opacity-85 ${className}`}
    >
      {children}
    </button>
  )
}

/** Piezas del filtro elegido; el color sale SIEMPRE del stock de tienda. */
function StockBadge({ product, scope }: { product: CachedProduct; scope: StockScope }) {
  if (!tracksStock(product)) return <span className="badge badge-neutral">Sin inventario</span>
  const st = storeStatus(product)
  const q = scopeQty(product, scope)
  const cls = st === 'out' ? 'badge-danger' : st === 'low' ? 'badge-warning' : 'badge-neutral'
  if (scope === 'store' && st === 'out') return <span className="badge badge-danger">Sin stock</span>
  return <span className={`badge ${cls}`}>{formatInt(q)} pzas</span>
}

/**
 * Nota discreta cuando la tienda está sin stock o baja: si el filtro no es
 * Tienda se aclara, y si hay piezas en bodega se avisa (para pedir un movimiento).
 */
function StoreNote({ product, scope }: { product: CachedProduct; scope: StockScope }) {
  const st = storeStatus(product)
  if (st === 'ok') return null
  const parts: string[] = []
  if (scope !== 'store') parts.push(st === 'out' ? 'Sin stock en tienda' : `Tienda: ${formatInt(product.quantity)}`)
  if ((product.warehouse_quantity ?? 0) > 0) parts.push(`Hay ${formatInt(product.warehouse_quantity)} en bodega`)
  if (!parts.length) return null
  return <p className={`text-caption ${st === 'out' ? 'text-danger-fg' : 'text-warning-fg'}`}>{parts.join(' · ')}</p>
}

function PendingBadge({ product }: { product: CachedProduct }) {
  return product.pending ? <span className="badge badge-warning">Pendiente</span> : null
}

function ProductGrid({
  products,
  scope,
  onEdit,
  onOpen,
}: {
  products: CachedProduct[]
  scope: StockScope
  onEdit?: (id: string) => void
  onOpen?: (id: string) => void
}) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
      {products.map((p) => (
        <li key={p.barcode} className="card flex flex-col overflow-hidden">
          {/* Cuadrada, con o sin foto (las fotos se guardan cuadradas): todas las tarjetas miden igual. */}
          <OpenButton product={p} onOpen={onOpen}>
            <ProductImage path={p.image_url} alt={p.name} className="aspect-square w-full border-0 border-b" />
          </OpenButton>
          <div className="flex flex-1 flex-col gap-1 p-3">
            <div className="flex items-start gap-1">
              <OpenButton product={p} onOpen={onOpen} className="flex-1">
                <p className="line-clamp-2 text-label text-ink" title={p.name}>
                  <LanguageTag language={p.language} className="mr-1.5" />
                  {p.name}
                </p>
              </OpenButton>
              <EditButton product={p} onEdit={onEdit} />
            </div>
            {p.category && <p className="truncate text-caption text-ink-subtle">{p.category}</p>}
            <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-2">
              <span className="font-display text-heading font-extrabold tabular-nums">{formatMoney(p.price)}</span>
              <StockBadge product={p} scope={scope} />
            </div>
            <StoreNote product={p} scope={scope} />
            <PendingBadge product={p} />
          </div>
        </li>
      ))}
    </ul>
  )
}

function ProductTable({
  products,
  scope,
  sort,
  onSort,
  onEdit,
  onOpen,
}: {
  products: CachedProduct[]
  scope: StockScope
  sort: { key: SortKey; dir: 1 | -1 }
  onSort: (key: SortKey) => void
  onEdit?: (id: string) => void
  onOpen?: (id: string) => void
}) {
  const th = (key: SortKey, label: string, right = false) => (
    <th
      className={`h-control-md px-4 font-medium ${right ? 'text-right' : ''}`}
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(key)}
        className={`inline-flex cursor-pointer items-center gap-1 hover:text-ink ${sort.key === key ? 'text-ink' : ''}`}
      >
        {label}
        {sort.key === key && <Icon name={sort.dir === 1 ? 'chevron-up' : 'chevron-down'} size={14} />}
      </button>
    </th>
  )

  return (
    <div className="card overflow-x-auto">
      {/* Celular: un renglón compacto por producto. */}
      <ul className="divide-y divide-line md:hidden">
        {products.map((p) => (
          <li key={p.barcode} className="flex items-start gap-3 px-4 py-3">
            <OpenButton product={p} onOpen={onOpen} className="shrink-0">
              <ProductImage path={p.image_url} alt="" className="size-12 rounded-xs" />
            </OpenButton>
            <div className="min-w-0 flex-1 space-y-0.5">
              <OpenButton product={p} onOpen={onOpen}>
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  <LanguageTag language={p.language} />
                  {p.name}
                  <PendingBadge product={p} />
                </p>
              </OpenButton>
              <p className="font-mono text-[13px] break-all text-ink-muted">{p.barcode}</p>
              {p.category && <p className="text-caption text-ink-muted">{p.category}</p>}
              <div className="flex items-baseline justify-between gap-3 pt-1">
                <span className="font-medium tabular-nums">{formatMoney(p.price)}</span>
                <div
                  className={`text-right tabular-nums ${
                    storeStatus(p) === 'out' ? 'font-medium text-danger-fg' : storeStatus(p) === 'low' ? 'font-medium text-warning-fg' : 'text-ink-muted'
                  }`}
                >
                  {tracksStock(p) ? `${formatInt(scopeQty(p, scope))} pzas` : 'Sin inventario'}
                  <StoreNote product={p} scope={scope} />
                </div>
              </div>
            </div>
            {onEdit && <EditButton product={p} onEdit={onEdit} />}
          </li>
        ))}
      </ul>
      <table className="hidden w-full border-collapse text-left md:table">
        <thead>
          <tr className="thead-row">
            <th className="h-control-md w-14 px-4 font-medium">
              <span className="sr-only">Imagen</span>
            </th>
            {th('name', 'Producto')}
            {th('barcode', 'Código')}
            {th('category', 'Categoría')}
            <th className="h-control-md px-4 font-medium">Proveedor</th>
            {th('quantity', scope === 'store' ? 'Tienda' : scope === 'warehouse' ? 'Bodega' : 'Total', true)}
            {th('price', 'Precio', true)}
            {onEdit && (
              <th className="h-control-md w-12 px-2 font-medium">
                <span className="sr-only">Editar</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.barcode} className="border-t border-line hover:bg-subtle">
              <td className="h-row px-4">
                <ProductImage path={p.image_url} alt="" className="size-10 rounded-xs" />
              </td>
              <td className="h-row px-4 font-medium">
                <OpenButton product={p} onOpen={onOpen}>
                  <span className="flex items-center gap-2">
                    <LanguageTag language={p.language} />
                    {p.name}
                    <PendingBadge product={p} />
                  </span>
                </OpenButton>
              </td>
              <td className="h-row px-4 font-mono text-[13px] whitespace-nowrap text-ink-muted">{p.barcode}</td>
              <td className="h-row px-4 whitespace-nowrap text-ink-muted">{p.category ?? '—'}</td>
              <td className="h-row px-4 whitespace-nowrap text-ink-muted">{p.supplier ?? '—'}</td>
              <td
                className={`h-row px-4 text-right tabular-nums ${
                  storeStatus(p) === 'out' ? 'font-medium text-danger-fg' : storeStatus(p) === 'low' ? 'font-medium text-warning-fg' : ''
                }`}
              >
                {tracksStock(p) ? formatInt(scopeQty(p, scope)) : 'Sin inventario'}
                <StoreNote product={p} scope={scope} />
              </td>
              <td className="h-row px-4 text-right tabular-nums">{formatMoney(p.price)}</td>
              {onEdit && (
                <td className="h-row px-2">
                  <EditButton product={p} onEdit={onEdit} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
