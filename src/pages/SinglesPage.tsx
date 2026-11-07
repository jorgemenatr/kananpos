import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { LocationSelect } from '../components/LocationSelect'
import { ProductImage } from '../components/ProductImage'
import { Segmented } from '../components/Segmented'
import { SupplierSelect } from '../components/SupplierSelect'
import { SuggestedPriceLine, breakdownText, suggestionFor } from '../components/singles/SuggestedPrice'
import { formatInt, formatMoney, parseCount, parseMoney } from '../lib/format'
import { CONDITIONS, CONDITION_LABELS, formatUsd, marginPct, type CardCondition } from '../lib/pricing'
import {
  addSingleStock,
  listGames,
  searchSingles,
  singleVariants,
  usePricingRules,
  type SingleSearchResult,
  type SingleVariant,
  type TcgGameSetting,
} from '../lib/singles'
import { isNetworkError } from '../lib/supabase'
import { LANGUAGE_LABELS, LANGUAGES, type ProductLanguage, type StockLocation } from '../lib/types'
import { inventoryStore } from '../store/inventoryStore'

const errorText = (e: unknown) =>
  isNetworkError(e) ? 'Sin conexión: el alta de singles necesita internet.' : (e as Error).message

/** Alta de singles: buscar la carta, elegir la variante y meter piezas como una compra (lote FIFO). */
export function SinglesPage() {
  // Las reglas de precio se cargan desde que se abre la página (listas al elegir una carta).
  usePricingRules()
  const [games, setGames] = useState<TcgGameSetting[] | null>(null)
  const [gameId, setGameId] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SingleSearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [card, setCard] = useState<SingleSearchResult | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    listGames()
      .then((g) => setGames(g.filter((x) => x.enabled)))
      .catch((e) => setSearchError(errorText(e)))
  }, [])

  // Búsqueda con pausa: espera a que dejes de escribir (mín. 2 letras).
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setResults(null)
      setSearching(false)
      return
    }
    const my = ++seq.current
    setSearching(true)
    const t = setTimeout(() => {
      searchSingles(q, gameId)
        .then((r) => {
          if (my !== seq.current) return
          setResults(r)
          setSearchError(null)
        })
        .catch((e) => my === seq.current && setSearchError(errorText(e)))
        .finally(() => my === seq.current && setSearching(false))
    }, 300)
    return () => clearTimeout(t)
  }, [query, gameId])

  const noGames = games && !games.length

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div>
        <h1 className="hidden text-title-lg uppercase md:block">Alta de singles</h1>
        <p className="text-caption text-ink-muted">
          Busca la carta, elige tipo, estado e idioma, y registra las piezas con su costo y proveedor (entran como una compra, con
          su propio lote).
        </p>
      </div>

      {noGames && (
        <p className="notice bg-warning-bg text-warning-fg">
          <Icon name="alert" className="mt-0.5" />
          <span>
            No hay juegos activos.{' '}
            <Link to="/configuracion#singles" className="underline">
              Actívalos en Configuración → Singles y juegos
            </Link>
            .
          </span>
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <section className="card flex min-w-0 flex-col gap-3 p-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <label className="field-label" htmlFor="sg-q">
                Buscar carta
              </label>
              <div className="relative">
                <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-subtle" />
                <input
                  id="sg-q"
                  className="field pl-9"
                  placeholder="Nombre, set o número (p. ej. charizard 151, 199/165)"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  disabled={!!noGames}
                />
              </div>
            </div>
            {games && games.length > 1 && (
              <div>
                <label className="field-label" htmlFor="sg-game">
                  Juego
                </label>
                <select
                  id="sg-game"
                  className="field cursor-pointer"
                  value={gameId ?? ''}
                  onChange={(e) => setGameId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">Todos los activos</option>
                  {games.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.display_name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          {searchError && <p className="text-caption text-danger-fg">{searchError}</p>}
          {searching && <p className="text-caption text-ink-subtle">Buscando…</p>}
          {!searching && results && !results.length && (
            <p className="py-6 text-center text-ink-subtle">No encontré cartas con "{query.trim()}" en tus juegos activos.</p>
          )}
          {results && results.length > 0 && (
            <ul className="flex max-h-[65vh] flex-col divide-y divide-line overflow-auto border border-line">
              {results.map((r) => {
                const ref = r.prices.find((p) => p.market_usd != null) ?? r.prices[0]
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setCard(r)}
                      className={`flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left ${card?.id === r.id ? 'bg-brand-soft' : 'hover:bg-subtle'}`}
                    >
                      <ProductImage path={r.image_url} alt="" className="h-14 w-10 shrink-0 rounded-xs" />
                      <div className="min-w-0 flex-1">
                        <p className="text-label break-words text-ink">
                          {r.name}
                          {r.number && <span className="ml-1 font-normal text-ink-muted">{r.number}</span>}
                        </p>
                        <p className="truncate text-caption text-ink-muted">
                          {r.set_name}
                          {r.rarity ? ` · ${r.rarity}` : ''} · {r.game_name}
                        </p>
                      </div>
                      {ref && (ref.market_usd ?? ref.mid_usd) != null && (
                        <span className="shrink-0 text-caption text-ink-muted tabular-nums">{formatUsd((ref.market_usd ?? ref.mid_usd) as number)}</span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="card min-w-0 p-4">
          {card ? (
            <SingleEntryForm key={card.id} card={card} />
          ) : (
            <p className="py-10 text-center text-ink-subtle">Elige una carta de la búsqueda.</p>
          )}
        </section>
      </div>
    </div>
  )
}

function SingleEntryForm({ card }: { card: SingleSearchResult }) {
  const rules = usePricingRules()
  const subtypes = useMemo(() => {
    const list = card.prices.map((p) => p.subtype)
    return list.length ? list : ['Normal']
  }, [card])
  const [subtype, setSubtype] = useState(subtypes[0])
  const [condition, setCondition] = useState<CardCondition>('NM')
  const [language, setLanguage] = useState<ProductLanguage>(/jap/i.test(card.game_name) ? 'ja' : 'en')
  const [quantity, setQuantity] = useState('1')
  const [cost, setCost] = useState('')
  const [supplierId, setSupplierId] = useState<string | null>(null)
  const [location, setLocation] = useState<StockLocation>('store')
  const [folio, setFolio] = useState('')
  const [price, setPrice] = useState('')
  const [priceTouched, setPriceTouched] = useState(false)
  const [variants, setVariants] = useState<SingleVariant[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // Mismo id mientras se reintenta la misma alta (no duplica si se cae la red).
  const opId = useRef(crypto.randomUUID())

  const loadVariants = () => {
    singleVariants(card.id)
      .then(setVariants)
      .catch(() => setVariants([]))
  }
  useEffect(loadVariants, [card.id])

  const ref = card.prices.find((p) => p.subtype === subtype) ?? null
  const reference = ref ? { market_usd: ref.market_usd, mid_usd: ref.mid_usd, prices_as_of: card.prices_as_of } : null
  const suggestion = suggestionFor(reference, condition, rules)
  const existing = variants?.find((v) => v.tcg_subtype === subtype && v.card_condition === condition && v.language === language) ?? null

  // El precio de una variante nueva se llena con el sugerido (hasta que lo edites).
  useEffect(() => {
    if (!priceTouched) setPrice(suggestion.status === 'ok' ? suggestion.price.toFixed(2) : '')
  }, [suggestion.status === 'ok' ? suggestion.price : null, priceTouched])

  const qty = parseCount(quantity, 0)
  const unitCost = parseMoney(cost)
  const salePrice = existing ? existing.price : parseMoney(price)
  const margin = salePrice != null && !Number.isNaN(salePrice) && unitCost != null && !Number.isNaN(unitCost) ? marginPct(salePrice, unitCost) : null

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (saving) return
    setMsg(null)
    if (Number.isNaN(qty)) return setMsg({ ok: false, text: 'Escribe la cantidad (0 o más).' })
    if (qty > 0 && (unitCost == null || Number.isNaN(unitCost))) return setMsg({ ok: false, text: 'Escribe el costo de compra por pieza.' })
    if (qty > 0 && !supplierId) return setMsg({ ok: false, text: 'Elige el proveedor.' })
    if (!existing && (salePrice == null || Number.isNaN(salePrice))) return setMsg({ ok: false, text: 'Escribe el precio de venta.' })
    if (!existing && qty === 0 && !window.confirm('¿Dar de alta la variante sin piezas?')) return
    setSaving(true)
    try {
      const r = await addSingleStock({
        opId: opId.current,
        tcgProductId: card.id,
        subtype,
        condition,
        language,
        quantity: qty,
        unitCost: qty > 0 ? unitCost : null,
        supplierId: qty > 0 ? supplierId : null,
        location,
        price: existing ? null : salePrice,
        folio,
      })
      opId.current = crypto.randomUUID()
      const where = location === 'store' ? 'tienda' : 'bodega'
      setMsg({
        ok: true,
        text:
          qty > 0
            ? `Se agregaron ${formatInt(qty)} pieza(s) a ${where}: ${r.product.name} (${r.product.barcode}).`
            : `Se dio de alta ${r.product.name} (${r.product.barcode}).`,
      })
      setQuantity('1')
      setPriceTouched(false)
      loadVariants()
      void inventoryStore.refreshProducts()
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="flex gap-4">
        <ProductImage path={card.image_url} alt={card.name} className="h-40 w-28 shrink-0 rounded-xs" />
        <div className="min-w-0">
          <h2 className="text-title break-words">{card.name}</h2>
          <p className="text-caption text-ink-muted">
            {card.set_name}
            {card.number ? ` · ${card.number}` : ''}
            {card.rarity ? ` · ${card.rarity}` : ''}
          </p>
          <p className="text-caption text-ink-muted">{card.game_name}</p>
          {card.prices.length > 0 && (
            <ul className="mt-2 text-caption text-ink-muted">
              {card.prices.map((p) => (
                <li key={p.subtype}>
                  {p.subtype}:{' '}
                  <span className="text-ink tabular-nums">
                    {p.market_usd != null ? formatUsd(p.market_usd) : p.mid_usd != null ? `${formatUsd(p.mid_usd)} (medio)` : '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {variants && variants.length > 0 && (
        <div>
          <p className="field-label">En inventario</p>
          <ul className="divide-y divide-line border border-line text-caption">
            {variants.map((v) => (
              <li key={v.product_id} className="flex flex-wrap items-center gap-x-3 px-2 py-1">
                <span className="text-ink">
                  {v.tcg_subtype} · {v.card_condition} · {LANGUAGE_LABELS[v.language]}
                </span>
                <span className="font-mono text-ink-subtle">{v.barcode}</span>
                <span className="ml-auto tabular-nums">
                  {formatInt(v.quantity)} tienda · {formatInt(v.warehouse_quantity)} bodega · {formatMoney(v.price)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {subtypes.length > 1 && (
          <div>
            <p className="field-label">Tipo de impresión</p>
            <Segmented label="Tipo de impresión" value={subtype} onChange={setSubtype} options={subtypes.map((s) => ({ value: s, label: s }))} />
          </div>
        )}
        <div>
          <p className="field-label">Estado</p>
          <Segmented<CardCondition>
            label="Estado de la carta"
            value={condition}
            onChange={setCondition}
            options={CONDITIONS.map((c) => ({ value: c, label: c }))}
          />
          <p className="mt-1 text-caption text-ink-subtle">
            {CONDITION_LABELS[condition]} · {rules.conditionPercentages[condition]}% del precio NM
          </p>
        </div>
        <div>
          <p className="field-label">Idioma</p>
          <Segmented<ProductLanguage>
            label="Idioma de la carta"
            value={language}
            onChange={setLanguage}
            options={LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_LABELS[l] }))}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="field-label" htmlFor="sg-qty">
            Cantidad
          </label>
          <input id="sg-qty" className="field tabular-nums" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
        <div>
          <label className="field-label" htmlFor="sg-cost">
            Costo de compra por pieza
          </label>
          <input id="sg-cost" className="field tabular-nums" inputMode="decimal" placeholder="0.00" value={cost} onChange={(e) => setCost(e.target.value)} />
        </div>
        <div>
          <label className="field-label" htmlFor="sg-sup">
            Proveedor
          </label>
          <SupplierSelect id="sg-sup" value={supplierId} onChange={(id) => setSupplierId(id)} />
        </div>
        <div>
          <label className="field-label" htmlFor="sg-folio">
            Folio (opcional)
          </label>
          <input id="sg-folio" className="field" value={folio} onChange={(e) => setFolio(e.target.value)} maxLength={60} />
        </div>
      </div>
      <div>
        <p className="field-label">Llega a</p>
        <LocationSelect value={location} onChange={setLocation} label="Llega a" />
      </div>

      <div className="flex flex-col gap-1 border border-line bg-subtle p-3">
        {existing ? (
          <>
            <p>
              <span className="text-caption text-ink-muted">Precio de venta actual </span>
              <span className="text-label tabular-nums">{formatMoney(existing.price)}</span>
            </p>
            <p className="text-caption text-ink-subtle">
              Esta variante ya existe: las piezas se suman y el precio no cambia. Para cambiarlo usa{' '}
              <Link to="/revisar-precios" className="underline">
                Revisar precios
              </Link>{' '}
              o la ficha del producto.
            </p>
          </>
        ) : (
          <div className="max-w-48">
            <label className="field-label" htmlFor="sg-price">
              Precio de venta *
            </label>
            <input
              id="sg-price"
              className="field tabular-nums"
              inputMode="decimal"
              value={price}
              onChange={(e) => {
                setPrice(e.target.value)
                setPriceTouched(true)
              }}
            />
          </div>
        )}
        <SuggestedPriceLine suggestion={suggestion} asOf={card.prices_as_of} isAdmin />
        {suggestion.status === 'ok' && <p className="text-caption whitespace-pre-line text-ink-muted">{breakdownText(suggestion)}</p>}
        {!existing && priceTouched && suggestion.status === 'ok' && (
          <button
            type="button"
            className="self-start text-caption underline"
            onClick={() => {
              setPriceTouched(false)
              setPrice(suggestion.price.toFixed(2))
            }}
          >
            Usar el sugerido ({formatMoney(suggestion.price)})
          </button>
        )}
        {margin != null && unitCost != null && salePrice != null && (
          <p className="text-caption text-ink-muted">
            Costo {formatMoney(unitCost)} · Venta {formatMoney(salePrice)} · Margen{' '}
            <span className={margin < 0 ? 'text-danger-fg' : 'text-ink'}>{Math.round(margin)}%</span>
          </p>
        )}
      </div>

      <div>
        <button type="submit" className="btn btn-primary btn-lg w-full sm:w-auto" disabled={saving}>
          <Icon name="plus" size={20} />
          {saving ? 'Guardando…' : qty > 0 ? `Agregar ${formatInt(qty)} pieza(s)` : 'Dar de alta'}
        </button>
      </div>
      {msg && (
        <p className={`notice ${msg.ok ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg'}`} role="status">
          <Icon name={msg.ok ? 'check' : 'alert'} className="mt-0.5" />
          {msg.text}
        </p>
      )}
    </form>
  )
}
