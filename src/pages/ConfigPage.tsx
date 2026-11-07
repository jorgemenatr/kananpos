import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Icon } from '../components/Icon'
import { MoreMenu } from '../components/MoreMenu'
import { SinglesConfig } from '../components/singles/SinglesConfig'
import { getCatalogStatus, type CatalogStatus } from '../lib/catalog'
import {
  CATALOG_SOURCES,
  SEP,
  catalogSourceLabel,
  createCategory,
  deleteCategory,
  moveCategory,
  updateCategory,
  useCategories,
  type CategoryNode,
} from '../lib/categories'
import { formatDateTime, formatInt } from '../lib/format'
import { updateBusinessName, updateOperationSettings, useSettings } from '../lib/settings'
import { isNetworkError } from '../lib/supabase'
import { inventoryStore } from '../store/inventoryStore'
import { useInventory } from '../store/useInventory'

const errorText = (e: unknown) =>
  isNetworkError(e) ? 'Sin conexión: intenta cuando vuelva el internet.' : (e as Error).message

type Editing = { category: CategoryNode | null; parentId: string | null }

/** Configuración del negocio (solo administradores): nombre, categorías, catálogo TCG y singles. */
export function ConfigPage() {
  const { tree } = useCategories()
  const { products } = useInventory()
  const [editing, setEditing] = useState<Editing | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  // Productos por valor de categoría (para avisar antes de borrar).
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of Object.values(products)) if (p.category) m.set(p.category, (m.get(p.category) ?? 0) + 1)
    return m
  }, [products])

  async function act(fn: () => Promise<void>, ok: string) {
    if (busy) return
    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      await fn()
      setSaved(ok)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  function onDelete(c: CategoryNode) {
    const n = counts.get(c.value) ?? 0
    if (n > 0) {
      setSaved(null)
      setError(`"${c.value}" tiene ${formatInt(n)} producto(s). Cámbialos de categoría antes de borrarla.`)
      return
    }
    if (!window.confirm(`¿Borrar la categoría "${c.value}"?`)) return
    void act(() => deleteCategory(c.id), `Se borró "${c.value}".`)
  }

  const linked = new Set(tree.flatMap((c) => [c, ...c.children]).flatMap((c) => c.catalog_sources))

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <h1 className="hidden text-title-lg uppercase md:block">Configuración</h1>

      <BusinessCard />
      <InitialLoadCard />
      <OperationCard />

      {saved && (
        <p className="notice bg-success-bg text-success-fg" role="status">
          <Icon name="check" className="mt-0.5" />
          {saved}
        </p>
      )}
      {error && (
        <p className="notice bg-danger-bg text-danger-fg">
          <Icon name="alert" className="mt-0.5" />
          {error}
        </p>
      )}

      <section className="card flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto">
            <h2 className="text-title">Categorías</h2>
            <p className="text-caption text-ink-muted">
              Las que aparecen al dar de alta un producto y en los filtros del inventario. Cada una puede tener
              subcategorías (p. ej. TCG → Pokémon, Magic).
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEditing({ category: null, parentId: null })}
            className="btn btn-primary"
            disabled={busy}
          >
            <Icon name="plus" />
            Nueva categoría
          </button>
        </div>

        {!tree.length && (
          <p className="py-6 text-center text-ink-subtle">Todavía no hay categorías. Agrega la primera.</p>
        )}

        <ul className="flex flex-col divide-y divide-line">
          {tree.map((c, i) => (
            <li key={c.id} className="py-2">
              <CategoryRow
                category={c}
                count={counts.get(c.value) ?? 0}
                first={i === 0}
                last={i === tree.length - 1}
                busy={busy}
                onMove={(dir) => void act(() => moveCategory(c.id, dir), 'Se cambió el orden.')}
                onEdit={() => setEditing({ category: c, parentId: null })}
                onDelete={() => onDelete(c)}
                onAddChild={() => setEditing({ category: null, parentId: c.id })}
              />
              {c.children.length > 0 && (
                <ul className="mt-1 ml-6 flex flex-col border-l-2 border-line pl-3">
                  {c.children.map((s, j) => (
                    <li key={s.id} className="py-1">
                      <CategoryRow
                        category={s}
                        count={counts.get(s.value) ?? 0}
                        first={j === 0}
                        last={j === c.children.length - 1}
                        busy={busy}
                        onMove={(dir) => void act(() => moveCategory(s.id, dir), 'Se cambió el orden.')}
                        onEdit={() => setEditing({ category: s, parentId: c.id })}
                        onDelete={() => onDelete(s)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>

      <CatalogCard linked={[...linked]} />

      <SinglesConfig />

      {editing && (
        <CategoryModal
          editing={editing}
          onCancel={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null)
            setError(null)
            setSaved(msg)
            // Al renombrar, los productos cambian de categoría en la base.
            void inventoryStore.refreshProducts()
          }}
        />
      )}
    </div>
  )
}

function BusinessCard() {
  const settings = useSettings()
  const [name, setName] = useState(settings.businessName)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => setName(settings.businessName), [settings.businessName])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (saving || !name.trim()) return
    setSaving(true)
    setMsg(null)
    try {
      await updateBusinessName(name)
      setMsg({ ok: true, text: 'Se guardó el nombre.' })
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="card flex flex-col gap-3 p-4">
      <h2 className="text-title">Negocio</h2>
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-sm">
          <label className="field-label" htmlFor="cfg-name">Nombre</label>
          <input id="cfg-name" className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </div>
        <button
          type="submit"
          className="btn btn-secondary"
          disabled={saving || !name.trim() || name.trim() === settings.businessName}
        >
          <Icon name="check" />
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </form>
      <p className="text-caption text-ink-muted">
        Códigos internos: <span className="font-mono text-ink">{settings.codePrefix}-000001</span>. El prefijo se fija al
        dar de alta el negocio y ya no cambia (va impreso en las etiquetas).
      </p>
      {msg && (
        <p className={`notice ${msg.ok ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg'}`} role="status">
          <Icon name={msg.ok ? 'check' : 'alert'} className="mt-0.5" />
          {msg.text}
        </p>
      )}
    </section>
  )
}

/** Día de operación (hora de corte) y preventas. */
/**
 * Inventario inicial: mientras está abierto se ve su sección (primer conteo,
 * por partes). Cuando el cliente avisa que terminó, el admin lo cierra.
 */
function InitialLoadCard() {
  const settings = useSettings()
  const open = settings.initialLoadOpen
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function toggle() {
    const ask = open
      ? '¿Cerrar el inventario inicial?\n\nSe esconde la sección Inventario inicial. Desde ahí, la mercancía nueva entra solo por Compras y las correcciones por Conteo y ajustes (con motivo).'
      : '¿Volver a abrir el inventario inicial?\n\nReaparece la sección para escanear y dar de alta productos con cantidad sin registrar una compra.'
    if (!window.confirm(ask)) return
    setSaving(true)
    setMsg(null)
    try {
      await updateOperationSettings({ initialLoadOpen: !open })
      setMsg({ ok: true, text: open ? 'Se cerró el inventario inicial.' : 'Se volvió a abrir el inventario inicial.' })
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="card flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto max-w-2xl">
          <h2 className="flex flex-wrap items-center gap-2 text-title">
            Inventario inicial
            <span className={`badge ${open ? 'badge-warning' : 'badge-neutral'}`}>{open ? 'Abierto' : 'Cerrado'}</span>
          </h2>
          <p className="text-caption text-ink-muted">
            {open
              ? 'La sección Inventario inicial sirve para el primer conteo del negocio y se puede hacer por partes. Ciérralo cuando avisen que ya terminaron: la mercancía nueva entrará solo por Compras y las correcciones por Conteo y ajustes.'
              : 'Ya terminó el primer conteo: la mercancía nueva entra por Compras y las correcciones por Conteo y ajustes, siempre con motivo. Ábrelo de nuevo solo si hace falta otra carga inicial.'}
          </p>
        </div>
        <button type="button" onClick={() => void toggle()} disabled={saving} className={`btn ${open ? 'btn-primary' : 'btn-secondary'}`}>
          {saving ? 'Guardando…' : open ? 'Cerrar inventario inicial' : 'Volver a abrir'}
        </button>
      </div>
      {msg && <p className={`text-caption ${msg.ok ? 'text-success-fg' : 'text-danger-fg'}`}>{msg.text}</p>}
    </section>
  )
}

function OperationCard() {
  const settings = useSettings()
  const { tree } = useCategories()
  const categoryValues = tree.flatMap((c) => [c.value, ...c.children.map((s) => s.value)])
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function save(patch: Parameters<typeof updateOperationSettings>[0], ok: string) {
    setSaving(true)
    setMsg(null)
    try {
      await updateOperationSettings(patch)
      setMsg({ ok: true, text: ok })
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) })
    } finally {
      setSaving(false)
    }
  }

  const hour = (h: number) => `${String(h).padStart(2, '0')}:00`

  return (
    <section className="card flex flex-col gap-3 p-4">
      <h2 className="text-title">Operación</h2>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="field-label" htmlFor="cfg-cutoff">
            El día termina a las
          </label>
          <select
            id="cfg-cutoff"
            className="field cursor-pointer"
            value={settings.dayCutoffHour}
            disabled={saving}
            onChange={(e) => void save({ dayCutoffHour: Number(e.target.value) }, `El día de operación ahora termina a las ${hour(Number(e.target.value))}.`)}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {hour(h)}
                {h === 0 ? ' (medianoche)' : ''}
              </option>
            ))}
          </select>
        </div>
        <p className="max-w-xl text-caption text-ink-muted">
          {settings.dayCutoffHour === 0
            ? 'El día termina a medianoche.'
            : `Las ventas entre las 00:00 y las ${String(settings.dayCutoffHour - 1).padStart(2, '0')}:59 cuentan para el día anterior en ventas, cortes y filtros por fecha.`}{' '}
          Zona horaria: {settings.timezone}.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="field-label" htmlFor="cfg-combo-drinks">
            Bebidas de los combos
          </label>
          <select
            id="cfg-combo-drinks"
            className="field cursor-pointer"
            value={settings.comboDrinksCategory ?? ''}
            disabled={saving}
            onChange={(e) =>
              void save(
                { comboDrinksCategory: e.target.value || null },
                e.target.value ? `Los combos ahora ofrecen las bebidas de ${e.target.value}.` : 'Los combos ya no ofrecen bebidas.',
              )
            }
          >
            <option value="">Sin grupo de bebidas</option>
            {categoryValues.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <p className="max-w-xl text-caption text-ink-muted">
          Al vender un producto marcado como combo se elige una bebida de esta categoría. Va a $0 y descuenta su propio inventario. La
          lista se cambia moviendo productos a esta categoría.
        </p>
      </div>
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="mt-1"
          checked={settings.preorderCreditPayments}
          disabled={saving}
          onChange={(e) =>
            void save(
              { preorderCreditPayments: e.target.checked },
              e.target.checked ? 'Se aceptan créditos en abonos de preventa.' : 'Ya no se aceptan créditos en abonos de preventa.',
            )
          }
        />
        <span>
          <span className="text-label text-ink">Aceptar créditos de tienda en abonos de preventa</span>
          <span className="block text-caption text-ink-muted">Si lo apagas, los anticipos y abonos solo se pagan con efectivo, tarjeta o transferencia.</span>
        </span>
      </label>
      {msg && (
        <p className={`notice ${msg.ok ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg'}`} role="status">
          <Icon name={msg.ok ? 'check' : 'alert'} className="mt-0.5" />
          {msg.text}
        </p>
      )}
    </section>
  )
}

