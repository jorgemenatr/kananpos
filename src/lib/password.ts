import { isNetworkError, supabase } from './supabase'

/** Reglas de contraseña (las mismas que la Edge Function `crear-usuario`). */
export const PASSWORD_RULE = 'Mínimo 10 caracteres, con letras y números.'

/** null si la contraseña cumple las reglas; si no, el motivo en español. */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return 'La contraseña debe tener al menos 10 caracteres.'
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return 'La contraseña debe tener letras y números.'
  return null
}

/**
 * Cambia la contraseña del usuario con sesión. Primero comprueba la contraseña
 * actual (vuelve a iniciar sesión con ella) y luego guarda la nueva. Quita la
 * marca de contraseña temporal. Devuelve null o el error en español.
 */
export async function changeMyPassword(email: string, current: string, next: string): Promise<string | null> {
  const problem = passwordProblem(next)
  if (problem) return problem
  if (current === next) return 'La contraseña nueva debe ser distinta de la actual.'
  try {
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password: current })
    if (authError) {
      const e = authError as { code?: string; status?: number; message?: string }
      if (e.code === 'invalid_credentials' || /invalid login credentials/i.test(e.message ?? '')) {
        return 'La contraseña actual no es correcta.'
      }
      if (e.status === 429) return 'Demasiados intentos. Espera un momento e intenta de nuevo.'
      return `No se pudo comprobar la contraseña actual: ${e.message ?? 'error desconocido'}`
    }
    const { error } = await supabase.auth.updateUser({ password: next, data: { must_change_password: false } })
    if (error) {
      const e = error as { code?: string; message?: string }
      if (e.code === 'same_password') return 'La contraseña nueva debe ser distinta de la actual.'
      if (e.code === 'weak_password') return `La contraseña es demasiado débil. ${PASSWORD_RULE}`
      return `No se pudo cambiar la contraseña: ${e.message ?? 'error desconocido'}`
    }
    return null
  } catch (err) {
    if (isNetworkError(err)) return 'Sin conexión: intenta cuando vuelva el internet.'
    return `No se pudo cambiar la contraseña: ${(err as Error).message}`
  }
}
