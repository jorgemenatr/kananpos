// =====================================================================
// Edge Function `desactivar-usuario`
// Desactiva (o reactiva) el acceso de un usuario: lo bloquea en Auth y cierra
// todas sus sesiones. Solo la puede usar un usuario con rol admin. Usa la
// service_role key, que Supabase inyecta en las Edge Functions (nunca llega
// al navegador).
//
// Reglas: nadie se desactiva a sí mismo y siempre queda al menos un
// administrador activo.
//
// Body: { "user_id": "...", "disabled": true | false }
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

// ~100 años: Auth no tiene un bloqueo "para siempre".
const BAN_FOREVER = '876000h'

const isBanned = (bannedUntil: string | null | undefined) => !!bannedUntil && new Date(bannedUntil).getTime() > Date.now()

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  // ¿Quién llama? Se valida su sesión y su rol con sus propios permisos.
  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false },
  })
  const { data: userData, error: userError } = await caller.auth.getUser()
  if (userError || !userData.user) return json({ error: 'Sesión inválida. Vuelve a iniciar sesión.' }, 401)
  const { data: isAdmin, error: roleError } = await caller.rpc('is_admin')
  if (roleError) return json({ error: roleError.message }, 500)
  if (!isAdmin) return json({ error: 'Solo un administrador puede desactivar usuarios.' }, 403)

  let body: { user_id?: string; disabled?: boolean }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Datos inválidos' }, 400)
  }
  const userId = (body.user_id ?? '').trim()
  const disabled = body.disabled
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return json({ error: 'Usuario inválido.' }, 400)
  if (typeof disabled !== 'boolean') return json({ error: 'Falta indicar si se desactiva o se reactiva.' }, 400)
  if (disabled && userId === userData.user.id) return json({ error: 'No puedes desactivar tu propia cuenta.' }, 400)

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

  const { data: target, error: targetError } = await admin.auth.admin.getUserById(userId)
  if (targetError || !target.user) return json({ error: 'No se encontró el usuario.' }, 404)

  if (disabled) {
    // Siempre debe quedar al menos un administrador activo.
    const { data: profile, error: profileError } = await admin.from('profiles').select('role').eq('id', userId).maybeSingle()
    if (profileError) return json({ error: profileError.message }, 500)
    if (profile?.role === 'admin') {
      const { data: admins, error: adminsError } = await admin.from('profiles').select('id').eq('role', 'admin').neq('id', userId)
      if (adminsError) return json({ error: adminsError.message }, 500)
      let active = 0
      for (const a of admins ?? []) {
        const { data } = await admin.auth.admin.getUserById(a.id)
        if (data.user && !isBanned(data.user.banned_until)) active++
      }
      if (active === 0) return json({ error: 'Debe quedar al menos un administrador activo.' }, 409)
    }
  }

  const { data: updated, error: updateError } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: disabled ? BAN_FOREVER : 'none',
  })
  if (updateError || !updated.user) return json({ error: updateError?.message ?? 'No se pudo actualizar el usuario.' }, 400)

  if (disabled) {
    // Cierra todas sus sesiones (no puede renovar su token). Lo que le quede de
    // token de acceso lo rechaza check_request en la base.
    const { error: revokeError } = await admin.rpc('revoke_user_sessions', { p_user_id: userId })
    if (revokeError) {
      return json(
        {
          error:
            `Se desactivó el usuario, pero no se pudieron cerrar sus sesiones: ${revokeError.message}. ` +
            '¿Falta aplicar la migración 20261106000100_desactivar_usuarios.sql?',
        },
        500,
      )
    }
  }

  return json({ user_id: userId, disabled, banned_until: updated.user.banned_until ?? null })
})
