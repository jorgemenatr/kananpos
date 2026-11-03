import { useEffect, useState } from 'react'
import { cachedSuppliers, createSupplier, listSuppliers, saveSuppliersCache } from '../lib/lots'
import { isNetworkError } from '../lib/supabase'
import type { Supplier } from '../lib/types'

// Se cargan una vez por sesión de la app; crear uno lo agrega a la lista.
// Sin conexión se usa la última copia guardada (para capturar compras).
let cache: Promise<Supplier[]> | null = null
const load = () =>
  (cache ??= listSuppliers().catch((e) => {
    cache = null
    const saved = isNetworkError(e) ? cachedSuppliers() : null
    return saved ?? Promise.reject(e)
  }))

const NEW = '__new__'

/**
 * Proveedor (catálogo de proveedores). Permite crear uno nuevo ahí mismo.
 * noneLabel: si se da, se puede dejar sin proveedor (value = null) con ese texto.
 */
export function SupplierSelect({
  id,
  value,
  onChange,
  noneLabel,
  disabled,
}: {
  id: string
  value: string | null
  onChange: (id: string | null, supplier: Supplier | null) => void
  noneLabel?: string
  disabled?: boolean
}) {
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    load()
      .then(setSuppliers)
      .catch((e) => setError(isNetworkError(e) ? 'Sin conexión: no se pudieron cargar los proveedores.' : (e as Error).message))
  }, [])

  async function add() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const s = await createSupplier(name)
      const list = [...(suppliers ?? []).filter((x) => x.id !== s.id), s].sort((a, b) => a.name.localeCompare(b.name, 'es-MX'))
      cache = Promise.resolve(list)
      saveSuppliersCache(list)
      setSuppliers(list)
      onChange(s.id, s)
      setAdding(false)
      setName('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (adding) {
    return (
      <div>
        <div
          className="flex gap-2"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void add()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setAdding(false)
            }
          }}
        >
          <input
            id={id}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nombre del proveedor nuevo"
            autoFocus
            autoComplete="off"
            className="field min-w-0 flex-1"
          />
          <button type="button" onClick={() => void add()} disabled={busy || !name.trim()} className="btn btn-primary">
            {busy ? 'Guardando…' : 'Agregar'}
          </button>
          <button type="button" onClick={() => setAdding(false)} className="btn btn-ghost">
            Cancelar
          </button>
        </div>
        {error && <p className="mt-1 text-caption text-danger-fg">{error}</p>}
      </div>
    )
  }

  return (
    <div>
      <select
        id={id}
        value={value ?? ''}
        disabled={disabled || suppliers === null}
        onChange={(e) => {
          if (e.target.value === NEW) return setAdding(true)
          const s = suppliers?.find((x) => x.id === e.target.value) ?? null
          onChange(s?.id ?? null, s)
        }}
        className="field w-full cursor-pointer"
      >
        {suppliers === null && <option value="">Cargando proveedores…</option>}
        {suppliers !== null && (noneLabel ? <option value="">{noneLabel}</option> : <option value="" disabled>Elige el proveedor</option>)}
        {suppliers?.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        {suppliers !== null && <option value={NEW}>+ Proveedor nuevo…</option>}
      </select>
      {error && <p className="mt-1 text-caption text-danger-fg">{error}</p>}
    </div>
  )
}
