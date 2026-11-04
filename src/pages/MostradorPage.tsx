import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { CancelTicketModal } from '../components/CancelTicketModal'
import { CustomerFormModal } from '../components/CustomerFormModal'
import { Icon } from '../components/Icon'
import { ProductImage } from '../components/ProductImage'
import { LanguageTag } from '../components/LanguageTag'
import { CustomerPicker } from '../components/pos/CustomerPicker'
import { PaymentPanel } from '../components/pos/PaymentPanel'
import { ProductPicker } from '../components/pos/ProductPicker'
import { findByCode, gameSuggestions } from '../lib/customers'
import { formatInt, formatMoney, parseMoney } from '../lib/format'
import { ticketFolio } from '../lib/sales'
import { useSettings } from '../lib/settings'
import { sounds } from '../lib/sounds'
import { PAYMENT_LABELS, type PaymentPart } from '../lib/types'
import { comboDrinks, freeQuantity, inventoryStore, type CachedProduct } from '../store/inventoryStore'
import { useInventory } from '../store/useInventory'
import {
  lineDeposit,
  posStore,
  ticketLabel,
  ticketOpenedTime,
  ticketPieces,
  ticketTotal,
  usePos,
  type OpenTicket,
  type PosLine,
} from '../store/posStore'

type Notice = { kind: 'error' | 'info'; text: string } | null
type LastSale = {
  title: string
  total: number
  payments: PaymentPart[]
  change: number | null
  /** Preventa: lo que falta por pagar y su id (para abrirla en Preventas). */
  balance: number | null
  preorderId: string | null
} | null

