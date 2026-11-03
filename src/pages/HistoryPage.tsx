import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { LanguageTag, useLanguageLookup } from '../components/LanguageTag'
import { useAuth } from '../auth/useAuth'
import { internalCodeLabel } from '../lib/barcode'
import { buildMovementRows, exportCsv, exportXlsx } from '../lib/export'
import { formatDateTime, formatInt } from '../lib/format'
import { cancelMovement } from '../lib/products'
import { exportName } from '../lib/settings'
import { isNetworkError, supabase } from '../lib/supabase'
import { Icon } from '../components/Icon'
import { LotPicker } from '../components/LotPicker'
import { MoreMenu } from '../components/MoreMenu'
import { needsLotChoice } from '../lib/lots'
import { LOCATION_LABELS, MOVEMENT_LABELS, type LotPick, type MovementHistoryRow, type Product } from '../lib/types'
import { inventoryStore, type QueueItem } from '../store/inventoryStore'
import { useInventory } from '../store/useInventory'

const PAGE = 100

/** Movimientos que se pueden cancelar (las ventas y los desvinculados no). */
const cancellable = (m: MovementHistoryRow) =>
  ['initial_count', 'scan_add', 'set_total', 'adjustment'].includes(m.type) && !m.reverts_movement_id && !m.cancelled_by_movement_id

function describeQueueItem(item: QueueItem) {
  switch (item.kind) {
    case 'create':
      return `Alta: ${item.input.name} (${item.input.barcode ?? internalCodeLabel()})`
    case 'scan':
      return `${item.ctx?.reason ? 'Conteo' : 'Escaneo'} ${item.barcode} (${item.mode === 'add' ? '+' : '='}${item.quantity})${item.ctx?.location === 'warehouse' ? ' en bodega' : ''}${item.ctx?.reason ? ` · ${item.ctx.reason}` : ''}`
    case 'purchase':
      return `Compra a ${item.purchase.supplierName} (${item.purchase.items.reduce((n, i) => n + i.quantity, 0)} pzas)${item.purchase.location === 'warehouse' ? ' en bodega' : ''}`
    case 'sale':
      return `Venta sin folio aún (${item.sale.customerName ?? 'sin cliente'}, ${item.sale.items.reduce((n, i) => n + i.quantity, 0)} pzas)`
    default:
      return `Deshacer ${item.barcode}`
  }
}

