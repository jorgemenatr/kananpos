import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CreditsModal } from '../components/CreditsModal'
import { CustomerFormModal } from '../components/CustomerFormModal'
import { FiltersButton } from '../components/FiltersButton'
import { GameTags } from '../components/GamesInput'
import { Icon } from '../components/Icon'
import { LeaguePointsModal } from '../components/LeaguePointsModal'
import { MoreMenu } from '../components/MoreMenu'
import { customerSearchText, gameSuggestions, listCustomers } from '../lib/customers'
import { listCreditBalances } from '../lib/credits'
import { formatInt, formatMoney } from '../lib/format'
import { formatPoints, listLeagueTotals } from '../lib/league'
import { isNetworkError } from '../lib/supabase'
import type { CreditBalance, Customer } from '../lib/types'

const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

export function CustomersPage() {
  const navigate = useNavigate()
  const [customers, setCustomers] = useState<Customer[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [game, setGame] = useState('')
  // En el celular la búsqueda y el filtro van plegados.
  const [showFilters, setShowFilters] = useState(false)
  const [creating, setCreating] = useState(false)
  const [granting, setGranting] = useState(false)
  const [balances, setBalances] = useState<Map<string, CreditBalance> | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [league, setLeague] = useState<Map<string, number> | null>(null)
  // Puntos de liga: a un cliente (renglón) o a varios ('many'); null = cerrado.
  const [pointsFor, setPointsFor] = useState<Customer | 'many' | null>(null)

  // Saldos de créditos (si falla, la lista se ve igual, sin la columna llena).
  const loadBalances = () => {
    listCreditBalances()
      .then(setBalances)
      .catch(() => undefined)
  }
  useEffect(loadBalances, [])

  const loadLeague = () => {
    listLeagueTotals()
      .then(setLeague)
      .catch(() => undefined)
  }
  useEffect(loadLeague, [])

  useEffect(() => {
    listCustomers()
      .then(setCustomers)
      .catch((e) => setError(isNetworkError(e) ? 'Sin conexión: no se pueden cargar los clientes.' : (e as Error).message))
  }, [])

  const suggestions = useMemo(() => gameSuggestions(customers ?? []), [customers])
  const gamesInUse = useMemo(
    () => [...new Set((customers ?? []).flatMap((c) => c.games))].sort((a, b) => a.localeCompare(b, 'es-MX')),
    [customers],
  )

  const filtered = useMemo(() => {
    const words = normalize(search.trim()).split(/\s+/).filter(Boolean)
    return (customers ?? []).filter((c) => {
      if (game && !c.games.includes(game)) return false
      const text = normalize(customerSearchText(c))
      return words.every((w) => text.includes(w))
    })
  }, [customers, search, game])

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="hidden mr-auto text-title-lg uppercase md:block">Clientes</h1>
        <FiltersButton open={showFilters} active={!!search.trim() || !!game} onToggle={() => setShowFilters((v) => !v)} className="mr-auto" />
        <button type="button" onClick={() => setCreating(true)} className="btn btn-primary">
          <Icon name="plus" />
          Nuevo cliente
        </button>
        {!!customers?.length && (
          <MoreMenu
            items={[
              { label: 'Agregar puntos de liga', icon: 'trophy', onClick: () => setPointsFor('many') },
              { label: 'Agregar créditos', icon: 'plus', onClick: () => setGranting(true) },
            ]}
          />
        )}
      </div>

      <div className={`flex flex-wrap items-center gap-3 ${showFilters ? '' : 'max-md:hidden'}`}>
        <label className="search-field w-full max-w-sm">
          <Icon name="search" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, correo, teléfono o código"
            aria-label="Buscar por nombre, correo, teléfono o código"
            className="min-w-0 flex-1 bg-transparent text-ink outline-none focus-visible:outline-none"
          />
        </label>
        <select value={game} onChange={(e) => setGame(e.target.value)} aria-label="Juego" className="field w-auto min-w-44 cursor-pointer">
          <option value="">Todos los juegos</option>
          {gamesInUse.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        {customers && (
          <span className="text-caption text-ink-muted">
            {formatInt(filtered.length)} de {formatInt(customers.length)} clientes
          </span>
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
      {!customers && !error && <p className="py-10 text-center text-ink-subtle">Cargando clientes…</p>}

      {customers && (
        <div className="card overflow-x-auto">
          {/* Celular: una tarjeta por cliente. */}
          <ul className="divide-y divide-line md:hidden">
            {filtered.map((c) => (
              <li key={c.id} className="flex items-start gap-2 px-4 py-3">
                <Link to={`/clientes/${c.id}`} className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium">
                    {c.name}
                    {(c.nicknames ?? []).length > 0 && <span className="ml-2 text-caption text-ink-muted">“{c.nicknames.join('”, “')}”</span>}
                    {c.code && <span className="ml-2 font-mono text-caption text-ink-subtle">{c.code}</span>}
                  </p>
                  {(c.phone || c.email) && (
                    <p className="text-caption break-all text-ink-muted">{[c.phone, c.email].filter(Boolean).join(' · ')}</p>
                  )}
                  {c.games.length > 0 && <GameTags games={c.games} max={4} />}
                  <p className="flex flex-wrap gap-x-3 text-caption text-ink-muted tabular-nums">
                    <span>
                      Puntos:{' '}
                      <span className="font-semibold text-gold-ink">{!league ? '…' : (league.get(c.id) ?? 0).toLocaleString('es-MX')}</span>
                    </span>
                    <span>
                      Créditos:{' '}
                      <span className="font-semibold text-gold-ink">{!balances ? '…' : formatMoney(balances.get(c.id)?.balance ?? 0)}</span>
                    </span>
                  </p>
                </Link>
              </li>
            ))}
          </ul>
          <table className="hidden w-full border-collapse text-left md:table">
            <thead>
              <tr className="thead-row">
                <th className="h-control-md px-4 font-medium">Nombre</th>
                <th className="h-control-md px-4 font-medium">Código</th>
                <th className="h-control-md px-4 font-medium">Teléfono</th>
                <th className="h-control-md px-4 font-medium">Correo</th>
                <th className="h-control-md px-4 font-medium">Juegos que juega</th>
                <th className="h-control-md px-4 text-right font-medium">Puntos de liga</th>
                <th className="h-control-md px-4 text-right font-medium">Créditos</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="cursor-pointer border-t border-line hover:bg-subtle" onClick={() => navigate(`/clientes/${c.id}`)}>
                  <td className="h-row px-4 font-medium">
                    <Link to={`/clientes/${c.id}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                      {c.name}
                    </Link>
                    {(c.nicknames ?? []).length > 0 && <span className="ml-2 text-caption font-normal text-ink-muted">“{c.nicknames.join('”, “')}”</span>}
                  </td>
                  <td className="h-row px-4 font-mono whitespace-nowrap text-ink-muted">{c.code ?? '—'}</td>
                  <td className="h-row px-4 whitespace-nowrap text-ink-muted">{c.phone ?? '—'}</td>
                  <td className="h-row px-4 text-ink-muted">{c.email ?? '—'}</td>
                  <td className="h-row px-4 py-2">
                    <GameTags games={c.games} max={4} />
                  </td>
                  <td className="h-row px-4 text-right whitespace-nowrap tabular-nums">
                    {!league ? '…' : (league.get(c.id) ?? 0) !== 0 ? (
                      <span className="font-display font-extrabold text-gold-ink">{(league.get(c.id) ?? 0).toLocaleString('es-MX')}</span>
                    ) : (
                      <span className="text-ink-subtle">—</span>
                    )}
                  </td>
                  <td className="h-row px-4 text-right whitespace-nowrap tabular-nums">
                    {!balances ? '…' : (balances.get(c.id)?.balance ?? 0) > 0 ? (
                      <span className="font-display font-extrabold text-gold-ink">{formatMoney(balances.get(c.id)!.balance)}</span>
                    ) : (
                      <span className="text-ink-subtle">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <p className="px-4 py-10 text-center text-ink-subtle">
              {customers.length === 0 ? 'Aún no hay clientes. Da de alta el primero con "Nuevo cliente".' : 'Ningún cliente coincide con la búsqueda.'}
            </p>
          )}
        </div>
      )}

      {granting && customers && (
        <CreditsModal
          customers={customers}
          onCancel={() => setGranting(false)}
          onSaved={(r) => {
            setGranting(false)
            setSaved(`Se agregaron ${formatMoney(r.total)} en créditos a ${r.count} cliente(s).`)
            loadBalances()
          }}
        />
      )}

      {pointsFor && customers && (
        <LeaguePointsModal
          customers={customers}
          fixedCustomer={pointsFor === 'many' ? undefined : pointsFor}
          onCancel={() => setPointsFor(null)}
          onSaved={(r) => {
            setPointsFor(null)
            setSaved(`Se registraron ${formatPoints(r.total)} puntos de liga a ${r.count} cliente(s).`)
            loadLeague()
          }}
        />
      )}

      {creating && (
        <CustomerFormModal
          customer={null}
          gameSuggestions={suggestions}
          initialName={search.trim()}
          onCancel={() => setCreating(false)}
          onSaved={(c) => {
            setCreating(false)
            setCustomers((prev) => [...(prev ?? []), c].sort((a, b) => a.name.localeCompare(b.name, 'es-MX')))
            navigate(`/clientes/${c.id}`)
          }}
        />
      )}
    </div>
  )
}
