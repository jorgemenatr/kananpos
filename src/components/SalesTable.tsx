import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { LanguageTag } from './LanguageTag'
import { formatDateTime, formatInt, formatMoney } from '../lib/format'
import { getTicketItems, getTicketPayments, saleTitle, setTicketNotes } from '../lib/sales'
import { PAYMENT_LABELS, TICKET_STATUS_LABELS, type SaleRow, type TicketItemRow, type TicketPaymentRow } from '../lib/types'
import { inventoryStore } from '../store/inventoryStore'
import { CancelTicketModal } from './CancelTicketModal'
import { Icon } from './Icon'

interface Detail {
  items: TicketItemRow[]
  payments: TicketPaymentRow[]
}

interface Props {
  sales: SaleRow[]
  /** Ocultar la columna de cliente (p. ej. en el detalle de un cliente). */
  hideCustomer?: boolean
  emptyText: string
  /** Se canceló una venta o cambió una nota (para recargar). */
  onChanged?: () => void
}

/** Fecha de la fila: la de venta, o la de registro en preventas sin entregar. */
const saleDate = (s: SaleRow) => formatDateTime(s.paid_at ?? s.created_at)

/** Tabla de ventas cobradas; cada fila se despliega para ver los productos. */
export function SalesTable({ sales, hideCustomer, emptyText, onChanged }: Props) {
  const [open, setOpen] = useState<string | null>(null)
  const [items, setItems] = useState<Record<string, Detail | 'error'>>({})

  function toggle(id: string, reload = false) {
    if (!reload) setOpen((o) => (o === id ? null : id))
    if (!items[id] || reload) {
      Promise.all([getTicketItems(id), getTicketPayments(id)])
        .then(([rows, payments]) => setItems((m) => ({ ...m, [id]: { items: rows, payments } })))
        .catch(() => setItems((m) => ({ ...m, [id]: 'error' })))
    }
  }

  return (
    <div className="card overflow-x-auto">
      {/* Celular: una tarjeta por venta; se despliega igual que la fila. */}
      <ul className="divide-y divide-line md:hidden">
        {sales.map((s) => {
          const expanded = open === s.id
          return (
            <li key={s.id} className={expanded ? 'bg-subtle' : ''}>
              <div className="flex cursor-pointer items-start gap-3 px-4 py-3" onClick={() => toggle(s.id)}>
                <div className="min-w-0 flex-1 space-y-1">
                  <SaleTitle sale={s} expanded={expanded} withCustomer={!hideCustomer} />
                  <p className="text-caption text-ink-muted">
                    {saleDate(s)} · {formatInt(s.item_count)} art. ·{' '}
                    {s.payment_method === 'mixed' ? 'Mixto' : PAYMENT_LABELS[s.payment_method]}
                  </p>
                </div>
                <SaleAmount sale={s} className="shrink-0" />
                <ToggleButton sale={s} expanded={expanded} onToggle={() => toggle(s.id)} />
              </div>
              {expanded && (
                <div className="px-4 pb-4">
                  <SaleDetail sale={s} detail={items[s.id]} onChanged={() => (toggle(s.id, true), onChanged?.())} />
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <table className="hidden w-full border-collapse text-left md:table">
        <thead>
          <tr className="thead-row">
            <th className="h-control-md w-8 px-3">
              <span className="sr-only">Detalle</span>
            </th>
            <th className="h-control-md px-3 font-medium">Fecha</th>
            <th className="h-control-md px-3 font-medium">Venta</th>
            <th className="h-control-md px-3 text-right font-medium">Artículos</th>
            <th className="h-control-md px-3 font-medium">Pago</th>
            <th className="h-control-md px-3 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {sales.map((s) => {
            const expanded = open === s.id
            const detail = items[s.id]
            return (
              <Fragment key={s.id}>
                <tr
                  className={`cursor-pointer border-t border-line ${expanded ? 'bg-subtle' : 'hover:bg-subtle'}`}
                  onClick={() => toggle(s.id)}
                >
                  <td className="h-row px-3 text-ink-subtle">
                    <ToggleButton sale={s} expanded={expanded} onToggle={() => toggle(s.id)} />
                  </td>
                  <td className="h-row px-3 whitespace-nowrap text-ink-muted">{saleDate(s)}</td>
                  <td className="h-row px-3">
                    <SaleTitle sale={s} expanded={expanded} withCustomer={!hideCustomer} />
                  </td>
                  <td className="h-row px-3 text-right tabular-nums">{formatInt(s.item_count)}</td>
                  <td className="h-row px-3 whitespace-nowrap">
                    {s.payment_method === 'mixed' ? <span className="badge badge-info">Mixto</span> : PAYMENT_LABELS[s.payment_method]}
                  </td>
                  <td className="h-row px-3 text-right">
                    <SaleAmount sale={s} />
                  </td>
                </tr>
                {expanded && (
                  <tr className="bg-subtle">
                    <td />
                    <td colSpan={5} className="px-3 pb-4">
                      <SaleDetail sale={s} detail={detail} onChanged={() => (toggle(s.id, true), onChanged?.())} />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      {sales.length === 0 && <p className="px-4 py-10 text-center text-ink-subtle">{emptyText}</p>}
    </div>
  )
}

/** "140. Ana Martínez"; ya desplegada, un ojo junto al nombre abre al cliente. */
function SaleTitle({ sale: s, expanded, withCustomer }: { sale: SaleRow; expanded: boolean; withCustomer: boolean }) {
  return (
    <p className="flex flex-wrap items-center gap-2 font-medium">
      {saleTitle(s, withCustomer)}
      {expanded && withCustomer && s.customer_id && (
        <Link
          to={`/clientes/${s.customer_id}`}
          onClick={(e) => e.stopPropagation()}
          title="Ver cliente"
          aria-label={`Ver cliente ${s.customer_name ?? ''}`}
          className="-my-1 grid size-8 place-items-center rounded-md text-ink-muted hover:bg-surface hover:text-brand-ink"
        >
          <Icon name="eye" />
        </Link>
      )}
      {s.customer_is_free_name && withCustomer && <span className="badge badge-neutral font-normal">Sin perfil</span>}
      {s.status === 'preorder' && <span className="badge badge-warning font-normal">{TICKET_STATUS_LABELS.preorder}</span>}
      {s.status === 'cancelled' && <span className="badge badge-danger font-normal">{TICKET_STATUS_LABELS.cancelled}</span>}
      {s.notes && <Icon name="pencil" className="text-ink-subtle" aria-label="Tiene notas" />}
      {s.paid_offline && <span className="badge badge-neutral font-normal">Sin conexión</span>}
    </p>
  )
}

/** Total (tachado si se canceló) y, en preventas, lo que falta. */
function SaleAmount({ sale: s, className = '' }: { sale: SaleRow; className?: string }) {
  return (
    <span className={`flex flex-col items-end ${className}`}>
      <span className={`font-medium tabular-nums ${s.status === 'cancelled' ? 'text-ink-subtle line-through' : ''}`}>{formatMoney(s.total)}</span>
      {s.status === 'preorder' && <span className="text-caption text-warning-fg tabular-nums">Saldo {formatMoney(s.balance)}</span>}
    </span>
  )
}

function ToggleButton({ sale: s, expanded, onToggle }: { sale: SaleRow; expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      aria-expanded={expanded}
      aria-label={`Ver productos de la venta ${saleTitle(s)}`}
      className="grid size-6 shrink-0 cursor-pointer place-items-center text-ink-subtle"
    >
      <Icon name={expanded ? 'chevron-up' : 'chevron-down'} />
    </button>
  )
}

/** Productos, pagos, notas y quién cobró un ticket (al desplegar la fila). */
function SaleDetail({ sale: s, detail, onChanged }: { sale: SaleRow; detail: Detail | 'error' | undefined; onChanged: () => void }) {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [cancelling, setCancelling] = useState(false)
  // Cancelar: preventas cualquier usuario; ventas cobradas solo admin.
  const canCancel = s.status === 'preorder' || (s.status === 'paid' && isAdmin)

  return (
    <>
      {!detail && <p className="py-2 text-ink-subtle">Cargando productos…</p>}
      {detail === 'error' && <p className="py-2 text-danger-fg">No se pudieron cargar los productos.</p>}
      {detail && detail !== 'error' && (
        <table className="w-full max-w-3xl border-collapse text-left max-md:block">
          <tbody className="max-md:block">
            {detail.items.map((i) => (
              <tr key={i.id} className="border-b border-line last:border-0 max-md:flex max-md:flex-wrap max-md:items-baseline max-md:gap-x-3 max-md:py-2">
                <td className={`py-1.5 pr-3 max-md:basis-full max-md:p-0 ${i.parent_item_id ? 'pl-5' : ''}`}>
                  {i.parent_item_id && <span className="text-ink-subtle">↳ </span>}
                  <LanguageTag language={i.language} className="mr-1.5" />
                  {i.product_name}
                  {i.preorder && <span className="ml-2 badge badge-warning">Preventa</span>}
                  <span className="ml-2 font-mono text-caption text-ink-subtle">{i.barcode}</span>
                </td>
                <td className="py-1.5 pr-3 text-right whitespace-nowrap text-ink-muted tabular-nums max-md:mr-auto max-md:p-0 max-md:text-caption">
                  {formatInt(i.quantity)} × {formatMoney(i.unit_price)}
                </td>
                <td className="py-1.5 text-right font-medium tabular-nums max-md:p-0">{formatMoney(i.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {detail && detail !== 'error' && detail.payments.length > 0 && (
        <div className="mt-3 max-w-3xl">
          <p className="text-label text-ink-muted">
            {s.status === 'preorder' || detail.payments.length > 1 ? 'Pagos y abonos' : 'Pago'}
          </p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {detail.payments.map((p) => (
              <li
                key={p.id}
                className={`inline-flex items-center gap-2 border px-2.5 py-1 text-label ${p.kind === 'refund' ? 'border-danger-solid bg-danger-bg text-danger-fg' : 'border-line bg-surface'}`}
              >
                {p.kind === 'refund' ? 'Devolución · ' : ''}
                {PAYMENT_LABELS[p.method]}
                <span className="tabular-nums">{formatMoney(p.amount)}</span>
                <span className="text-caption text-ink-subtle">{formatDateTime(p.paid_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <SaleNotes sale={s} onChanged={onChanged} />
      <p className="mt-2 text-caption text-ink-subtle">
        {s.status === 'preorder' ? 'Registró' : 'Cobró'} {s.created_by_name || s.created_by_email || '—'}
        {s.opened_at && ` · abierto ${formatDateTime(s.opened_at)}`}
        {s.paid_at && s.paid_at !== s.created_at && s.created_at && ` · registrada ${formatDateTime(s.created_at)}`}
      </p>
      {s.status === 'cancelled' && (
        <p className="mt-1 text-caption text-danger-fg">
          Cancelada {s.cancelled_at && formatDateTime(s.cancelled_at)} por {s.cancelled_by_name || s.cancelled_by_email || '—'}
          {s.cancel_reason && ` · Motivo: ${s.cancel_reason}`}
        </p>
      )}
      {s.note && <p className="mt-1 text-caption text-warning-fg">{s.note}</p>}
      {(s.status === 'preorder' || canCancel) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {s.status === 'preorder' && (
            <Link to={`/preventas?id=${s.id}`} className="btn btn-secondary btn-sm">
              Abonar o entregar
            </Link>
          )}
          {canCancel && (
            <button type="button" onClick={() => setCancelling(true)} className="btn btn-danger btn-sm">
              {s.status === 'preorder' ? 'Cancelar preventa' : 'Cancelar venta'}
            </button>
          )}
        </div>
      )}
      {cancelling && (
        <CancelTicketModal
          title={`${s.status === 'preorder' ? 'Cancelar preventa' : 'Cancelar venta'} #${s.number}`}
          description="Lo que se descontó regresa al inventario (a sus mismos lotes) y queda registrado quién la canceló y cuándo."
          refundable={s.paid_amount}
          onClose={() => setCancelling(false)}
          onConfirm={async (reason, refund) => {
            const out = await inventoryStore.cancelTicket(s.id, reason, refund)
            if (out.type === 'error') return out.message
            setCancelling(false)
            onChanged()
            return null
          }}
        />
      )}
    </>
  )
}

/** Notas de la venta: se ven en el historial y se pueden editar. */
function SaleNotes({ sale: s, onChanged }: { sale: SaleRow; onChanged: () => void }) {
  const [text, setText] = useState(s.notes ?? '')
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    try {
      await setTicketNotes(s.id, text)
      setEditing(false)
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (!editing) {
    return (
      <div className="mt-3 flex max-w-3xl items-start gap-2">
        {s.notes ? <p className="flex-1 whitespace-pre-wrap rounded-md bg-surface px-3 py-2 text-ink">{s.notes}</p> : null}
        <button type="button" onClick={() => setEditing(true)} className="btn btn-ghost btn-sm">
          <Icon name="pencil" />
          {s.notes ? 'Editar nota' : 'Agregar nota'}
        </button>
      </div>
    )
  }
  return (
    <div className="mt-3 flex max-w-3xl flex-col gap-2">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} autoFocus className="field h-auto py-2" aria-label="Notas de la venta" />
      {error && <p className="text-caption text-danger-fg">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={() => void save()} className="btn btn-primary btn-sm">
          Guardar nota
        </button>
        <button type="button" onClick={() => setEditing(false)} className="btn btn-ghost btn-sm">
          Cancelar
        </button>
      </div>
    </div>
  )
}