export function MostradorPage() {
  const { products, online } = useInventory()
  const { tickets, activeId, customers, pending, syncError } = usePos()
  const settings = useSettings()
  const [searchParams] = useSearchParams()
  // Enlaces anteriores (/mostrador?preventa=…): las preventas tienen su propia sección.
  const legacyPreorder = searchParams.get('preventa')
  const active = tickets.find((t) => t.id === activeId) ?? null

  const [notice, setNotice] = useState<Notice>(null)
  const [paying, setPaying] = useState(false)
  const [lastSale, setLastSale] = useState<LastSale>(null)
  const [creatingCustomer, setCreatingCustomer] = useState<string | null>(null)
  const [comboFor, setComboFor] = useState<CachedProduct | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const productRef = useRef<HTMLInputElement>(null)
  const ticketRef = useRef<HTMLElement>(null)

  const productsById = useMemo(() => {
    const byId: Record<string, CachedProduct> = {}
    for (const p of Object.values(products)) byId[p.id] = p
    return byId
  }, [products])

  // Sin mover la pantalla: en el celular el ticket ya se llevó a la vista (ver abajo).
  const focusProduct = useCallback(() => setTimeout(() => productRef.current?.focus({ preventScroll: true }), 0), [])

  // Al entrar: ningún ticket abierto (se elige de la lista), tickets
  // compartidos al día, e inventario y clientes frescos si hay red.
  useEffect(() => {
    posStore.select(null)
    posStore.start()
    void posStore.refresh()
    if (!online) return
    void inventoryStore.refreshProducts()
    posStore.loadCustomers().catch(() => undefined)
    // Solo al entrar a la página.
  }, [])

  // Cambiar de ticket reinicia el cobro. En pantallas angostas la lista de
  // tickets va arriba: al crear o elegir uno, la pantalla baja hasta él.
  useEffect(() => {
    setNotice(null)
    if (!activeId) return
    if (window.matchMedia('(max-width: 63.99rem)').matches) {
      setTimeout(() => ticketRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0)
    }
    focusProduct()
  }, [activeId, focusProduct])

  // Depende de los tickets: lo apartado cambia al agregar o cobrar.
  const available = useCallback((p: CachedProduct) => posStore.available(p), [tickets])

  function selectOpen(id: string) {
    posStore.select(id)
    setLastSale(null)
  }

  function createTicket() {
    posStore.createTicket()
    setLastSale(null)
  }

  function addProduct(p: CachedProduct, choice: CachedProduct | null = null) {
    if (!active) return
    if (!choice && p.is_combo) {
      setComboFor(p)
      return
    }
    const res = posStore.addProduct(active.id, p, choice)
    if (res.ok) {
      sounds.success()
      setNotice(null)
      setLastSale(null)
    } else {
      sounds.error()
      setNotice({ kind: 'error', text: res.message })
    }
    focusProduct()
  }

  // Escanear la tarjeta del cliente en el campo de productos lo asigna al ticket.
  function pickCustomerByCode(code: string) {
    const c = active && findByCode(customers, code)
    if (!c || !active) return false
    posStore.setCustomer(active.id, { id: c.id, name: c.name })
    sounds.success()
    setNotice({ kind: 'info', text: `Cliente asignado: ${c.name}` })
    focusProduct()
    return true
  }

  // Preventa: el ticket lleva productos de preventa. El primer abono cubre
  // los productos normales completos más el anticipo de los de preventa.
  const preorderInfo = useMemo(() => {
    if (!active) return null
    let has = false
    let minimum = 0
    for (const l of active.lines) {
      const p = productsById[l.productId]
      if (p?.is_preorder) {
        has = true
        minimum += lineDeposit(l, p)
      } else {
        minimum += l.quantity * l.unitPrice
      }
    }
    return has ? { minimum: Math.round(minimum * 100) / 100 } : null
  }, [active, productsById])

  async function pay(payments: PaymentPart[], change: number | null) {
    if (!active || paying || active.lines.length === 0) return
    setPaying(true)
    setNotice(null)
    const out = await inventoryStore.checkout({
      ticketId: active.id,
      items: active.lines.map((l) => ({
        productId: l.productId,
        name: productsById[l.productId]?.name ?? 'Producto',
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        choiceProductId: l.choiceProductId,
      })),
      payments,
      customerId: active.customer?.id ?? null,
      customerName: active.customer ? null : active.freeName,
      notes: active.notes || null,
      openedAt: active.openedAt,
    })
    setPaying(false)
    if (out.type === 'error') {
      sounds.error()
      setNotice({ kind: 'error', text: out.message })
      return
    }
    sounds.success()
    const preorder = out.ticket.status === 'preorder'
    setLastSale({
      title: preorder ? `Preventa registrada · #${ticketFolio(out.ticket.name)}` : `Venta registrada · #${ticketFolio(out.ticket.name)}`,
      total: payments.reduce((s, p) => s + p.amount, 0),
      payments,
      change,
      balance: preorder ? out.balance : null,
      preorderId: preorder ? out.ticket.id : null,
    })
    posStore.forget(active.id)
  }

  if (legacyPreorder) return <Navigate to={`/preventas?id=${legacyPreorder}`} replace />

  return (
    <div className="pos-compact flex min-h-full min-w-0 flex-col gap-4 p-4 md:p-6">
      <h1 className="hidden text-title-lg uppercase md:block">Mostrador</h1>

      {!online && (
        <p className="notice bg-warning-bg text-warning-fg">
          <Icon name="wifi-off" className="mt-0.5" />
          Sin conexión: puedes abrir tickets y agregar productos (se comparten al volver el internet), pero para cobrar se necesita
          internet.
        </p>
      )}

      {syncError && (
        <p className="notice bg-warning-bg text-warning-fg" role="alert">
          <Icon name="alert" className="mt-0.5" />
          <span className="mr-auto">Un cambio en los tickets abiertos no se pudo guardar: {syncError}</span>
          <button type="button" onClick={() => posStore.dismissSyncError()} className="btn btn-ghost btn-sm">
            Entendido
          </button>
        </p>
      )}

      {lastSale && (
        <div className="kn-block kn-mint kn-deep flex flex-wrap items-center gap-4 p-5" aria-live="polite">
          <Icon name="check" size={32} />
          <div className="mr-auto">
            <p className="text-title">{lastSale.title}</p>
            {lastSale.payments.length > 0 && (
              <p className="text-heading">
                {formatMoney(lastSale.total)} con{' '}
                {lastSale.payments.length === 1
                  ? PAYMENT_LABELS[lastSale.payments[0].method].toLowerCase()
                  : lastSale.payments.map((p) => `${PAYMENT_LABELS[p.method].toLowerCase()} ${formatMoney(p.amount)}`).join(' + ')}
              </p>
            )}
          </div>
          {lastSale.balance !== null && (
            <div className="text-right">
              <p className="stat-label">Saldo pendiente</p>
              <p className="stat-value">{formatMoney(lastSale.balance)}</p>
            </div>
          )}
          {lastSale.preorderId && (
            <Link to={`/preventas?id=${lastSale.preorderId}`} className="btn btn-secondary">
              Ver en Preventas
            </Link>
          )}
          {lastSale.change !== null && lastSale.change > 0 && (
            <div className="text-right">
              <p className="stat-label">Cambio</p>
              <p className="stat-value">{formatMoney(lastSale.change)}</p>
            </div>
          )}
        </div>
      )}

      {/* min-w-0: nada dentro de las columnas puede ensanchar la pantalla. */}
      <div className="grid flex-1 grid-cols-1 items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col gap-4">
          {/* Tickets abiertos (de todos los dispositivos) */}
          <div className="card flex flex-col">
            <h2 className="flex items-center justify-between border-b border-line px-4 py-3 text-label uppercase tracking-wider text-ink-muted">
              Tickets abiertos
              {pending > 0 && (
                <span className="badge badge-warning normal-case tracking-normal" title="Cambios que aún no llegan a los demás dispositivos">
                  {pending} sin enviar
                </span>
              )}
            </h2>
            {tickets.length === 0 && <p className="px-4 py-6 text-center text-ink-subtle">No hay tickets abiertos.</p>}
            <ul className="divide-y divide-line">
              {tickets.map((t) => (
                <li key={t.id}>
                  <TicketButton ticket={t} current={t.id === activeId} onClick={() => selectOpen(t.id)} />
                </li>
              ))}
            </ul>
            <div className="border-t border-line p-3">
              <button type="button" onClick={createTicket} className="btn btn-primary btn-block">
                <Icon name="plus" />
                Nuevo ticket
              </button>
            </div>
          </div>
        </aside>

        {!active ? (
          <section className="card flex min-h-80 min-w-0 flex-col items-center justify-center gap-3 p-8 text-center">
            <Icon name="receipt" size={40} className="text-ink-subtle" />
            <p className="text-title text-ink">{tickets.length > 0 ? 'Elige un ticket abierto o crea uno nuevo' : 'Abre un ticket para empezar a vender'}</p>
            <p className="text-ink-subtle">Al cobrarlo recibe su folio (1, 2, 3…).</p>
            <button type="button" onClick={createTicket} className="btn btn-primary btn-lg mt-3">
              <Icon name="plus" size={20} />
              Nuevo ticket
            </button>
          </section>
        ) : (
          <section ref={ticketRef} className="grid min-w-0 scroll-mt-4 grid-cols-1 items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="card flex min-w-0 flex-col gap-4 p-5 max-md:p-4">
              <TicketHeader
                ticket={active}
                online={online}
                onRemove={() => posStore.removeTicket(active.id)}
                onCancel={() => setCancelling(true)}
              />

              <div>
                <span className="field-label">Cliente</span>
                {active.customer || active.freeName ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex h-control-sm items-center gap-2 rounded-md border-2 border-jade bg-brand-soft px-3 text-label text-brand-ink">
                      <Icon name={active.customer ? 'users' : 'receipt'} />
                      {active.customer?.name ?? active.freeName}
                    </span>
                    {!active.customer && <span className="text-caption text-ink-subtle">Solo nombre (sin perfil)</span>}
                    <button type="button" onClick={() => posStore.setCustomer(active.id, null)} className="btn btn-ghost btn-sm">
                      Quitar
                    </button>
                  </div>
                ) : (
                  <CustomerPicker
                    customers={customers}
                    canCreate={online}
                    placeholder="Cliente (nombre, apodo, teléfono o código) o escribe un nombre…"
                    onPick={(c) => {
                      posStore.setCustomer(active.id, { id: c.id, name: c.name })
                      focusProduct()
                    }}
                    onUseName={(name) => {
                      posStore.setFreeName(active.id, name)
                      focusProduct()
                    }}
                    onCreate={(name) => setCreatingCustomer(name)}
                  />
                )}
              </div>

              <ProductPicker
                inputRef={productRef}
                products={products}
                available={available}
                onPick={(p) => addProduct(p)}
                onOtherCode={pickCustomerByCode}
                availableText={(p, n) =>
                  p.is_preorder
                    ? `Preventa · ${depositLabel(p)}`
                    : p.is_combo
                      ? 'Combo · elige bebida'
                      : n === Infinity
                        ? 'Sin inventario'
                        : `Disponibles: ${formatInt(n)}`
                }
              />

              {notice && (
                <p className={`notice ${notice.kind === 'error' ? 'bg-danger-bg text-danger-fg' : 'bg-info-bg text-info-fg'}`} role="alert">
                  <Icon name="alert" className="mt-0.5" />
                  {notice.text}
                </p>
              )}

              <TicketLines ticket={active} productsById={productsById} onChanged={focusProduct} />

              <TicketNotes ticket={active} />
            </div>

            {/* Cobro: se reinicia al cambiar de ticket (o al volverse preventa) */}
            <PaymentPanel
              key={`${active.id}-${preorderInfo ? 'pre' : 'sale'}`}
              total={ticketTotal(active)}
              pieces={ticketPieces(active)}
              hasLines={active.lines.length > 0}
              customer={active.customer}
              online={online}
              paying={paying}
              allowCredit={!preorderInfo || settings.preorderCreditPayments}
              partial={
                preorderInfo
                  ? {
                      min: preorderInfo.minimum,
                      max: ticketTotal(active),
                      initial: preorderInfo.minimum,
                      label: 'Primer abono (mínimo: anticipo de preventa + productos normales)',
                    }
                  : undefined
              }
              actionLabel={preorderInfo ? (amount) => `Registrar preventa · ${formatMoney(amount)}` : undefined}
              onPay={(payments, change) => void pay(payments, change)}
            />
          </section>
        )}
      </div>

      {creatingCustomer !== null && active && (
        <CustomerFormModal
          customer={null}
          initialName={creatingCustomer}
          gameSuggestions={gameSuggestions(customers)}
          onCancel={() => setCreatingCustomer(null)}
          onSaved={(c) => {
            posStore.addCustomer(c)
            posStore.setCustomer(active.id, { id: c.id, name: c.name })
            setCreatingCustomer(null)
            focusProduct()
          }}
        />
      )}

      {comboFor && active && (
        <ComboChoiceModal
          combo={comboFor}
          options={comboDrinks(products, settings.comboDrinksCategory).filter((p) => p.id !== comboFor.id)}
          onClose={() => {
            setComboFor(null)
            focusProduct()
          }}
          onPick={(choice) => {
            const combo = comboFor
            setComboFor(null)
            addProduct(combo, choice)
          }}
        />
      )}

      {cancelling && active && (
        <CancelTicketModal
          title="Cancelar ticket"
          description="El ticket se quita de los abiertos en todos los dispositivos. Como aún no se cobraba, no se toca el inventario. Queda registrado quién lo canceló y cuándo."
          onClose={() => setCancelling(false)}
          onConfirm={async (reason) => {
            const res = await posStore.cancelTicket(active.id, reason)
            if (!res.ok) return res.message
            setCancelling(false)
            setNotice(null)
            return null
          }}
        />
      )}
    </div>
  )
}