export function HistoryPage() {
  const { queue, failed, online } = useInventory()
  const languages = useLanguageLookup()
  const [rows, setRows] = useState<MovementHistoryRow[]>([])
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [cancelling, setCancelling] = useState<MovementHistoryRow | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const load = useCallback(async (offset: number, search: string) => {
    setLoading(true)
    setError(null)
    let query = supabase
      .from('movement_history')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE - 1)
    const s = search.trim().replace(/[%,()]/g, '')
    if (s) query = query.or(`barcode.ilike.%${s}%,product_name.ilike.%${s}%,old_barcode.ilike.%${s}%`)
    const { data, error } = await query
    setLoading(false)
    if (error) {
      setError(isNetworkError(error) ? 'Sin conexión: no se puede cargar el historial.' : error.message)
      return
    }
    const page = (data ?? []) as MovementHistoryRow[]
    setRows((prev) => (offset === 0 ? page : [...prev, ...page]))
    setHasMore(page.length === PAGE)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void load(0, filter), 300)
    return () => clearTimeout(t)
  }, [filter, load])

  async function doExport(kind: 'csv' | 'xlsx') {
    setExporting(true)
    try {
      const data = await buildMovementRows()
      if (kind === 'csv') exportCsv(data, exportName('movimientos'))
      else await exportXlsx(data, exportName('movimientos'), 'Movimientos')
    } catch (e) {
      setError(`No se pudo exportar: ${(e as Error).message}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3 max-md:hidden">
        <h1 className="mr-auto text-title uppercase md:text-title-lg">Historial de movimientos</h1>
      </div>

      {(queue.length > 0 || failed.length > 0) && (
        <section className="card p-5">
          <h2 className="text-title">Operaciones locales</h2>
          {queue.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span className="badge badge-warning">
                {queue.length} pendiente(s) por sincronizar{online ? '' : ' (sin conexión)'}
              </span>
              <button type="button" onClick={() => void inventoryStore.checkConnection()} className="btn btn-secondary btn-sm">
                <Icon name="refresh" />
                Reintentar ahora
              </button>
            </div>
          )}
          {failed.length > 0 && (
            <div className="mt-4">
              <p className="text-ink-muted">
                Operaciones que el servidor rechazó. Revísalas y corrige a mano si hace falta.
              </p>
              <ul className="mt-3 divide-y divide-line overflow-hidden rounded-md border border-line">
                {failed.map((f, i) => (
                  <li key={f.item.opId} className="flex items-center gap-3 px-4 py-3">
                    <span className="badge badge-danger">Rechazada</span>
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-ink">
                        {describeQueueItem(f.item)}
                      </p>
                      <p className="text-danger-fg">{f.error}</p>
                      <p className="text-caption text-ink-subtle">{formatDateTime(f.item.createdAt)}</p>
                    </div>
                    <button type="button" onClick={() => inventoryStore.dismissFailed(i)} className="btn btn-ghost btn-sm">
                      Descartar
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <div className="flex items-center gap-3">
        <label className="search-field w-full max-w-sm min-w-0">
          <Icon name="search" />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Buscar por código o nombre"
            aria-label="Buscar por código o nombre"
            className="min-w-0 flex-1 bg-transparent text-ink outline-none focus-visible:outline-none"
          />
        </label>
        {online && !exporting && (
          <MoreMenu
            items={[
              { label: 'Exportar CSV', icon: 'download', onClick: () => void doExport('csv') },
              { label: 'Exportar Excel', icon: 'download', onClick: () => void doExport('xlsx') },
            ]}
          />
        )}
      </div>

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

      <div className="card overflow-x-auto">
        {/* Celular: una tarjeta por movimiento. */}
        <ul className="divide-y divide-line md:hidden">
          {rows.map((m) => (
            <li key={m.id} className={`space-y-1.5 px-4 py-3 ${m.cancelled_by_movement_id ? 'text-ink-subtle' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 font-medium">
                  <LanguageTag language={languages.get(m.product_id)} className="mr-1.5" />
                  {m.product_name}
                </p>
                <span className={`shrink-0 font-medium tabular-nums ${deltaClass(m)}`}>
                  {m.delta > 0 ? '+' : ''}
                  {formatInt(m.delta)}
                </span>
              </div>
              <p className="font-mono text-[13px] break-all text-ink-muted">{m.barcode}</p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
                <span>{MOVEMENT_LABELS[m.type] ?? m.type}</span>
                {m.location === 'warehouse' ? <span className="badge badge-warning">Bodega</span> : <span className="text-ink-muted">· {LOCATION_LABELS.store}</span>}
                <span className="text-ink-muted">· queda {formatInt(m.quantity_after)}</span>
                {m.lot_numbers && <span className="text-ink-subtle">· Lote {m.lot_numbers}</span>}
                {m.reverts_movement_id && <span className="badge badge-info">Cancelación</span>}
                {m.cancelled_by_movement_id && <span className="badge badge-danger">Cancelado</span>}
              </div>
              {(m.note || m.cancelled_by_movement_id) && (
                <p className="text-caption text-ink-muted">
                  {m.note}
                  {m.cancelled_by_movement_id && (
                    <span className="block text-danger-fg">
                      Cancelado{m.cancelled_by_name ? ` por ${m.cancelled_by_name}` : ''}
                      {m.cancelled_at ? ` el ${formatDateTime(m.cancelled_at)}` : ''}
                    </span>
                  )}
                </p>
              )}
              <div className="flex items-center justify-between gap-3">
                <span className="text-caption text-ink-muted">
                  {formatDateTime(m.created_at)} · {m.created_by_name || m.created_by_email || '—'}
                </span>
                {isAdmin && cancellable(m) && (
                  <button
                    type="button"
                    onClick={() => {
                      setSaved(null)
                      setCancelling(m)
                    }}
                    className="btn btn-ghost btn-sm shrink-0"
                  >
                    <Icon name="undo" />
                    Cancelar
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        <table className="hidden w-full border-collapse text-left text-[14px] leading-5 md:table">
          <thead>
            <tr className="thead-row">
              <th className="h-control-md px-3 font-medium">Fecha</th>
              <th className="h-control-md px-3 font-medium">Código</th>
              <th className="h-control-md px-3 font-medium">Producto</th>
              <th className="h-control-md px-3 font-medium">Tipo</th>
              <th className="h-control-md px-3 font-medium">Ubicación</th>
              <th className="h-control-md px-3 text-right font-medium">Cambio</th>
              <th className="h-control-md px-3 text-right font-medium">Queda ahí</th>
              <th className="h-control-md px-3 font-medium">Usuario</th>
              <th className="h-control-md px-3 font-medium">Nota</th>
              {isAdmin && (
                <th className="h-control-md px-3 font-medium">
                  <span className="sr-only">Acciones</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} className={`border-t border-line hover:bg-subtle ${m.cancelled_by_movement_id ? 'text-ink-subtle' : ''}`}>
                <td className="h-row px-3 whitespace-nowrap text-ink-muted">{formatDateTime(m.created_at)}</td>
                <td className="h-row px-3 font-mono text-[13px] text-ink-muted">{m.barcode}</td>
                <td className="h-row min-w-56 px-3 font-medium">
                  <LanguageTag language={languages.get(m.product_id)} className="mr-1.5" />
                  {m.product_name}
                </td>
                <td className="h-row px-3 whitespace-nowrap">
                  <span className="flex flex-col items-start gap-1 py-1">
                    {MOVEMENT_LABELS[m.type] ?? m.type}
                    {m.lot_numbers && <span className="text-caption text-ink-subtle">Lote {m.lot_numbers}</span>}
                    {m.reverts_movement_id && <span className="badge badge-info">Cancelación</span>}
                    {m.cancelled_by_movement_id && (
                      <span
                        className="badge badge-danger"
                        title={`${m.cancel_note ?? ''}${m.cancelled_by_name ? ` · ${m.cancelled_by_name}` : ''}${m.cancelled_at ? ` · ${formatDateTime(m.cancelled_at)}` : ''}`}
                      >
                        Cancelado
                      </span>
                    )}
                  </span>
                </td>
                <td className="h-row px-3 whitespace-nowrap">
                  {m.location === 'warehouse' ? <span className="badge badge-warning">Bodega</span> : <span className="text-ink-muted">{LOCATION_LABELS.store}</span>}
                </td>
                <td className={`h-row px-3 text-right font-medium tabular-nums ${deltaClass(m)}`}>
                  {m.delta > 0 ? '+' : ''}
                  {formatInt(m.delta)}
                </td>
                <td className="h-row px-3 text-right tabular-nums">{formatInt(m.quantity_after)}</td>
                <td className="h-row px-3">{m.created_by_name || m.created_by_email || '—'}</td>
                <td className="h-row min-w-44 px-3 text-ink-muted">
                  {m.note}
                  {m.cancelled_by_movement_id && (
                    <span className="block text-caption text-danger-fg">
                      Cancelado{m.cancelled_by_name ? ` por ${m.cancelled_by_name}` : ''}
                      {m.cancelled_at ? ` el ${formatDateTime(m.cancelled_at)}` : ''}
                    </span>
                  )}
                </td>
                {isAdmin && (
                  <td className="h-row px-3 text-right">
                    {cancellable(m) && (
                      <button
                        type="button"
                        onClick={() => {
                          setSaved(null)
                          setCancelling(m)
                        }}
                        className="btn btn-ghost btn-sm"
                      >
                        <Icon name="undo" />
                        Cancelar
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && !error && <p className="px-4 py-10 text-center text-ink-subtle">Sin movimientos.</p>}
      </div>
      {hasMore && rows.length > 0 && (
        <div className="flex items-center justify-between gap-4">
          <span className="text-caption text-ink-muted">Mostrando {formatInt(rows.length)} movimientos</span>
          <button type="button" onClick={() => void load(rows.length, filter)} disabled={loading} className="btn btn-secondary">
            {loading ? 'Cargando…' : 'Cargar más'}
          </button>
        </div>
      )}

      {cancelling && (
        <CancelMovementModal
          movement={cancelling}
          onCancel={() => setCancelling(null)}
          onDone={(product) => {
            inventoryStore.productEdited(product)
            setCancelling(null)
            setSaved(`Movimiento cancelado. ${product.name} quedó en ${formatInt(product.quantity)} pzas.`)
            void load(0, filter)
          }}
        />
      )}
    </div>
  )
}

/** Color del cambio de piezas (tachado si se canceló). */
function deltaClass(m: MovementHistoryRow) {
  if (m.cancelled_by_movement_id) return 'line-through'
  return m.delta > 0 ? 'text-success-fg' : m.delta < 0 ? 'text-danger-fg' : ''
}

/** Cancelar un movimiento: pide el motivo. El movimiento no se borra, queda marcado. */
function CancelMovementModal({
  movement,
  onCancel,
  onDone,
}: {
  movement: MovementHistoryRow
  onCancel: () => void
  onDone: (product: Product) => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Movimientos anteriores a los lotes: si hay que quitar piezas y hay varios lotes, se elige de cuál.
  const [picking, setPicking] = useState(false)

  async function run(lots?: LotPick[]) {
    setBusy(true)
    setError(null)
    try {
      onDone(await cancelMovement(movement.id, reason, lots))
    } catch (err) {
      if (needsLotChoice(err)) {
        setPicking(true)
      } else {
        setError(isNetworkError(err) ? 'Sin conexión: intenta cuando vuelva el internet.' : (err as Error).message)
      }
      setBusy(false)
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!reason.trim()) return setError('El motivo es obligatorio.')
    await run()
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4" role="dialog" aria-modal="true" aria-labelledby="cm-title">
      <form
        noValidate
        onSubmit={onSubmit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        className="w-full max-w-lg dialog"
      >
        <div className="border-b border-line px-6 py-5">
          <h2 id="cm-title" className="text-title">Cancelar movimiento</h2>
          <p className="mt-1 text-ink-muted">
            {MOVEMENT_LABELS[movement.type]} en {LOCATION_LABELS[movement.location ?? 'store'].toLowerCase()} de{' '}
            <span className="text-ink">{movement.product_name}</span> ·{' '}
            <span className="tabular-nums">
              {movement.delta > 0 ? '+' : ''}
              {formatInt(movement.delta)}
            </span>{' '}
            · {formatDateTime(movement.created_at)}
          </p>
        </div>
        <div className="space-y-4 px-6 py-5">
          <p className="text-ink-muted">
            Se revierte la cantidad ({movement.delta > 0 ? '−' : '+'}
            {formatInt(Math.abs(movement.delta))} pzas). El movimiento no se borra: queda marcado como cancelado con tu
            nombre, la fecha y el motivo.
          </p>
          <div>
            <label className="field-label" htmlFor="cm-reason">Motivo *</label>
            <input
              id="cm-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ej. Se escaneó dos veces la misma caja"
              autoFocus
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
        </div>
        <div className="flex justify-end gap-3 border-t border-line bg-subtle px-6 py-4">
          <button type="button" onClick={onCancel} className="btn btn-ghost">
            Volver
          </button>
          <button type="submit" disabled={busy} className="btn btn-danger">
            {busy ? 'Cancelando…' : 'Cancelar movimiento'}
          </button>
        </div>
      </form>
      {picking && (
        <LotPicker
          productId={movement.product_id}
          productName={movement.product_name}
          location={movement.location ?? 'store'}
          remove={movement.delta}
          purpose="Cancelación"
          onCancel={() => setPicking(false)}
          onConfirm={(picks) => {
            setPicking(false)
            void run(picks)
          }}
        />
      )}
    </div>
  )
}
