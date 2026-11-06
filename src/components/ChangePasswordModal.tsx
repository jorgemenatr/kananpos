import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/useAuth'
import { PASSWORD_RULE, changeMyPassword, passwordProblem } from '../lib/password'
import { Icon } from './Icon'

/**
 * Cambiar mi contraseña (cualquier usuario con sesión). Pide la actual para
 * confirmar que es la persona dueña de la cuenta.
 * `required`: contraseña temporal; no se puede cerrar sin cambiarla (solo
 * cerrar sesión).
 */
export function ChangePasswordModal({
  required = false,
  onClose,
  onSignOut,
}: {
  required?: boolean
  onClose: (changed: boolean) => void
  onSignOut?: () => void
}) {
  const { user } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (saving || !user?.email) return
    setError(null)
    if (!current) return setError('Escribe tu contraseña actual.')
    const problem = passwordProblem(next)
    if (problem) return setError(problem)
    if (next !== confirm) return setError('La confirmación no coincide con la contraseña nueva.')
    setSaving(true)
    const err = await changeMyPassword(user.email, current, next)
    setSaving(false)
    if (err) return setError(err)
    setDone(true)
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4" role="dialog" aria-modal="true" aria-labelledby="cp-title">
      <form
        noValidate
        onSubmit={onSubmit}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !required) {
            e.preventDefault()
            onClose(done)
          }
        }}
        className="max-h-full w-full max-w-md overflow-auto dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <h2 id="cp-title" className="text-title">
            {required ? 'Cambia tu contraseña' : 'Cambiar mi contraseña'}
          </h2>
          {!required && (
            <button type="button" onClick={() => onClose(done)} className="btn btn-ghost">
              <Icon name="x" />
              {done ? 'Cerrar' : 'Cancelar'}
              <span className="hidden md:inline"> (Esc)</span>
            </button>
          )}
        </div>

        {done ? (
          <div className="space-y-4 px-6 py-5">
            <p className="notice bg-success-bg text-success-fg" role="status">
              <Icon name="check" className="mt-0.5" />
              Listo, tu contraseña cambió. Úsala la próxima vez que inicies sesión.
            </p>
            <div className="flex justify-end">
              <button type="button" onClick={() => onClose(true)} className="btn btn-primary" autoFocus>
                <Icon name="check" />
                Continuar
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-4 px-6 py-5">
              {required && (
                <p className="notice bg-warning-bg text-warning-fg">
                  <Icon name="alert" className="mt-0.5" />
                  Entraste con una contraseña temporal. Elige una nueva que solo tú conozcas para seguir.
                </p>
              )}
              {/* Para que el navegador sepa de qué cuenta es la contraseña. */}
              <input type="email" value={user?.email ?? ''} autoComplete="username" readOnly hidden />
              <div>
                <label className="field-label" htmlFor="cp-current">
                  {required ? 'Contraseña temporal *' : 'Contraseña actual *'}
                </label>
                <input
                  id="cp-current"
                  type="password"
                  className="field"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  autoComplete="current-password"
                  autoFocus
                />
              </div>
              <div>
                <label className="field-label" htmlFor="cp-new">Contraseña nueva *</label>
                <input
                  id="cp-new"
                  type="password"
                  className="field"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  autoComplete="new-password"
                />
                <p className="mt-1 text-caption text-ink-subtle">{PASSWORD_RULE}</p>
              </div>
              <div>
                <label className="field-label" htmlFor="cp-confirm">Confirma la contraseña nueva *</label>
                <input
                  id="cp-confirm"
                  type="password"
                  className="field"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                />
              </div>

              {error && (
                <p className="notice bg-danger-bg text-danger-fg" role="alert">
                  <Icon name="alert" className="mt-0.5" />
                  {error}
                </p>
              )}
            </div>

            <div className="flex flex-wrap justify-end gap-3 border-t border-line bg-subtle px-6 py-4">
              {required && onSignOut && (
                <button type="button" onClick={onSignOut} className="btn btn-ghost mr-auto">
                  <Icon name="log-out" />
                  Cerrar sesión
                </button>
              )}
              <button type="submit" disabled={saving} className="btn btn-primary btn-lg w-full sm:w-auto">
                <Icon name="key" size={20} />
                {saving ? 'Guardando…' : 'Cambiar contraseña'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}
