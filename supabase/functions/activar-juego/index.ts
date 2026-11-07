// =====================================================================
// Edge Function `activar-juego`
// Carga inicial del catálogo de singles de un juego que la tienda acaba de
// activar (Configuración → Singles y juegos). Pide al workflow "Sincronizar
// singles" de GitHub que descargue ese juego y lo copie a ESTA tienda.
//
// Solo la puede usar un admin, y solo para un juego activo que esté
// pendiente de carga. Si falta el token de GitHub, el juego se descarga en
// la siguiente actualización nocturna (05:00 CDMX) de todos modos.
//
// Secrets (Edge Functions → Secrets; npm run clientes -- funciones los pone):
//   GITHUB_DISPATCH_TOKEN  token fino de GitHub con "Actions: read and write"
//                          SOLO en el repositorio de Kanan. Nunca en el frontend.
//   GITHUB_REPO            opcional, por defecto jorgemenatr/kananpos
//   GITHUB_DISPATCH_REF    opcional, rama del workflow (por defecto main)
//
// Body: { "slug": "lorcana" }
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const LATER = 'Se descargará en la próxima actualización automática (05:00).'

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
  if (!isAdmin) return json({ error: 'Solo un administrador puede activar juegos.' }, 403)

  let body: { slug?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Datos inválidos' }, 400)
  }
  const slug = String(body.slug ?? '').trim()
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return json({ error: 'Juego inválido.' }, 400)

  const { data: game, error: gameError } = await caller
    .from('tcg_game_settings')
    .select('id, slug, enabled, catalog_status')
    .eq('slug', slug)
    .maybeSingle()
  if (gameError) return json({ error: gameError.message }, 500)
  if (!game || !game.enabled) return json({ error: 'Activa el juego antes de pedir su catálogo.' }, 409)
  if (game.catalog_status !== 'pending') return json({ ok: true, skipped: true })

  const token = Deno.env.get('GITHUB_DISPATCH_TOKEN')
  if (!token) return json({ error: `La descarga automática no está configurada. ${LATER}` }, 503)

  const repo = Deno.env.get('GITHUB_REPO') || 'jorgemenatr/kananpos'
  const projectRef = new URL(url).hostname.split('.')[0]
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/sincronizar-singles.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'KananPOS-activar-juego',
    },
    body: JSON.stringify({ ref: Deno.env.get('GITHUB_DISPATCH_REF') || 'main', inputs: { juego: slug, ref: projectRef } }),
  })
  if (!res.ok) {
    console.error('GitHub dispatch', res.status, await res.text())
    return json({ error: `No se pudo pedir la descarga (GitHub ${res.status}). ${LATER}` }, 502)
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  await admin
    .from('tcg_games')
    .update({ status_message: 'Descarga solicitada', status_at: new Date().toISOString() })
    .eq('id', game.id)
    .eq('catalog_status', 'pending')

  return json({ ok: true })
})