function CategoryRow({
  category,
  count,
  first,
  last,
  busy,
  onMove,
  onEdit,
  onDelete,
  onAddChild,
}: {
  category: CategoryNode
  count: number
  first: boolean
  last: boolean
  busy: boolean
  onMove: (dir: -1 | 1) => void
  onEdit: () => void
  onDelete: () => void
  /** Solo en categorías principales. */
  onAddChild?: () => void
}) {
  const iconBtn =
    'grid size-control-md cursor-pointer place-items-center text-ink-muted hover:bg-subtle hover:text-ink disabled:cursor-default disabled:opacity-40'
  // Subir y bajar a la vista; el resto en el menú ⋯.
  return (
    <div className="flex items-center gap-1 md:flex-wrap md:gap-2">
      <div className="min-w-0 flex-1">
        <p className={category.parent_id ? '' : 'text-label'}>
          {category.name}
          {count > 0 && <span className="ml-2 text-caption text-ink-subtle">{formatInt(count)} productos</span>}
        </p>
        {category.catalog_sources.length > 0 && (
          <p className="text-caption text-ink-muted">
            Catálogo: {category.catalog_sources.map(catalogSourceLabel).join(', ')}
          </p>
        )}
      </div>
      <button type="button" className={iconBtn} disabled={busy || first} onClick={() => onMove(-1)} title="Subir" aria-label={`Subir ${category.name}`}>
        <Icon name="arrow-up" />
      </button>
      <button type="button" className={iconBtn} disabled={busy || last} onClick={() => onMove(1)} title="Bajar" aria-label={`Bajar ${category.name}`}>
        <Icon name="arrow-down" />
      </button>
      <MoreMenu
        variant="ghost"
        disabled={busy}
        items={[
          ...(onAddChild ? [{ label: 'Agregar subcategoría', icon: 'plus' as const, onClick: onAddChild }] : []),
          { label: 'Editar', icon: 'pencil', onClick: onEdit },
          { label: 'Borrar', icon: 'trash', onClick: onDelete },
        ]}
      />
    </div>
  )
}