function depositLabel(p: CachedProduct) {
  const v = p.preorder_deposit_value ?? 0
  return p.preorder_deposit_type === 'amount' ? `anticipo ${formatMoney(v)} por pieza` : `anticipo ${v}%`
}

function TicketButton({ ticket: t, current, onClick }: { ticket: OpenTicket; current: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current}
      className={`flex w-full cursor-pointer flex-col gap-0.5 px-4 py-3 text-left ${current ? 'bg-brand text-on-brand' : 'hover:bg-subtle'}`}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className={`truncate text-label ${current ? '' : t.customer || t.freeName ? 'text-ink' : 'text-ink-muted'}`}>{ticketLabel(t)}</span>
        <span className={`shrink-0 text-caption ${current ? '' : 'text-ink-subtle'}`}>{ticketOpenedTime(t)}</span>
      </span>
      <span className={`flex justify-between text-caption ${current ? '' : 'text-ink-subtle'}`}>
        <span>{formatInt(ticketPieces(t))} pzas</span>
        <span className="tabular-nums">{formatMoney(ticketTotal(t))}</span>
      </span>
      {t.notes && <span className={`truncate text-caption italic ${current ? '' : 'text-ink-muted'}`}>{t.notes}</span>}
    </button>
  )
}

function TicketHeader({
  ticket,
  online,
  onRemove,
  onCancel,
}: {
  ticket: OpenTicket
  online: boolean
  onRemove: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="mr-auto min-w-0">
        <h2 className="truncate text-title">Ticket abierto</h2>
        <p className="text-caption text-ink-subtle">
          Abierto {new Date(ticket.openedAt).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })} · el folio se
          asigna al cobrar
        </p>
      </div>
      {ticket.lines.length === 0 ? (
        <button type="button" onClick={onRemove} className="btn btn-danger btn-sm">
          Eliminar ticket
        </button>
      ) : (
        <button
          type="button"
          onClick={onCancel}
          disabled={!online}
          title={online ? undefined : 'Cancelar necesita conexión'}
          className="btn btn-danger btn-sm"
        >
          Cancelar ticket
        </button>
      )}
    </div>
  )
}

