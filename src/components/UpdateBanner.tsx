import { useState } from 'react'
import { updateApp, useNewVersionAvailable } from '../lib/appVersion'
import { Icon } from './Icon'

/** Franja arriba de la página cuando ya hay una versión nueva de Kanan publicada. */
export function UpdateBanner() {
  const available = useNewVersionAvailable()
  const [updating, setUpdating] = useState(false)
  if (!available) return null
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning-fg/30 bg-warning-bg px-4 py-2 text-body text-warning-fg print:hidden"
    >
      <Icon name="refresh" size={18} />
      <p className="min-w-0 flex-1">Hay una versión nueva de Kanan. Actualiza para seguir trabajando sin errores; no se pierden tickets ni pendientes.</p>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        disabled={updating}
        onClick={() => {
          setUpdating(true)
          updateApp()
        }}
      >
        {updating ? 'Actualizando…' : 'Actualizar ahora'}
      </button>
    </div>
  )
}