function CategoryModal({
  editing,
  onCancel,
  onSaved,
}: {
  editing: Editing
  onCancel: () => void
  onSaved: (message: string) => void
}) {
  const { tree } = useCategories()
  const current = editing.category
  const [name, setName] = useState(current?.name ?? '')
  const [parentId, setParentId] = useState<string | null>(editing.parentId)
  const [sources, setSources] = useState<string[]>(current?.catalog_sources ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fuentes ya ligadas a otra categoría (cada una sugiere una sola).
  const takenBy = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of tree.flatMap((t) => [t, ...t.children])) {
      if (c.id === current?.id) continue
      for (const s of c.catalog_sources) m.set(s, c.value)
    }
    return m
  }, [tree, current?.id])

  // Una principal con subcategorías no puede volverse subcategoría.
  const canMove = !current || !tree.find((t) => t.id === current.id)?.children.length
  const parents = tree.filter((t) => t.id !== current?.id)

  const toggle = (key: string) => setSources((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]))

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (saving) return
    const clean = name.trim()
    if (!clean) return setError('El nombre es obligatorio.')
    if (clean.includes(SEP.trim())) return setError(`El nombre no puede llevar "${SEP.trim()}".`)
    setSaving(true)
    setError(null)
    try {
      if (current) {
        await updateCategory(current.id, { name: clean, parent_id: parentId, catalog_sources: sources })
        onSaved(`Se guardó "${clean}".`)
      } else {
        await createCategory({ name: clean, parent_id: parentId, catalog_sources: sources })
        onSaved(`Se agregó "${clean}".`)
      }
    } catch (err) {
      setError(errorText(err))
      setSaving(false)
    }
  }

  const renamed = current && current.name !== name.trim()

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4" role="dialog" aria-modal="true" aria-labelledby="cf-title">
      <form
        noValidate
        onSubmit={onSubmit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        className="max-h-full w-full max-w-xl overflow-auto dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <h2 id="cf-title" className="text-title">
            {current ? 'Editar categoría' : parentId ? 'Subcategoría nueva' : 'Categoría nueva'}
          </h2>
          <button type="button" onClick={onCancel} className="btn btn-ghost">
            <Icon name="x" />
            Cancelar<span className="hidden md:inline"> (Esc)</span>
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div>
            <label className="field-label" htmlFor="cf-name">Nombre *</label>
            <input
              id="cf-name"
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              autoFocus
              autoComplete="off"
            />
            {renamed && (
              <p className="mt-1 text-caption text-ink-subtle">Los productos de esta categoría se cambian al nombre nuevo.</p>
            )}
          </div>

          {canMove && (
            <div>
              <label className="field-label" htmlFor="cf-parent">Dentro de</label>
              <select
                id="cf-parent"
                className="field cursor-pointer"
                value={parentId ?? ''}
                onChange={(e) => setParentId(e.target.value || null)}
              >
                <option value="">Ninguna (categoría principal)</option>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <fieldset>
            <legend className="field-label">Productos del catálogo TCGplayer</legend>
            <p className="mb-2 text-caption text-ink-muted">
              Marca los juegos o marcas que vendes en esta categoría: solo esos se cargan en el catálogo y, al vincular uno,
              el producto queda en esta categoría.
            </p>
            {(['juego', 'accesorio'] as const).map((kind) => (
              <div key={kind} className="mb-3">
                <p className="mb-1 text-caption font-medium text-ink-muted">{kind === 'juego' ? 'Juegos' : 'Accesorios'}</p>
                <div className="grid gap-1 sm:grid-cols-2">
                  {CATALOG_SOURCES.filter((s) => s.kind === kind).map((s) => {
                    const other = takenBy.get(s.key)
                    return (
                      <label
                        key={s.key}
                        className={`flex items-start gap-2 rounded-md px-2 py-1 ${other ? 'text-ink-subtle' : 'cursor-pointer hover:bg-subtle'}`}
                      >
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={sources.includes(s.key)}
                          disabled={!!other}
                          onChange={() => toggle(s.key)}
                        />
                        <span>
                          {s.label}
                          {other && <span className="block text-caption">En {other}</span>}
                        </span>
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
          </fieldset>

          {error && (
            <p className="notice bg-danger-bg text-danger-fg">
              <Icon name="alert" className="mt-0.5" />
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-line bg-subtle px-6 py-4">
          <button type="submit" disabled={saving} className="btn btn-primary btn-lg w-full sm:w-auto">
            <Icon name="check" size={20} />
            {saving ? 'Guardando…' : current ? 'Guardar cambios' : 'Agregar'}
          </button>
        </div>
      </form>
    </div>
  )
}

function CatalogCard({ linked }: { linked: string[] }) {
  const [status, setStatus] = useState<CatalogStatus | null>(null)
  useEffect(() => {
    void getCatalogStatus().then(setStatus)
  }, [])

  return (
    <section className="card flex flex-col gap-2 p-4">
      <h2 className="text-title">Catálogo TCGplayer</h2>
      {linked.length ? (
        <p>
          Se cargan: <span className="text-ink">{linked.map(catalogSourceLabel).join(', ')}</span>.
        </p>
      ) : (
        <p className="text-ink-muted">
          Ninguna categoría tiene juegos del catálogo: el catálogo no se carga y las altas se capturan a mano.
        </p>
      )}
      {status && (
        <p className="text-caption text-ink-muted">
          {formatInt(status.products)} productos en el catálogo
          {status.imported_at && ` · actualizado ${formatDateTime(status.imported_at)}`}.
        </p>
      )}
      <p className="text-caption text-ink-muted">
        El catálogo se actualiza solo cada lunes. Si acabas de agregar un juego, sus productos aparecen después de la
        siguiente actualización (o pide que se corra a mano).
      </p>
    </section>
  )
}