/** Notas del ticket: se guardan al salir del campo y se ven al retomarlo y en el historial. */
function TicketNotes({ ticket }: { ticket: OpenTicket }) {
  const [text, setText] = useState(ticket.notes)
  const [editing, setEditing] = useState(false)
  // Lo que llega de otro dispositivo se muestra mientras no se esté escribiendo.
  useEffect(() => {
    if (!editing) setText(ticket.notes)
  }, [ticket.notes, editing])

  return (
    <div>
      <label className="field-label" htmlFor="pos-notes">
        Notas
      </label>
      <textarea
        id="pos-notes"
        value={text}
        onFocus={() => setEditing(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          setEditing(false)
          posStore.setNotes(ticket.id, text.trim())
        }}
        rows={2}
        placeholder="Comentarios del ticket (opcional)"
        className="field h-auto py-2"
      />
    </div>
  )
}

/** Elegir la bebida que va con el combo. */
function ComboChoiceModal({
  combo,
  options,
  onPick,
  onClose,
}: {
  combo: CachedProduct
  options: CachedProduct[]
  onPick: (p: CachedProduct) => void
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="combo-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="max-h-full w-full max-w-lg overflow-auto dialog">
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div>
            <h2 id="combo-title" className="text-title">
              {combo.name}
            </h2>
            <p className="mt-1 text-ink-muted">Elige la bebida incluida (no cambia el precio).</p>
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost">
            <Icon name="x" />
            Cancelar
          </button>
        </div>
        <ul className="divide-y divide-line">
          {options.map((p, i) => {
            const avail = posStore.available(p)
            return (
              <li key={p.id}>
                <button
                  type="button"
                  autoFocus={i === 0}
                  onClick={() => onPick(p)}
                  disabled={avail <= 0}
                  className="flex w-full cursor-pointer items-center gap-3 px-6 py-3 text-left hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ProductImage path={p.image_url} alt="" className="size-10 shrink-0 rounded-xs" />
                  <span className="min-w-0 flex-1 truncate text-label">
                    <LanguageTag language={p.language} className="mr-1.5" />
                    {p.name}
                  </span>
                  <span className={`text-caption ${avail > 0 ? 'text-ink-muted' : 'text-danger-fg'}`}>
                    {avail === Infinity ? 'Sin inventario' : avail > 0 ? `Disponibles: ${formatInt(avail)}` : 'Sin stock'}
                  </span>
                </button>
              </li>
            )
          })}
          {options.length === 0 && <li className="px-6 py-6 text-center text-ink-subtle">No hay bebidas en el grupo de los combos (Configuración → Operación).</li>}
        </ul>
      </div>
    </div>
  )
}

