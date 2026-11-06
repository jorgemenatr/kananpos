import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { Profile, UserRole } from './types'

const COLUMNS = 'id, email, full_name, role, created_at'

export async function listUsers(): Promise<Profile[]> {
  const [{ data, error }, status] = await Promise.all([
    supabase.from('profiles').select(COLUMNS).order('created_at', { ascending: true }),
    supabase.rpc('user_access_status'),
  ])
  if (error) throw error
  // Sin la migración de usuarios desactivados todavía, la lista sale sin estado.
  const byId = new Map(
    ((status.data ?? []) as { id: string; banned_until: string | null; last_sign_in_at: string | null }[]).map((s) => [s.id, s]),
  )
  return ((data ?? []) as Profile[]).map((p) => {
    const s = byId.get(p.id)
    return s ? { ...p, disabled: isBanned(s.banned_until), last_sign_in_at: s.last_sign_in_at } : p
  })
}

const isBanned = (bannedUntil: string | null) => !!bannedUntil && new Date(bannedUntil).getTime() > Date.now()

export async function updateUser(id: string, patch: { full_name: string; role: UserRole }): Promise<Profile> {
  const { data, error } = await supabase
    .from('profiles')
    .update({ full_name: patch.full_name.trim() || null, role: patch.role })
    .eq('id', id)
    .select(COLUMNS)
    .single()
  if (error) throw error
  return data as Profile
}

export interface NewUser {
  full_name: string
  email: string
  role: UserRole
  /** Contraseña temporal: se la das a la persona para su primer inicio de sesión. */
  password: string
}

/** Llama una Edge Function y traduce sus errores a un mensaje en español. */
async function invokeFunction<T>(name: string, body: Record<string, unknown>, failure: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body })
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const res = error.context as Response
      const payload = (await res.json().catch(() => null)) as { error?: string } | null
      if (payload?.error) throw new Error(payload.error)
      if (res.status === 404) throw new Error(`Falta publicar la Edge Function "${name}" en Supabase (ver README).`)
      throw new Error(`${failure} (error ${res.status})`)
    }
    throw error
  }
  return data as T
}

/** Crea el usuario con la Edge Function `crear-usuario` (solo admin). */
export async function createUser(input: NewUser): Promise<Profile> {
  const data = await invokeFunction<{ profile: Profile }>(
    'crear-usuario',
    { ...input, full_name: input.full_name.trim(), email: input.email.trim().toLowerCase() },
    'No se pudo crear el usuario',
  )
  return { ...data.profile, disabled: false, last_sign_in_at: null }
}

/**
 * Desactiva (bloquea el acceso y cierra sus sesiones) o reactiva a un usuario,
 * con la Edge Function `desactivar-usuario` (solo admin).
 */
export async function setUserDisabled(id: string, disabled: boolean): Promise<void> {
  await invokeFunction('desactivar-usuario', { user_id: id, disabled }, disabled ? 'No se pudo desactivar el usuario' : 'No se pudo reactivar el usuario')
}
