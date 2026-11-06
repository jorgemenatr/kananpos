import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../auth/useAuth'
import { Icon } from '../components/Icon'
import { formatDateTime } from '../lib/format'
import { PASSWORD_RULE, passwordProblem } from '../lib/password'
import { isNetworkError } from '../lib/supabase'
import { ROLE_LABELS, type Profile, type UserRole } from '../lib/types'
import { createUser, listUsers, setUserDisabled, updateUser } from '../lib/users'

const ROLES: UserRole[] = ['admin', 'mostrador']

const ROLE_HELP: Record<UserRole, string> = {
  admin: 'Todo, incluido agregar y editar inventario y administrar usuarios.',
  mostrador: 'Vender (también con otro precio en el ticket), dar de alta clientes, créditos y puntos de liga. No puede agregar ni editar inventario.',
}

const byName = (a: Profile, b: Profile) => (a.full_name || a.email).localeCompare(b.full_name || b.email, 'es-MX')

/** Activo / Desactivado (sin dato si falta la migración de usuarios desactivados). */
function AccessBadge({ user }: { user: Profile }) {
  if (user.disabled === undefined) return null
  return user.disabled ? (
    <span className="badge badge-danger">Desactivado</span>
  ) : (
    <span className="badge badge-success">Activo</span>
  )
}

/** Usuarios de la app (solo administradores): alta con nombre, correo y rol. */
export function UsersPage() {
  const { user } = useAuth()
  const [users, setUsers] = useState<Profile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [editing, setEditing] = useState<Profile | 'new' | null>(null)

  useEffect(() => {
    listUsers()
      .then((u) => setUsers(u.sort(byName)))
      .catch((e) => setError(isNetworkError(e) ? 'Sin conexión: no se pueden cargar los usuarios.' : (e as Error).message))
  }, [])

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="hidden mr-auto text-title-lg uppercase md:block">Usuarios</h1>
        <button
          type="button"
          onClick={() => {
            setSaved(null)
            setEditing('new')
          }}
          className="btn btn-primary"
        >
          <Icon name="plus" />
          Nuevo usuario
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {ROLES.map((r) => (
          <div key={r} className="card p-4">
            <p className="text-label">{ROLE_LABELS[r]}</p>
            <p className="text-caption text-ink-muted">{ROLE_HELP[r]}</p>
          </div>
        ))}
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
      {!users && !error && <p className="py-10 text-center text-ink-subtle">Cargando usuarios…</p>}

      {users && (
        <div className="card overflow-x-auto">
          {/* Celular: una tarjeta por usuario. */}
          <ul className="divide-y divide-line md:hidden">
            {users.map((u) => (
              <li key={u.id} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium">
                    {u.full_name || '—'}
                    {u.id === user?.id && <span className="ml-2 text-caption font-normal text-ink-subtle">(tú)</span>}
                  </p>
                  <p className="break-all text-ink-muted">{u.email}</p>
                  <div className="flex flex-wrap items-center gap-2 text-caption text-ink-muted">
                    <span className={`badge ${u.role === 'admin' ? 'badge-info' : 'badge-neutral'}`}>{ROLE_LABELS[u.role] ?? u.role}</span>
                    <AccessBadge user={u} />
                    {u.created_at && <span>Alta {formatDateTime(u.created_at)}</span>}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSaved(null)
                    setEditing(u)
                  }}
                  title="Editar usuario"
                  aria-label={`Editar ${u.full_name || u.email}`}
                  className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-md text-ink-muted hover:bg-subtle hover:text-ink"
                >
                  <Icon name="pencil" />
                </button>
              </li>
            ))}
          </ul>
          <table className="hidden w-full border-collapse text-left md:table">
            <thead>
              <tr className="thead-row">
                <th className="h-control-md px-4 font-medium">Nombre</th>
                <th className="h-control-md px-4 font-medium">Correo</th>
                <th className="h-control-md px-4 font-medium">Rol</th>
                <th className="h-control-md px-4 font-medium">Estado</th>
                <th className="h-control-md px-4 font-medium">Alta</th>
                <th className="h-control-md w-12 px-2 font-medium">
                  <span className="sr-only">Editar</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={`border-t border-line ${u.disabled ? 'text-ink-subtle' : ''}`}>
                  <td className="h-row px-4 font-medium">
                    {u.full_name || '—'}
                    {u.id === user?.id && <span className="ml-2 text-caption font-normal text-ink-subtle">(tú)</span>}
                  </td>
                  <td className="h-row px-4 text-ink-muted">{u.email}</td>
                  <td className="h-row px-4">
                    <span className={`badge ${u.role === 'admin' ? 'badge-info' : 'badge-neutral'}`}>{ROLE_LABELS[u.role] ?? u.role}</span>
                  </td>
                  <td className="h-row px-4">
                    <AccessBadge user={u} />
                  </td>
                  <td className="h-row px-4 whitespace-nowrap text-ink-muted">{u.created_at ? formatDateTime(u.created_at) : '—'}</td>
                  <td className="h-row px-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSaved(null)
                        setEditing(u)
                      }}
                      title="Editar usuario"
                      aria-label={`Editar ${u.full_name || u.email}`}
                      className="grid size-8 cursor-pointer place-items-center rounded-md text-ink-muted hover:bg-subtle hover:text-ink"
                    >
                      <Icon name="pencil" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <UserFormModal
          user={editing === 'new' ? null : editing}
          isSelf={editing !== 'new' && editing.id === user?.id}
          onCancel={() => setEditing(null)}
          onAccessChanged={(p) => {
            setEditing(null)
            setUsers((prev) => (prev ?? []).map((u) => (u.id === p.id ? p : u)))
            setSaved(
              p.disabled
                ? `Se desactivó a ${p.full_name || p.email}: ya no puede entrar y se cerraron sus sesiones.`
                : `Se reactivó a ${p.full_name || p.email}: ya puede volver a iniciar sesión.`,
            )
          }}
          onSaved={(p, isNew) => {
            setEditing(null)
            setUsers((prev) => {
              const old = prev?.find((u) => u.id === p.id)
              const merged = old ? { ...old, ...p } : p
              return [...(prev ?? []).filter((u) => u.id !== p.id), merged].sort(byName)
            })
            setSaved(
              isNew
                ? `Se creó el usuario ${p.email}. Compártele la contraseña temporal: al entrar por primera vez se le pedirá cambiarla.`
                : `Se guardaron los cambios de ${p.full_name || p.email}.`,
            )
          }}
        />
      )}
    </div>
  )
}

