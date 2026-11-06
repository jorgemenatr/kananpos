import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { refreshCategories } from '../lib/categories'
import { refreshSettings } from '../lib/settings'
import { isNetworkError, supabase } from '../lib/supabase'
import type { Profile } from '../lib/types'
import { AuthContext, type AuthContextValue } from './authContext'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      setLoading(false)
    })
    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  const userId = session?.user.id
  useEffect(() => {
    if (!userId) {
      setProfile(null)
      return
    }
    // Copia local: sin internet se conserva el rol de la última vez.
    setProfile(loadCachedProfile(userId))
    void refreshSettings()
    void refreshCategories()
    let active = true
    // Se hace fuera de onAuthStateChange (supabase-js recomienda no llamar a la
    // API dentro del callback).
    supabase
      .from('profiles')
      .select('id, email, full_name, role')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return
        // Un admin desactivó este usuario (check_request en la base): fuera.
        if (error?.hint === 'usuario_desactivado') {
          saveCachedProfile(null)
          void supabase.auth.signOut({ scope: 'local' })
          return
        }
        if (error) return
        const p = (data as Profile | null) ?? null
        setProfile(p)
        saveCachedProfile(p)
      })
    return () => {
      active = false
    }
  }, [userId])

  const signIn = useCallback<AuthContextValue['signIn']>(async (email, password) => {
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
      if (!error) return null
      return translateAuthError(error)
    } catch (error) {
      return translateAuthError(error)
    }
  }, [])

  const signOut = useCallback(async () => {
    // scope 'local': cierra la sesión en este navegador aunque no haya red.
    await supabase.auth.signOut({ scope: 'local' })
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ session, user: session?.user ?? null, profile, loading, signIn, signOut }),
    [session, profile, loading, signIn, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

const PROFILE_KEY = 'hachiko.perfil'

function loadCachedProfile(userId: string): Profile | null {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null') as Profile | null
    return p?.id === userId ? p : null
  } catch {
    return null
  }
}

function saveCachedProfile(p: Profile | null) {
  try {
    if (p) localStorage.setItem(PROFILE_KEY, JSON.stringify(p))
    else localStorage.removeItem(PROFILE_KEY)
  } catch {
    /* no crítico */
  }
}

function translateAuthError(error: unknown): string {
  if (isNetworkError(error)) return 'Sin conexión a internet. Revisa la red e intenta de nuevo.'
  const e = error as { message?: string; code?: string; status?: number }
  const msg = (e.message ?? '').toLowerCase()
  if (e.code === 'invalid_credentials' || msg.includes('invalid login credentials')) {
    return 'Correo o contraseña incorrectos.'
  }
  if (e.code === 'email_not_confirmed' || msg.includes('email not confirmed')) {
    return 'El correo de esta cuenta no está confirmado. Pide a un administrador que lo confirme en Supabase.'
  }
  if (e.code === 'user_banned' || msg.includes('banned')) {
    return 'Tu usuario está desactivado. Habla con un administrador del negocio.'
  }
  if (e.status === 429) return 'Demasiados intentos. Espera un momento e intenta de nuevo.'
  return `No se pudo iniciar sesión: ${e.message ?? 'error desconocido'}`
}
