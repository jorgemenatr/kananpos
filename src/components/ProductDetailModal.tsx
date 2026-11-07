import { useEffect, useState } from 'react'
import { useAuth } from '../auth/useAuth'
import { formatDateTime, formatInt, formatMoney } from '../lib/format'
import { getProductLots } from '../lib/lots'
import { formatUsd, suggestPrice, type CardCondition } from '../lib/pricing'
import { getCatalogName, getProduct } from '../lib/products'
import { productPriceHistory, usePricingRules, type PriceHistoryRow } from '../lib/singles'
import { isNetworkError } from '../lib/supabase'
import { LOCATION_LABELS, LOT_ORIGIN_LABELS, type Product, type ProductLot } from '../lib/types'
import { Icon } from './Icon'
import { LanguageTag } from './LanguageTag'
import { ProductImage } from './ProductImage'
import { SingleProductReference } from './singles/SuggestedPrice'

const dateFmt = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeZone: 'UTC' })

/**
 * Vista general de un producto (solo lectura): foto, datos, existencias,
 * lotes (admin) y, si es un single, su precio de referencia y el historial
 * del precio de mercado.
 */
export function ProductDetailModal({ productId, onClose, onEdit }: { productId: string; onClose: () => void; onEdit?: () => void }) {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [product, setProduct] = useState<Product | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lots, setLots] = useState<ProductLot[] | null>(null)
  const [catalogName, setCatalogName] = useState<string | null>(null)
  const [history, setHistory] = useState<PriceHistoryRow[] | null>(null)

  useEffect(() => {
    getProduct(productId)
      .then((p) => {
        if (!p) return setError('No se encontró el producto.')
        setProduct(p)
        if (p.catalog_product_id != null) void getCatalogName(p.catalog_product_id).then(setCatalogName)
        if (p.tcg_product_id != null) productPriceHistory(p.id).then(setHistory).catch(() => setHistory([]))
      })
      .catch((e) => setError(isNetworkError(e) ? 'Sin conexión: la vista del producto necesita internet.' : (e as Error).message))
    if (isAdmin) getProductLots(productId).then(setLots).catch(() => setLots([]))
  }, [productId, isAdmin])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const row = (label: string, value: React.ReactNode) =>
    value == null || value === '' ? null : (
      <div className="flex justify-between gap-4 py-1.5">
        <dt className="text-ink-muted">{label}</dt>
        <dd className="text-right text-ink">{value}</dd>
      </div>
    )

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4" role="dialog" aria-modal="true" aria-labelledby="pd-title" onClick={onClose}>
      <div className="max-h-full w-full max-w-3xl overflow-auto dialog" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <h2 id="pd-title" className="flex min-w-0 flex-wrap items-center gap-2 text-title">
            <LanguageTag language={product?.language} />
            <span className="break-words">{product?.name ?? 'Producto'}</span>
          </h2>
          <div className="flex shrink-0 gap-2">
            {onEdit && product && (
              <button type="button" onClick={onEdit} className="btn btn-secondary btn-sm">
                <Icon name="pencil" />
                Editar
              </button>
            )}
            <button type="button" onClick={onClose} className="btn btn-ghost">
              <Icon name="x" />
              Cerrar<span className="hidden md:inline"> (Esc)</span>
            </button>
          </div>
        </div>

        <div className="space-y-5 px-6 py-5">
          {error && <p className="notice bg-danger-bg text-danger-fg">{error}</p>}
          {!product && !error && <p className="py-6 text-center text-ink-subtle">Cargando producto…</p>}

          {product && (
            <>
              <div className="grid gap-5 sm:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
                <ProductImage
                  path={product.image_url}
                  alt={product.name}
                  className={`mx-auto w-full max-w-60 rounded-xs ${product.tcg_product_id ? 'aspect-[5/7]' : 'aspect-square'}`}
                />
                <dl className="divide-y divide-line">
                  {row('Precio de venta', <span className="text-label tabular-nums">{formatMoney(product.price)}</span>)}
                  {row('Código', <span className="font-mono">{product.barcode}</span>)}
                  {row('Categoría', product.category)}
                  {row(
                    'Existencias',
                    product.track_stock ? (
                      <span className="tabular-nums">
                        Tienda {formatInt(product.quantity)} · Bodega {formatInt(product.warehouse_quantity)}
                      </span>
                    ) : (
                      'Sin control de inventario'
                    ),
                  )}
                  {(product.preorder_reserved ?? 0) > 0 && row('Apartado en preventas', formatInt(product.preorder_reserved ?? 0))}
                  {row('Proveedor', product.supplier)}
                  {isAdmin && row('Último costo', product.cost == null ? null : formatMoney(product.cost))}
                  {row('Catálogo TCGplayer', catalogName)}
                  {product.is_preorder && row('Preventa', 'Sí')}
                  {product.is_combo && row('Combo', 'Incluye bebida')}
                  {row('Alta', formatDateTime(product.created_at))}
                </dl>
              </div>

              {product.description && <p className="text-caption whitespace-pre-line text-ink-muted">{product.description}</p>}

              {product.tcg_product_id != null && (
                <section className="space-y-2">
                  <h3 className="text-label">Precio de referencia</h3>
                  <SingleProductReference
                    product={product}
                    isAdmin={isAdmin}
                    onApplied={(price) => setProduct((p) => (p ? { ...p, price } : p))}
                  />
                </section>
              )}

              {product.tcg_product_id != null && (
                <PriceHistory history={history} condition={product.card_condition ?? null} subtype={product.tcg_subtype ?? null} />
              )}

              {isAdmin && lots && lots.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-label">Lotes con piezas</h3>
                  <p className="text-caption text-ink-muted">Las ventas salen de la tienda, del lote más viejo primero.</p>
                  <div className="overflow-x-auto border border-line">
                    <table className="w-full text-caption">
                      <thead className="bg-subtle text-left text-ink-muted">
                        <tr>
                          <th className="px-2 py-1 font-medium">Lote</th>
                          <th className="px-2 py-1 font-medium">Ubicación</th>
                          <th className="px-2 py-1 text-right font-medium">Piezas</th>
                          <th className="px-2 py-1 text-right font-medium">Costo</th>
                          <th className="px-2 py-1 font-medium">Proveedor</th>
                          <th className="px-2 py-1 font-medium">Entrada</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {lots.map((l) => (
                          <tr key={`${l.lot_id}-${l.location}`}>
                            <td className="px-2 py-1 tabular-nums">{l.number}</td>
                            <td className="px-2 py-1">{LOCATION_LABELS[l.location]}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{formatInt(l.quantity)}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{formatMoney(l.unit_cost)}</td>
                            <td className="px-2 py-1">{l.supplier_name ?? '—'}</td>
                            <td className="px-2 py-1">
                              {LOT_ORIGIN_LABELS[l.origin]} · {formatDateTime(l.received_at)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Tabla del historial del precio de mercado (solo los días en que cambió). */
function PriceHistory({
  history,
  condition,
  subtype,
}: {
  history: PriceHistoryRow[] | null
  condition: CardCondition | null
  subtype: string | null
}) {
  const rules = usePricingRules()
  return (
    <section className="space-y-2">
      <h3 className="text-label">Historial del precio de mercado{subtype ? ` · ${subtype}` : ''}</h3>
      <p className="text-caption text-ink-muted">
        Se registra cada día que cambia el precio de referencia (TCGplayer, en dólares), desde que la carta está en tu inventario.
        {rules.usdMxnRate != null && ' La columna en pesos usa tu tipo de cambio y tus reglas de hoy.'}
      </p>
      {!history && <p className="text-caption text-ink-subtle">Cargando…</p>}
      {history && !history.length && (
        <p className="border border-dashed border-line px-3 py-4 text-center text-caption text-ink-subtle">
          Todavía no hay historial: se empieza a llenar con la próxima actualización del catálogo.
        </p>
      )}
      {history && history.length > 0 && (
        <div className="max-h-72 overflow-auto border border-line">
          <table className="w-full text-caption">
            <thead className="sticky top-0 bg-subtle text-left text-ink-muted">
              <tr>
                <th className="px-2 py-1 font-medium">Fecha</th>
                <th className="px-2 py-1 text-right font-medium">Mercado (USD)</th>
                <th className="px-2 py-1 text-right font-medium">Medio (USD)</th>
                {rules.usdMxnRate != null && condition && <th className="px-2 py-1 text-right font-medium">Sugerido hoy ({condition})</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {history.map((h, i) => {
                const prev = history[i + 1]
                const s = condition ? suggestPrice({ marketUsd: h.market_usd, midUsd: h.mid_usd }, condition, rules) : null
                const trend =
                  prev && h.market_usd != null && prev.market_usd != null && h.market_usd !== prev.market_usd
                    ? h.market_usd > prev.market_usd
                      ? '▲'
                      : '▼'
                    : ''
                return (
                  <tr key={h.price_date}>
                    <td className="px-2 py-1">{dateFmt.format(new Date(`${h.price_date}T00:00:00Z`))}</td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {trend && <span className={trend === '▲' ? 'text-success-fg' : 'text-danger-fg'}>{trend} </span>}
                      {h.market_usd != null ? formatUsd(h.market_usd) : '—'}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">{h.mid_usd != null ? formatUsd(h.mid_usd) : '—'}</td>
                    {rules.usdMxnRate != null && condition && (
                      <td className="px-2 py-1 text-right tabular-nums">{s?.status === 'ok' ? formatMoney(s.price) : '—'}</td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