function UserFormModal({
  user,
  isSelf,
  onCancel,
  onSaved,
  onAccessChanged,
}: {
  /** null = usuario nuevo. */
  user: Profile | null
  /** El usuario es quien tiene la sesión (no se puede desactivar). */
  isSelf: boolean
  onCancel: () => void
  onSaved: (profile: Profile, isNew: boolean) => void
  onAccessChanged: (profile: Profile) => void
}) {
  const [name, setName] = useState(user?.full_name ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [role, setRole] = useState<UserRole>(user?.role ?? 'mostrador')
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggleAccess() {
    if (!user || saving) return
    const disable = !user.disabled
    const who = user.full_name || user.email
    const ok = window.confirm(
      disable
        ? `¿Desactivar a ${who}?\n\nNo podrá iniciar sesión y se cerrarán sus sesiones abiertas en todos los dispositivos. Sus ventas y movimientos se conservan. Puedes reactivarlo después.`
        : `¿Reactivar a ${who}?\n\nPodrá volver a iniciar sesión con su contraseña.`,
    )
    if (!ok) return
    setError(null)
    setSaving(true)
    try {
      await setUserDisabled(user.id, disable)
      onAccessChanged({ ...user, disabled: disable })
    } catch (err) {
      setError(isNetworkError(err) ? 'Sin conexión: intenta cuando vuelva el internet.' : (err as Error).message)
      setSaving(false)
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (saving) return
    setError(null)
    if (!name.trim()) return setError('El nombre es obligatorio.')
    if (!user) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setError('El correo no parece válido.')
      const problem = passwordProblem(password)
      if (problem) return setError(problem)
    }
    setSaving(true)
    try {
      if (user) onSaved(await updateUser(user.id, { full_name: name, role }), false)
      else onSaved(await createUser({ full_name: name, email, role, password }), true)
    } catch (err) {
      setError(isNetworkError(err) ? 'Sin conexión: intenta cuando vuelva el internet.' : (err as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4" role="dialog" aria-modal="true" aria-labelledby="uf-title">
      <form
        noValidate
        onSubmit={onSubmit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        className="max-h-full w-full max-w-xl overflow-auto dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <h2 id="uf-title" className="text-title">
            {user ? 'Editar usuario' : 'Usuario nuevo'}
          </h2>
          <button type="button" onClick={onCancel} className="btn btn-ghost">
            <Icon name="x" />
            Cancelar<span className="hidden md:inline"> (Esc)</span>
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div>
            <label className="field-label" htmlFor="uf-name">Nombre *</label>
            <input id="uf-name" className="field" value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" />
          </div>
          <div>
            <label className="field-label" htmlFor="uf-email">Correo *</label>
            <input
              id="uf-email"
              type="email"
              className="field"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={!!user}
              autoComplete="off"
            />
            {user && <p className="mt-1 text-caption text-ink-subtle">El correo no se puede cambiar desde aquí.</p>}
          </div>
          <fieldset>
            <legend className="field-label">Rol *</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {ROLES.map((r) => (
                <label
                  key={r}
                  className={`flex cursor-pointer flex-col gap-1 rounded-md border p-3 ${role === r ? 'border-brand bg-brand-soft' : 'border-control hover:bg-subtle'}`}
                >
                  <span className="flex items-center gap-2 text-label">
                    <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} />
                    {ROLE_LABELS[r]}
                  </span>
                  <span className="text-caption text-ink-muted">{ROLE_HELP[r]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {!user && (
            <div>
              <label className="field-label" htmlFor="uf-password">Contraseña temporal *</label>
              <input
                id="uf-password"
                type="text"
                className="field font-mono"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
              <p className="mt-1 text-caption text-ink-subtle">
                {PASSWORD_RULE} Compártela con la persona; al entrar por primera vez se le pedirá cambiarla.
              </p>
            </div>
          )}

          {user && user.disabled !== undefined && (
            <div className="space-y-2 border-t border-line pt-4">
              <p className="field-label">Acceso</p>
              {isSelf ? (
                <p className="text-caption text-ink-muted">No puedes desactivar tu propia cuenta.</p>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="min-w-0 flex-1 text-caption text-ink-muted">
                    {user.disabled
                      ? 'Este usuario está desactivado: no puede iniciar sesión.'
                      : 'Desactívalo cuando la persona ya no trabaje aquí: no podrá entrar y se cierran sus sesiones.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => void toggleAccess()}
                    disabled={saving}
                    className={`btn ${user.disabled ? 'btn-secondary' : 'btn-danger'}`}
                  >
                    <Icon name={user.disabled ? 'unlock' : 'lock'} />
                    {user.disabled ? 'Reactivar usuario' : 'Desactivar usuario'}
                  </button>
                </div>
              )}
            </div>
          )}

          {error && (
            <p className="notice bg-danger-bg text-danger-fg">
              <Icon name="alert" className="mt-0.5" />
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-line bg-subtle px-6 py-4">
          <button type="submit" disabled={saving} className="btn btn-primary btn-lg w-full sm:w-auto">
            <Icon name="check" size={20} />
            {saving ? 'Guardando…' : user ? 'Guardar cambios' : 'Crear usuario'}
          </button>
        </div>
      </form>
    </div>
  )
}