function TicketLines({
  ticket,
  productsById,
  onChanged,
}: {
  ticket: OpenTicket
  productsById: Record<string, CachedProduct>
  onChanged: () => void
}) {
  if (ticket.lines.length === 0) {
    return <p className="rounded-md border-2 border-dashed border-line px-4 py-10 text-center text-ink-subtle">El ticket está vacío. Escanea un producto para empezar.</p>
  }
  return (
    <>
      {/* Celular: cada producto es una tarjeta (nombre completo; precio, cantidad e importe abajo). */}
      <ul className="divide-y divide-line border-y border-line md:hidden">
        {ticket.lines.map((l) => (
          <MobileLine
            key={l.id}
            ticket={ticket}
            line={l}
            product={productsById[l.productId]}
            choice={l.choiceProductId ? productsById[l.choiceProductId] : undefined}
            onChanged={onChanged}
          />
        ))}
      </ul>
    <div className="overflow-x-auto max-md:hidden">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b-2 border-ink text-caption tracking-wider whitespace-nowrap text-ink-muted uppercase">
            <th className="h-9 pr-3 font-semibold">Producto</th>
            <th className="h-9 px-3 text-right font-semibold">Precio</th>
            <th className="h-9 px-3 text-center font-semibold">Cantidad</th>
            <th className="h-9 px-3 text-right font-semibold">Importe</th>
            <th className="h-9 w-11 pl-3">
              <span className="sr-only">Quitar</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {ticket.lines.map((l) => (
            <LineRow
              key={l.id}
              ticket={ticket}
              line={l}
              product={productsById[l.productId]}
              choice={l.choiceProductId ? productsById[l.choiceProductId] : undefined}
              onChanged={onChanged}
            />
          ))}
        </tbody>
      </table>
    </div>
    </>
  )
}

