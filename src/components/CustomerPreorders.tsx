import { useEffect, useState } from 'react'
import { nameWithLanguage } from './LanguageTag'
import { Link } from 'react-router-dom'
import { formatDateTime, formatMoney } from '../lib/format'
import { getPreorderItems, listPreorders } from '../lib/sales'
import { isNetworkError } from '../lib/supabase'
import type { Customer, SaleRow, TicketItemRow } from '../lib/types'
import { Icon } from './Icon'

/** Preventas sin entregar de un cliente: qué lleva, cuánto ha abonado y cuánto debe. */
export function CustomerPreorders({ customer }: { customer: Customer }) {
  const [preorders, setPreorders] = useState<SaleRow[] | null>(null)
  const [items, setItems] = useState<Record<string, TicketItemRow[]>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setPreorders(null)
    setError(null)
    listPreorders(customer.id)
      .then(async (list) => {
        const rows = await getPreorderItems(list.map((s) => s.id))
        const byTicket: Record<string, TicketItemRow[]> = {}
        for (const r of rows) (byTicket[r.ticket_id] ??= []).push(r)
        if (!current) return
        setPreorders(list)
        setItems(byTicket)
      })
      .catch((e) => current && setError(isNetworkError(e) ? 'Sin conexión: no se pueden cargar las preventas.' : (e as Error).message))
    return () => {
      current = false
    }
  }, [customer.id])

  const owed = (preorders ?? []).reduce((sum, s) => sum + s.balance, 0)

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="mr-auto text-title">Preventas</h2>
        {preorders && preorders.length > 0 && (
          <span className="text-ink-muted">
            {preorders.length} pendiente(s) · debe <span className="font-medium text-ink tabular-nums">{formatMoney(owed)}</span>
          </span>
        )}
      </div>
      {error && (
        <p className="notice bg-danger-bg text-danger-fg">
          <Icon name="alert" className="mt-0.5" />
          {error}
        </p>
      )}
      {!preorders && !error && <p className="text-ink-subtle">Cargando preventas…</p>}
      {preorders?.length === 0 && <p className="text-ink-subtle">No tiene preventas pendientes.</p>}
      {preorders && preorders.length > 0 && (
        <ul className="card divide-y divide-line">
          {preorders.map((s) => (
            <li key={s.id}>
              <Link to={`/preventas?id=${s.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-subtle">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    #{s.number}{' '}
                    <span className="font-normal text-ink-muted">
                      {(items[s.id] ?? [])
                        .filter((i) => i.preorder)
                        .map((i) => `${nameWithLanguage(i.product_name, i.language)}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`)
                        .join(', ')}
                    </span>
                  </span>
                  <span className="text-caption text-ink-subtle">Registrada {formatDateTime(s.created_at)}</span>
                </span>
                <span className="text-right text-caption text-ink-muted tabular-nums">
                  Abonado {formatMoney(s.paid_amount)} de {formatMoney(s.total)}
                </span>
                <span className={`w-28 text-right font-medium tabular-nums ${s.balance > 0 ? 'text-warning-fg' : 'text-success-fg'}`}>
                  {s.balance > 0 ? `Debe ${formatMoney(s.balance)}` : 'Saldada'}
                </span>
                <Icon name="chevron-down" className="-rotate-90 text-ink-subtle" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
