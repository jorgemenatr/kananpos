import { useCallback, useEffect, useRef, useState } from 'react'
import { formatDateTime, formatInt, formatMoney } from '../../lib/format'
import { getSale, getTicketItems, getTicketPayments, saleTitle, setTicketNotes } from '../../lib/sales'
import { useSettings } from '../../lib/settings'
import { sounds } from '../../lib/sounds'
import { PAYMENT_LABELS, type PaymentPart, type SaleRow, type TicketItemRow, type TicketPaymentRow } from '../../lib/types'
import { inventoryStore, type CachedProduct } from '../../store/inventoryStore'
import { CancelTicketModal } from '../CancelTicketModal'
import { Icon } from '../Icon'
import { LanguageTag } from '../LanguageTag'
import { PaymentPanel } from './PaymentPanel'

interface Props {
  ticketId: string
  productsById: Record<string, CachedProduct>
  online: boolean
  /** Se abonó, entregó o canceló (para recargar la lista). */
  onChanged: (message: string | null, closed: boolean) => void
}

interface Data {
  sale: SaleRow
  items: TicketItemRow[]
  payments: TicketPaymentRow[]
}

/**
 * Preventa registrada: abonos con fecha y método, saldo, notas, entrega (solo
 * saldada y con las piezas en tienda) y cancelación.
 */