type LineProps = {
  ticket: OpenTicket
  line: PosLine
  product: CachedProduct | undefined
  choice: CachedProduct | undefined
  onChanged: () => void
}

/** − cantidad + del renglón (respeta el stock disponible). */
function QuantityStepper({ ticket, line, product, choice, onChanged }: LineProps) {
  const [text, setText] = useState(String(line.quantity))
  useEffect(() => setText(String(line.quantity)), [line.quantity])
  const room = posStore.lineRoom(ticket.id, product, choice)
  const name = product?.name ?? 'Producto'

  function commit(value: number) {
    if (!product) return
    const q = posStore.setQuantity(ticket.id, line.id, Number.isFinite(value) ? value : line.quantity, product, choice)
    setText(String(q))
  }

  return (
    <div className="flex w-fit items-center gap-1">
      <button
        type="button"
        aria-label={`Quitar una pieza de ${name}`}
        disabled={line.quantity <= 1}
        onClick={() => commit(line.quantity - 1)}
        className="icon-btn"
      >
        −
      </button>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(Number(text))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(Number(text))
            onChanged()
          }
        }}
        inputMode="numeric"
        aria-label={`Cantidad de ${name}`}
        className="field h-control-sm w-14 px-1 text-center font-semibold tabular-nums max-md:h-8 max-md:w-11"
      />
      <button
        type="button"
        aria-label={`Agregar una pieza de ${name}`}
        disabled={!product || room <= 0}
        title={product && room <= 0 ? 'No hay más stock disponible' : undefined}
        onClick={() => commit(line.quantity + 1)}
        className="icon-btn"
      >
        +
      </button>
    </div>
  )
}

