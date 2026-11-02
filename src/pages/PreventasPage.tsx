import { useCallback, useEffect, useMemo, useState } from 'react'
import { nameWithLanguage } from '../components/LanguageTag'
import { Link, useSearchParams } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { PreorderPanel } from '../components/pos/PreorderPanel'
import { formatDateTime, formatInt, formatMoney } from '../lib/format'
import { getPreorderItems, listPreorders, saleTitle } from '../lib/sales'
import { isNetworkError } from '../lib/supabase'
import type { SaleRow, TicketItemRow } from '../lib/types'
import { inventoryStore, type CachedProduct } from '../store/inventoryStore'
import { useInventory } from '../store/useInventory'

type Filter = 'all' | 'owing' | 'paid' | 'ready'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Todas' },
  { value: 'owing', label: 'Con saldo' },
  { value: 'paid', label: 'Saldadas' },
  { value: 'ready', label: 'Listas para entregar' },
]

const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

/**
 * Preventas sin entregar: abonos, entrega y cancelación fuera del mostrador.
 * Se registran en el mostrador al cobrar un ticket con productos de preventa.
 */
export function PreventasPage() {
  const { products, online } = useInventory()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedId = searchParams.get('id')
  const [preorders, setPreorders] = useState<SaleRow[] | null>(null)
  const [items, setItems] = useState<Record<string, TicketItemRow[]>>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const productsById = useMemo(() => {
    const byId: Record<string, CachedProduct> = {}
    for (const p of Object.values(products)) byId[p.id] = p
    return byId
  }, [products])

  const load = useCallback(async () => {
    try {
      const list = await listPreorders()
      const rows = await getPreorderItems(list.map((s) => s.id))
      const byTicket: Record<string, TicketItemRow[]> = {}
      for (const r of rows) (byTicket[r.ticket_id] ??= []).push(r)
      setPreorders(list)
      setItems(byTicket)
      setError(null)
    } catch (e) {
      setError(isNetworkError(e) ? 'Sin conexión: las preventas se consultan con internet.' : (e as Error).message)
    }
  }, [])

  // Al entrar: preventas y stock al día (para saber cuáles ya se pueden entregar).
  useEffect(() => {
    void load()
    if (online) void inventoryStore.refreshProducts()
    // Solo al entrar a la página.
  }, [])

  /** Todas sus piezas de preventa ya están en tienda. */
  const inStore = useCallback(
    (id: string) => (items[id] ?? []).filter((i) => i.preorder).every((i) => (productsById[i.product_id]?.quantity ?? 0) >= i.quantity),
    [items, productsById],
  )

  const visible = useMemo(() => {
    const words = normalize(search.trim()).split(/\s+/).filter(Boolean)
    return (preorders ?? []).filter((s) => {
      if (filter === 'owing' && s.balance <= 0) return false
      if (filter === 'paid' && s.balance > 0) return false
      if (filter === 'ready' && (s.balance > 0 || !inStore(s.id))) return false
      const text = normalize(`${s.number} ${s.customer_name ?? ''} ${(items[s.id] ?? []).map((i) => i.product_name).join(' ')}`)
      return words.every((w) => text.includes(w))
    })
  }, [preorders, items, search, filter, inStore])

  const owed = (preorders ?? []).reduce((sum, s) => sum + s.balance, 0)

  function select(id: string | null) {
    setNotice(null)
    setSearchParams(id ? { id } : {}, { replace: !!selectedId })
  }

  return (
    <div className="flex min-h-full flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="hidden text-title-lg uppercase md:block">Preventas</h1>
          <p className="text-caption text-ink-subtle">
            Las preventas nuevas se registran en el mostrador: al cobrar un ticket con productos de preventa, el primer abono la crea.
          </p>
        </div>
        <Link to="/mostrador" className="btn btn-secondary">
          <Icon name="store" />
          Ir al mostrador
        </Link>
      </div>

      {preorders && (
        <div className="grid grid-cols-2 gap-3 md:max-w-xl">
          <div className="card p-4">
            <p className="stat-label text-ink-muted">Pendientes</p>
            <p className="font-display text-heading font-extrabold tabular-nums">{formatInt(preorders.length)}</p>
          </div>
          <div className="card p-4">
            <p className="stat-label text-ink-muted">Saldo por cobrar</p>
            <p className="font-display text-heading font-extrabold tabular-nums">{formatMoney(owed)}</p>
          </div>
        </div>
      )}

      {notice && (
        <p className="notice bg-success-bg text-success-fg" role="status">
          <Icon name="check" className="mt-0.5" />
          {notice}
        </p>
      )}
      {error && (
        <p className="notice bg-danger-bg text-danger-fg">
          <Icon name="alert" className="mt-0.5" />
          {error}
        </p>
      )}

      <div className="grid flex-1 items-start gap-4 lg:grid-cols-[340px_1fr]">
        <aside className={`card flex flex-col ${selectedId ? 'max-lg:hidden' : ''}`}>
          <div className="flex flex-col gap-3 border-b border-line p-3">
            <label className="search-field w-full">
              <Icon name="search" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Folio, cliente o producto"
                aria-label="Buscar por folio, cliente o producto"
                className="min-w-0 flex-1 bg-transparent text-ink outline-none focus-visible:outline-none"
              />
            </label>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar preventas">
              {FILTERS.map((f) => (
                <button key={f.value} type="button" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)} className="choice px-3 py-1 text-caption">
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          {preorders === null && !error && <p className="px-4 py-6 text-center text-ink-subtle">Cargando preventas…</p>}
          {preorders && visible.length === 0 && (
            <p className="px-4 py-6 text-center text-ink-subtle">
              {preorders.length === 0 ? 'No hay preventas pendientes.' : 'Ninguna preventa coincide.'}
            </p>
          )}
          <ul className="divide-y divide-line">
            {visible.map((s) => {
              const current = s.id === selectedId
              const ready = s.balance <= 0 && inStore(s.id)
              const names = (items[s.id] ?? []).filter((i) => i.preorder).map((i) => `${nameWithLanguage(i.product_name, i.language)}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`)
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => select(s.id)}
                    aria-current={current}
                    className={`flex w-full cursor-pointer flex-col gap-1 px-4 py-3 text-left ${current ? 'bg-brand text-on-brand' : 'hover:bg-subtle'}`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-label">{saleTitle(s)}</span>
                      {ready && <span className="badge badge-success shrink-0">Lista</span>}
                    </span>
                    {names.length > 0 && <span className={`truncate text-caption ${current ? '' : 'text-ink-muted'}`}>{names.join(', ')}</span>}
                    <span className={`flex justify-between text-caption ${current ? '' : 'text-ink-subtle'}`}>
                      <span>{formatDateTime(s.created_at)}</span>
                      <span className="tabular-nums">{s.balance > 0 ? `Debe ${formatMoney(s.balance)}` : 'Saldada'}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </aside>

        {selectedId ? (
          <div className="flex min-w-0 flex-col gap-3">
            <button type="button" onClick={() => select(null)} className="btn btn-ghost btn-sm self-start lg:hidden">
              ← Todas las preventas
            </button>
            <PreorderPanel
              key={selectedId}
              ticketId={selectedId}
              productsById={productsById}
              online={online}
              onChanged={(message, closed) => {
                void load()
                if (message) setNotice(message)
                if (closed) setSearchParams({}, { replace: true })
              }}
            />
          </div>
        ) : (
          <section className="card flex min-h-60 flex-col items-center justify-center gap-2 p-8 text-center max-lg:hidden">
            <Icon name="box" size={40} className="text-ink-subtle" />
            <p className="text-title text-ink">Elige una preventa</p>
            <p className="text-ink-subtle">Para registrar abonos, entregarla o cancelarla.</p>
          </section>
        )}
      </div>
    </div>
  )
}
