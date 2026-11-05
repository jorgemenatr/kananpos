import { useEffect, useState } from 'react'

declare const __APP_VERSION__: string

/** Versión con la que se compiló el código que corre en esta pestaña. */
export const APP_VERSION = __APP_VERSION__

/** Cada cuánto se pregunta si hay versión nueva (además de al volver a la pestaña o recuperar internet). */
const CHECK_INTERVAL_MS = 5 * 60 * 1000

/** Versión publicada ahora mismo en el sitio; null si no se pudo saber (sin red, modo dev). */
async function publishedVersion(): Promise<string | null> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return null
    const data = (await res.json()) as { version?: unknown }
    return typeof data.version === 'string' ? data.version : null
  } catch {
    return null
  }
}

/**
 * true cuando el sitio ya tiene una versión distinta a la de esta pestaña.
 * Una pestaña que se queda abierta días sigue corriendo el código viejo, y
 * cuando la base de datos cambia ese código puede dejar de funcionar.
 */
export function useNewVersionAvailable() {
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    if (import.meta.env.DEV || available) return
    let cancelled = false
    const check = async () => {
      const v = await publishedVersion()
      if (!cancelled && v && v !== APP_VERSION) setAvailable(true)
    }
    const onVisible = () => document.visibilityState === 'visible' && void check()
    void check()
    const timer = setInterval(() => void check(), CHECK_INTERVAL_MS)
    window.addEventListener('focus', check)
    window.addEventListener('online', check)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener('focus', check)
      window.removeEventListener('online', check)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [available])

  return available
}

/**
 * Carga la versión nueva. Los tickets abiertos y la cola de pendientes viven
 * en localStorage, así que no se pierden al recargar.
 */
export function updateApp() {
  window.location.reload()
}