/** Renglón del ticket en el celular. */
function MobileLine(props: LineProps) {
  const { ticket, line, product, choice, onChanged } = props
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const name = product?.name ?? 'Producto'

  return (
    <li className="flex gap-3 py-3">
      <ProductImage path={product?.image_url ?? null} alt="" className="size-11 shrink-0 rounded-xs" />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-1">
          <p className="min-w-0 flex-1 font-semibold break-words text-ink">
            <LanguageTag language={product?.language} className="mr-1.5" />
            {name}
            {product?.is_preorder && <span className="ml-1.5 badge badge-warning align-middle">Preventa</span>}
          </p>
          <button
            type="button"
            onClick={() => {
              posStore.removeLine(ticket.id, line.id)
              onChanged()
            }}
            aria-label={`Quitar ${name} del ticket`}
            className="-mt-1 -mr-1 grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-ink-muted hover:bg-danger-bg hover:text-danger-fg"
          >
            <Icon name="x" />
          </button>
        </div>
        {line.choiceProductId && (
          <p className="text-caption text-ink-muted">
            Bebida: <span className="font-medium text-ink">{choice?.name ?? 'ya no existe'}</span>
          </p>
        )}
        {product?.is_preorder && (
          <p className="text-caption text-ink-muted">
            Anticipo mínimo {formatMoney(lineDeposit(line, product))} · {formatInt(Math.max(0, freeQuantity(product)))} libres en tienda
          </p>
        )}
        {!product && <p className="text-caption text-danger-fg">Este producto ya no está en el inventario.</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2">
          {isAdmin ? (
            <MobilePrice ticket={ticket} line={line} product={product} onChanged={onChanged} />
          ) : (
            <span className="text-caption text-ink-muted tabular-nums">{formatMoney(line.unitPrice)} c/u</span>
          )}
          <div className="ml-auto flex items-center gap-3">
            <QuantityStepper {...props} />
            <span className="min-w-20 text-right font-display text-base font-extrabold tabular-nums">
              {formatMoney(line.quantity * line.unitPrice)}
            </span>
          </div>
        </div>
      </div>
    </li>
  )
}

/**
 * Precio del renglón en el celular (admin): se muestra como texto con un
 * lápiz; al tocarlo aparece el campo para cambiarlo (solo en este ticket).
 */
function MobilePrice({ ticket, line, product, onChanged }: Omit<LineProps, 'choice'>) {
  const [editing, setEditing] = useState(false)
  const changed = product != null && line.unitPrice !== product.price
  if (editing) {
    return (
      <LinePrice
        ticket={ticket}
        line={line}
        product={product}
        autoFocus
        onDone={() => setEditing(false)}
        onChanged={onChanged}
      />
    )
  }
  return (
    <span className="flex items-center gap-1">
      <span className={`text-caption tabular-nums ${changed ? 'font-semibold text-ink' : 'text-ink-muted'}`}>
        {formatMoney(line.unitPrice)} c/u
      </span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Cambiar el precio de ${product?.name ?? 'producto'} en este ticket`}
        title="Cambiar precio (solo este ticket)"
        className="grid size-7 cursor-pointer place-items-center rounded-md text-ink-muted hover:bg-subtle hover:text-ink"
      >
        <Icon name="pencil" size={14} />
      </button>
      {changed && (
        <button
          type="button"
          onClick={() => {
            posStore.setPrice(ticket.id, line.id, product.price)
            onChanged()
          }}
          className="cursor-pointer text-caption text-ink-muted underline hover:text-ink"
        >
          Normal: {formatMoney(product.price)}
        </button>
      )}
    </span>
  )
}

function LineRow(props: LineProps) {
  const { ticket, line, product, choice, onChanged } = props
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const name = product?.name ?? 'Producto'

  return (
    <tr className="border-b border-line">
      <td className="py-3 pr-3">
        <div className="flex items-center gap-3">
          <ProductImage path={product?.image_url ?? null} alt="" className="size-10 shrink-0 rounded-xs" />
          <div className="min-w-40">
            <p className="font-semibold text-ink">
              <LanguageTag language={product?.language} className="mr-2" />
              {name}
              {product?.is_preorder && <span className="ml-2 badge badge-warning align-middle">Preventa</span>}
            </p>
            {line.choiceProductId && (
              <p className="text-caption text-ink-muted">
                Bebida: <span className="font-medium text-ink">{choice?.name ?? 'ya no existe'}</span>
              </p>
            )}
            {product?.is_preorder && (
              <p className="text-caption text-ink-muted">
                Anticipo mínimo {formatMoney(lineDeposit(line, product))} · {formatInt(Math.max(0, freeQuantity(product)))} libres en tienda
              </p>
            )}
            {product && <p className="font-mono text-caption text-ink-subtle">{product.barcode}</p>}
            {!product && <p className="text-caption text-danger-fg">Este producto ya no está en el inventario.</p>}
          </div>
        </div>
      </td>
      <td className="px-3 py-3 text-right text-ink-muted tabular-nums">
        {isAdmin ? <LinePrice ticket={ticket} line={line} product={product} onChanged={onChanged} /> : formatMoney(line.unitPrice)}
      </td>
      <td className="px-3 py-3">
        <div className="mx-auto w-fit">
          <QuantityStepper {...props} />
        </div>
      </td>
      <td className="px-3 py-3 text-right font-display text-lg font-extrabold tabular-nums">{formatMoney(line.quantity * line.unitPrice)}</td>
      <td className="py-3 pl-3">
        <button
          type="button"
          onClick={() => {
            posStore.removeLine(ticket.id, line.id)
            onChanged()
          }}
          aria-label={`Quitar ${name} del ticket`}
          className="grid size-11 cursor-pointer place-items-center rounded-md text-ink-muted hover:bg-danger-bg hover:text-danger-fg"
        >
          <Icon name="x" />
        </button>
      </td>
    </tr>
  )
}

/**
 * Precio editable del renglón (solo admin). Cambia el precio en este ticket
 * nada más: el del producto en el inventario y en otros tickets sigue igual.
 */
function LinePrice({
  ticket,
  line,
  product,
  onChanged,
  autoFocus,
  onDone,
}: {
  ticket: OpenTicket
  line: PosLine
  product: CachedProduct | undefined
  onChanged: () => void
  /** Celular: el campo aparece al tocar el lápiz y se cierra al terminar. */
  autoFocus?: boolean
  onDone?: () => void
}) {
  const [text, setText] = useState(String(line.unitPrice))
  useEffect(() => setText(String(line.unitPrice)), [line.unitPrice])
  const changed = product != null && line.unitPrice !== product.price

  function commit() {
    const price = parseMoney(text)
    if (price === null || Number.isNaN(price)) return setText(String(line.unitPrice))
    posStore.setPrice(ticket.id, line.id, price)
    setText(String(price))
  }

  function finish() {
    commit()
    onDone?.()
  }

  return (
    <div className="flex flex-col items-end gap-0.5 max-md:items-start">
      <div className="flex items-center gap-1">
        <span aria-hidden="true">$</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={finish}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              finish()
              onChanged()
            }
            if (e.key === 'Escape' && onDone) {
              setText(String(line.unitPrice))
              onDone()
            }
          }}
          autoFocus={autoFocus}
          onFocus={(e) => autoFocus && e.target.select()}
          inputMode="decimal"
          aria-label={`Precio de ${product?.name ?? 'producto'} en este ticket`}
          title="Precio solo para este ticket"
          className={`field h-control-sm w-24 px-2 text-right tabular-nums ${changed ? 'font-semibold text-ink' : ''}`}
        />
      </div>
      {changed && !onDone && (
        <button
          type="button"
          onClick={() => {
            posStore.setPrice(ticket.id, line.id, product.price)
            onChanged()
          }}
          className="cursor-pointer text-caption text-ink-muted underline hover:text-ink"
        >
          Normal: {formatMoney(product.price)}
        </button>
      )}
    </div>
  )
}
