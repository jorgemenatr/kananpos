import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { appTitle, useSettings } from '../lib/settings'
import { ROLE_LABELS } from '../lib/types'
import { inventoryStore } from '../store/inventoryStore'
import { useInventory } from '../store/useInventory'
import { ConnectionBadge } from './ConnectionBadge'
import { Icon, type IconName } from './Icon'
import { KananMark } from './KananMark'
import { ScannerSimulator, useSimulatorEnabled } from './ScannerSimulator'

interface NavItem {
  to: string
  label: string
  icon: IconName
  end?: boolean
  /** Solo para administradores. */
  admin?: boolean
  /** Solo mientras el inventario inicial esté abierto (Configuración). */
  initialLoad?: boolean
  /** Subsecciones: siempre visibles, debajo de la sección. */
  children?: NavItem[]
}

const NAV: NavItem[] = [
  { to: '/mostrador', label: 'Mostrador', icon: 'store' },
  { to: '/ventas', label: 'Ventas', icon: 'receipt' },
  { to: '/preventas', label: 'Preventas', icon: 'box' },
  { to: '/clientes', label: 'Clientes', icon: 'users' },
  {
    to: '/inventario',
    label: 'Inventario',
    icon: 'grid',
    children: [
      // El primer conteo del negocio; se esconde cuando el admin lo cierra.
      { to: '/inventario-inicial', label: 'Inventario inicial', icon: 'barcode', admin: true, initialLoad: true },
      // Mercancía que llega de un proveedor (también da de alta productos nuevos).
      { to: '/compras', label: 'Compras', icon: 'truck', admin: true },
      // Corregir lo que hay, con motivo.
      { to: '/conteo', label: 'Conteo y ajustes', icon: 'list', admin: true },
      { to: '/movimiento-bodega', label: 'Movimiento de bodega', icon: 'swap', admin: true },
      { to: '/historial', label: 'Historial', icon: 'history' },
    ],
  },
  { to: '/usuarios', label: 'Usuarios', icon: 'shield', admin: true },
  { to: '/configuracion', label: 'Configuración', icon: 'settings', admin: true },
]

/** Nombre de la sección actual (barra superior en el celular). */
function sectionLabel(pathname: string) {
  const all = NAV.flatMap((n) => [n, ...(n.children ?? [])])
  return all.find((n) => pathname === n.to || pathname.startsWith(`${n.to}/`))?.label ?? ''
}