export function PreorderPanel({ ticketId, productsById, online, onChanged }: Props) {
  const settings = useSettings()
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [paying, setPaying] = useState(false)
  const [deliver, setDeliver] = useState(true)
  const [cancelling, setCancelling] = useState(false)
  const [notes, setNotes] = useState('')
  // Un reintento del mismo abono (p. ej. se cayó la red) no se cobra doble.
  const opId = useRef(crypto.randomUUID())

  const load = useCallback(async () => {
    try {
      const [sale, items, payments] = await Promise.all([getSale(ticketId), getTicketItems(ticketId), getTicketPayments(ticketId)])
      if (!sale) throw new Error('No se encontró la preventa')
      setData({ sale, items, payments })
      setNotes(sale.notes ?? '')
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [ticketId])

  useEffect(() => {
    setData(null)
    void load()
  }, [load])

  if (error) {
    return (
      <section className="card p-5">
        <p className="notice bg-danger-bg text-danger-fg">
          <Icon name="alert" className="mt-0.5" />
          {online ? error : 'Sin conexión: las preventas se consultan con internet.'}
        </p>
      </section>
    )
  }
  if (!data) return <section className="card p-8 text-center text-ink-subtle">Cargando preventa…</section>

  const { sale, items, payments } = data
  const balance = sale.balance
  const pending = items.filter((i) => i.preorder)
  // Piezas de preventa que aún no están en la tienda.
  const missing = pending.filter((i) => (productsById[i.product_id]?.quantity ?? 0) < i.quantity)
  const customer = sale.customer_id && !sale.customer_is_free_name ? { id: sale.customer_id, name: sale.customer_name ?? 'Cliente' } : null

  async function pay(parts: PaymentPart[]) {
    const amount = parts.reduce((s, p) => s + p.amount, 0)
    const settles = Math.round(amount * 100) === Math.round(balance * 100)
    setPaying(true)
    setNotice(null)
    const out = await inventoryStore.addTicketPayment(ticketId, parts, deliver && settles, opId.current)
    setPaying(false)
    if (out.type === 'error') {
      sounds.error()
      setNotice(out.message)
      return
    }
    opId.current = crypto.randomUUID()
    sounds.success()
    if (out.ticket.status === 'paid') {
      onChanged(`Preventa #${sale.number} liquidada y entregada`, true)
      return
    }
    onChanged(`Abono de ${formatMoney(amount)} registrado · saldo ${formatMoney(out.balance)}`, false)
    await load()
  }

  async function deliverNow() {
    setPaying(true)
    setNotice(null)
    const out = await inventoryStore.addTicketPayment(ticketId, [], true, opId.current)
    setPaying(false)
    if (out.type === 'error') {
      sounds.error()
      setNotice(out.message)
      return
    }
    opId.current = crypto.randomUUID()
    sounds.success()
    onChanged(`Preventa #${sale.number} entregada`, true)
  }

  async function saveNotes() {
    if (notes.trim() === (sale.notes ?? '')) return
    try {
      await setTicketNotes(ticketId, notes)
    } catch (e) {
      setNotice(`No se guardó la nota: ${(e as Error).message}`)
    }
  }

  return (
    <section className="grid items-start gap-4 2xl:grid-cols-[1fr_320px]">
      <div className="card flex min-w-0 flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-auto min-w-0">
            <h2 className="truncate text-title">
              Preventa {saleTitle(sale)}
              {sale.customer_is_free_name && <span className="ml-2 badge badge-neutral align-middle">Sin perfil</span>}
            </h2>
            <p className="text-caption text-ink-subtle">
              Registrada {formatDateTime(sale.created_at)} por {sale.created_by_name || sale.created_by_email || '—'} · se entrega
              solo ya saldada
            </p>
          </div>
          <button type="button" onClick={() => setCancelling(true)} disabled={!online} className="btn btn-danger btn-sm">
            Cancelar preventa
          </button>
        </div>

        <div>
          <label className="field-label" htmlFor="pre-notes">
            Notas
          </label>
          <textarea
            id="pre-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => void saveNotes()}
            rows={2}
            placeholder="Ej. Le avisamos por WhatsApp cuando llegue"
            className="field h-auto py-2"
          />
        </div>

        <ul className="divide-y divide-line rounded-md border border-line">
          {items.map((i) => {
            const p = productsById[i.product_id]
            return (
              <li key={i.id} className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 ${i.parent_item_id ? 'pl-8' : ''}`}>
                <span className="min-w-0 flex-1 font-medium">
                  {i.parent_item_id && <span className="text-ink-subtle">↳ </span>}
                  <LanguageTag language={i.language} className="mr-1.5" />
                  {i.product_name}
                  {i.preorder && <span className="ml-2 badge badge-warning">Preventa</span>}
                </span>
                {i.preorder && (
                  <span className={`text-caption ${(p?.quantity ?? 0) >= i.quantity ? 'text-success-fg' : 'text-ink-muted'}`}>
                    {(p?.quantity ?? 0) >= i.quantity ? `Ya llegó · ${formatInt(p?.quantity ?? 0)} en tienda` : 'Aún no llega a tienda'}
                  </span>
                )}
                <span className="text-ink-muted tabular-nums">
                  {formatInt(i.quantity)} × {formatMoney(i.unit_price)}
                </span>
                <span className="w-24 text-right font-medium tabular-nums">{formatMoney(i.line_total)}</span>
              </li>
            )
          })}
        </ul>

        <div>
          <p className="field-label">Abonos</p>
          <ul className="divide-y divide-line rounded-md border border-line">
            {payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <span className="text-ink-muted">{formatDateTime(p.paid_at)}</span>
                <span className="mr-auto">{PAYMENT_LABELS[p.method]}</span>
                <span className="font-medium tabular-nums">{formatMoney(p.amount)}</span>
              </li>
            ))}
            {payments.length === 0 && <li className="px-3 py-2 text-ink-subtle">Sin abonos.</li>}
          </ul>
          <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
            <div className="card p-3">
              <dt className="stat-label text-ink-muted">Total</dt>
              <dd className="font-display text-heading font-extrabold tabular-nums">{formatMoney(sale.total)}</dd>
            </div>
            <div className="card p-3">
              <dt className="stat-label text-ink-muted">Pagado</dt>
              <dd className="font-display text-heading font-extrabold tabular-nums">{formatMoney(sale.paid_amount)}</dd>
            </div>
            <div className={`card p-3 ${balance > 0 ? 'border-2 border-warning-solid' : 'border-2 border-success-solid'}`}>
              <dt className="stat-label text-ink-muted">Saldo</dt>
              <dd className="font-display text-heading font-extrabold tabular-nums">{formatMoney(balance)}</dd>
            </div>
          </dl>
        </div>

        {notice && (
          <p className="notice bg-danger-bg text-danger-fg" role="alert">
            <Icon name="alert" className="mt-0.5" />
            {notice}
          </p>
        )}
      </div>

      {balance > 0 ? (
        <PaymentPanel
          key={`${ticketId}-${payments.length}`}
          title="Saldo"
          total={balance}
          pieces={items.reduce((n, i) => n + (i.parent_item_id ? 0 : i.quantity), 0)}
          hasLines
          customer={customer}
          online={online}
          paying={paying}
          allowCredit={settings.preorderCreditPayments}
          partial={{ min: 0.01, max: balance, initial: balance, label: 'Monto del abono' }}
          actionLabel={(amount) =>
            deliver && Math.round(amount * 100) === Math.round(balance * 100) ? `Liquidar y entregar ${formatMoney(amount)}` : `Abonar ${formatMoney(amount)}`
          }
          footer={
            <label className="flex cursor-pointer items-start gap-2">
              <input type="checkbox" checked={deliver} onChange={(e) => setDeliver(e.target.checked)} className="mt-1 size-4" />
              <span>
                Entregar al liquidar
                {missing.length > 0 && (
                  <span className="block text-caption text-warning-fg">Aún no hay piezas en tienda: solo se registrará el pago.</span>
                )}
              </span>
            </label>
          }
          onPay={(parts) => void pay(parts)}
        />
      ) : (
        <div className="card flex flex-col gap-3 p-5">
          <p className="text-title">Saldada</p>
          {missing.length > 0 ? (
            <p className="text-ink-muted">
              Lista para entregar en cuanto llegue: {missing.map((i) => i.product_name).join(', ')}.
            </p>
          ) : (
            <p className="text-ink-muted">Las piezas ya están en tienda.</p>
          )}
          <button
            type="button"
            onClick={() => void deliverNow()}
            disabled={paying || !online || missing.length > 0}
            className="btn btn-primary btn-lg btn-block"
          >
            <Icon name="check" size={20} />
            {paying ? 'Entregando…' : 'Entregar'}
          </button>
        </div>
      )}

      {cancelling && (
        <CancelTicketModal
          title={`Cancelar preventa #${sale.number}`}
          description="Se liberan las piezas comprometidas y lo que ya se había entregado regresa al inventario. Queda registrado quién la canceló y cuándo."
          refundable={sale.paid_amount}
          onClose={() => setCancelling(false)}
          onConfirm={async (reason, refund) => {
            const out = await inventoryStore.cancelTicket(ticketId, reason, refund)
            if (out.type === 'error') return out.message
            setCancelling(false)
            onChanged(`Preventa #${sale.number} cancelada`, true)
            return null
          }}
        />
      )}
    </section>
  )
}
