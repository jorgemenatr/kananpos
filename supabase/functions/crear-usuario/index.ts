// =====================================================================
// Edge Function `crear-usuario`
// Crea un usuario (correo + contraseña temporal) con su nombre y rol.
// Solo la puede usar un usuario con rol admin. Usa la service_role key, que
// Supabase inyecta en las Edge Functions (nunca llega al navegador).
//
// Body: { "email": "...", "full_name": "...", "role": "admin" | "mostrador", "password": "..." }
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

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
  if (!isAdmin) return json({ error: 'Solo un administrador puede crear usuarios.' }, 403)

  let body: { email?: string; full_name?: string; role?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Datos inválidos' }, 400)
  }
  const email = (body.email ?? '').trim().toLowerCase()
  const fullName = (body.full_name ?? '').trim()
  const role = body.role
  const password = body.password ?? ''
  if (!fullName) return json({ error: 'El nombre es obligatorio.' }, 400)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'El correo no parece válido.' }, 400)
  if (role !== 'admin' && role !== 'mostrador') return json({ error: 'Rol inválido.' }, 400)
  if (password.length < 10 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return json({ error: 'La contraseña temporal debe tener al menos 10 caracteres, con letras y números.' }, 400)
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    // must_change_password: la app le pide cambiarla en su primer inicio de sesión.
    user_metadata: { full_name: fullName, must_change_password: true },
  })
  if (createError || !created.user) {
    const msg = createError?.message ?? 'No se pudo crear el usuario'
    const exists = /already|registered|exists/i.test(msg)
    return json({ error: exists ? 'Ya existe un usuario con ese correo.' : msg }, exists ? 409 : 400)
  }

  // El perfil lo crea el trigger handle_new_user; aquí se fija nombre y rol.
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .upsert({ id: created.user.id, email, full_name: fullName, role })
    .select('id, email, full_name, role, created_at')
    .single()
  if (profileError) return json({ error: `Usuario creado, pero no se pudo guardar el rol: ${profileError.message}` }, 500)

  return json({ profile })
})