export function Layout() {
  const { pathname } = useLocation()
  const { user, profile, signOut } = useAuth()
  const settings = useSettings()
  const { queue, online } = useInventory()
  // Menú lateral en el celular (en pantallas md+ siempre está visible).
  const [menuOpen, setMenuOpen] = useState(false)

  // Se cierra al navegar.
  useEffect(() => setMenuOpen(false), [pathname])

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])
  const navigate = useNavigate()
  const simulator = useSimulatorEnabled()
  const isAdmin = profile?.role === 'admin'
  const allowed = (n: NavItem) => (!n.admin || isAdmin) && (!n.initialLoad || settings.initialLoadOpen)

  async function handleSignOut() {
    if (queue.length > 0) {
      const ok = window.confirm(
        `Hay ${queue.length} operación(es) sin sincronizar.\n\n` +
          'Se quedarán guardadas en esta computadora y se enviarán cuando se vuelva a iniciar sesión con internet.\n\n' +
          '¿Cerrar sesión de todos modos?',
      )
      if (!ok) return
    }
    await signOut()
    inventoryStore.clearSessionData()
    navigate('/login', { replace: true })
  }

  const displayName = profile?.full_name || user?.email || ''
  const navItem = ({ isActive }: { isActive: boolean }) =>
    `flex h-control-md items-center gap-3 rounded-md px-2 text-body focus-visible:outline-nav-focus ${
      isActive ? 'bg-nav-active-bg font-medium text-nav-active-ink' : 'text-nav-ink hover:bg-nav-hover'
    }`

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* Celular: barra delgada con el botón del menú. */}
      <header className="flex h-14 shrink-0 items-center gap-2 bg-nav-bg px-2 text-nav-ink md:hidden print:hidden">
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label="Abrir menú"
          aria-expanded={menuOpen}
          aria-controls="menu-principal"
          className="grid size-11 cursor-pointer place-items-center rounded-md hover:bg-nav-hover focus-visible:outline-nav-focus"
        >
          <Icon name="menu" size={22} />
        </button>
        <span className="min-w-0 flex-1 truncate font-display text-heading font-extrabold uppercase">{sectionLabel(pathname) || appTitle(settings)}</span>
        {/* La K de Kanan a la derecha. En línea no lleva marca; sin conexión o con
            pendientes, un punto rojo / ámbar en su esquina. */}
        <span
          className="relative mr-2 shrink-0"
          title={!online ? 'Sin conexión' : queue.length > 0 ? 'Pendiente por sincronizar' : 'En línea'}
          role="img"
          aria-label={`Kanan · ${!online ? 'Sin conexión' : queue.length > 0 ? 'Pendiente por sincronizar' : 'En línea'}`}
        >
          <KananMark size={26} />
          {(!online || queue.length > 0) && (
            <span
              className={`absolute -top-1 -right-1 size-2.5 ring-2 ring-nav-bg ${!online ? 'bg-danger-solid' : 'bg-warning-solid'}`}
              aria-hidden
            />
          )}
        </span>
      </header>

      {menuOpen && (
        <div className="fixed inset-0 z-40 bg-scrim md:hidden print:hidden" onClick={() => setMenuOpen(false)} aria-hidden />
      )}

      <nav
        id="menu-principal"
        aria-label="Principal"
        className={`fixed inset-y-0 left-0 z-50 flex w-sidebar max-w-[85vw] shrink-0 flex-col gap-4 overflow-y-auto border-r border-nav-border bg-nav-bg p-4 text-nav-ink transition-transform duration-200 md:static md:z-auto md:max-w-none md:translate-x-0 md:transition-none print:hidden ${
          menuOpen ? 'translate-x-0' : 'invisible -translate-x-full md:visible'
        }`}
      >
        <div className="flex items-center gap-2 px-2 pt-1 pb-2">
          <KananMark size={32} className="shrink-0" />
          <span className="min-w-0 flex-1 font-display text-heading leading-tight font-extrabold">{appTitle(settings)}</span>
          <button
            type="button"
            onClick={() => setMenuOpen(false)}
            aria-label="Cerrar menú"
            className="grid size-control-md cursor-pointer place-items-center rounded-md text-nav-ink-muted hover:bg-nav-hover hover:text-nav-ink focus-visible:outline-nav-focus md:hidden"
          >
            <Icon name="x" size={20} />
          </button>
        </div>

        <div className="flex flex-col gap-0.5">
          {NAV.filter(allowed).map((n) => {
            const children = n.children?.filter(allowed)
            return (
              <div key={n.to}>
                <NavLink to={n.to} end={n.end} className={navItem} onClick={() => setMenuOpen(false)}>
                  <Icon name={n.icon} size={20} />
                  <span>{n.label}</span>
                </NavLink>
                {!!children?.length && (
                  <div className="mt-0.5 ml-4 flex flex-col gap-0.5 border-l border-nav-border pl-2">
                    {children!.map((c) => (
                      <NavLink key={c.to} to={c.to} end={c.end} className={navItem} onClick={() => setMenuOpen(false)}>
                        <Icon name={c.icon} size={18} />
                        <span>{c.label}</span>
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="mt-auto flex flex-col items-stretch gap-3">
          <ConnectionBadge />
          <div className="flex items-center gap-3 border-t border-nav-border px-2 pt-3">
            <span
              className="grid size-8 shrink-0 place-items-center rounded-md bg-nav-avatar-bg text-label text-on-brand uppercase"
              aria-hidden
            >
              {displayName.charAt(0) || '?'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium" title={user?.email}>
                {displayName}
              </p>
              {profile?.role && <p className="text-caption text-nav-ink-muted">{ROLE_LABELS[profile.role] ?? profile.role}</p>}
            </div>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              title="Cerrar sesión"
              aria-label="Cerrar sesión"
              className="grid size-control-md shrink-0 cursor-pointer place-items-center rounded-md text-nav-ink-muted hover:bg-nav-hover hover:text-nav-ink focus-visible:outline-nav-focus"
            >
              <Icon name="log-out" size={18} />
            </button>
          </div>
        </div>
      </nav>
      {/* En el celular nada puede ensanchar la pantalla (sin scroll horizontal). */}
      <main className="min-h-0 min-w-0 flex-1 overflow-auto max-md:overflow-x-hidden">
        <Outlet />
      </main>
      {simulator && <ScannerSimulator />}
    </div>
  )
}
