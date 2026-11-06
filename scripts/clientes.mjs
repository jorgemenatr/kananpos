#!/usr/bin/env node
/*
 * Administra a los clientes del sistema. Cada cliente tiene su propio
 * proyecto de Supabase (su propia base, usuarios e imágenes) y todos corren
 * el mismo código y las mismas migraciones.
 *
 * Uso (npm run clientes -- <comando> …):
 *   estado                       Migraciones aplicadas y pendientes de cada cliente.
 *   migrar [--prueba]            Aplica las migraciones pendientes (en orden, cada una
 *                                en su propia transacción). --prueba solo las lista.
 *   funciones                    Despliega las Edge Functions (crear-usuario, desactivar-usuario).
 *   alta --ref <id> --subdominio tienda --negocio "Nombre" --prefijo ABC
 *        --admin-correo a@b.mx --admin-nombre "Nombre"
 *        [--juegos pokemon,magic,dragon-shield] [--categorias "Cafetería,Juegos de mesa"]
 *                                Prepara un proyecto NUEVO: cierra el registro público,
 *                                apunta la Site URL de Auth a su subdominio,
 *                                corre las migraciones, guarda el nombre y el prefijo,
 *                                crea las categorías, despliega las funciones, crea el primer
 *                                admin, carga el catálogo de sus juegos y lo registra en
 *                                src/tenants.json (tienda.<dominio_base>). --juegos: claves
 *                                de src/lib/catalogSources.json (los juegos van como
 *                                subcategorías de "TCG"; los accesorios, en "Accesorios").
 *   suspender --subdominio tienda / reactivar --subdominio tienda
 *                                Cambia el estado en src/tenants.json (suspendido: la app
 *                                muestra un aviso en lugar de abrir).
 *   catalogo [-- --juegos …]     Importa el catálogo TCG en cada cliente
 *                                (pasa los argumentos a importar-catalogo.mjs).
 *   respaldo [--dir respaldos] [--sin-fotos]
 *                                Respaldo de cada cliente: la base (pg_dump 17, con un
 *                                acceso temporal de solo lectura que da la API, sin la
 *                                contraseña) y las fotos del bucket. Lo corre el workflow
 *                                "Respaldo de clientes" (la base diario, las fotos los
 *                                domingos), que lo cifra.
 *   restaurar --ref <nuevo> --dir respaldos/<ref-original> --confirmar <nuevo>
 *                                Restaura un respaldo (ya descifrado) en un proyecto NUEVO
 *                                y vacío. Necesita psql 17. Ver docs/RESPALDOS.md.
 *
 * Los clientes son los de src/tenants.json (el registro que usa la app para
 * saber a qué base conectarse por subdominio). --ref <id> limita cualquier
 * comando a un solo proyecto.
 *
 * Variables de entorno (en .env.clientes o en los secrets de GitHub Actions):
 *   SUPABASE_ACCESS_TOKEN  Token personal de Supabase (Account → Access Tokens).
 *                          Da acceso a TODOS tus proyectos: nunca en el frontend.
 *   CLIENTES               Opcional: IDs de proyecto separados por coma, en lugar
 *                          de los del registro.
 */

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations')
const FUNCTIONS = ['crear-usuario', 'desactivar-usuario']
const FUENTES = JSON.parse(readFileSync(join(ROOT, 'src', 'lib', 'catalogSources.json'), 'utf8'))
const API = 'https://api.supabase.com/v1'

// ---------- argumentos ----------
function parseArgs(argv) {
  const sep = argv.indexOf('--')
  const own = sep === -1 ? argv : argv.slice(0, sep)
  const passthrough = sep === -1 ? [] : argv.slice(sep + 1)
  const [command, ...rest] = own
  const opts = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) throw new Error(`Argumento inesperado: ${a}`)
    const [k, inline] = a.slice(2).split(/=(.*)/s)
    if (inline !== undefined) opts[k] = inline
    else if (rest[i + 1] && !rest[i + 1].startsWith('--')) opts[k] = rest[++i]
    else opts[k] = true
  }
  return { command, opts, passthrough }
}

// ---------- Management API de Supabase ----------
function token() {
  const t = process.env.SUPABASE_ACCESS_TOKEN
  if (!t) {
    throw new Error(
      'Falta SUPABASE_ACCESS_TOKEN. Créalo en https://supabase.com/dashboard/account/tokens ' +
        'y ponlo en .env.clientes (copia .env.clientes.example).',
    )
  }
  return t
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || text || res.statusText
    throw new Error(`${method} ${path} → ${res.status}: ${msg}`)
  }
  return data
}

/** Corre SQL en el proyecto (como postgres). Devuelve las filas del último SELECT. */
const sql = (ref, query, readOnly = false) =>
  api('POST', `/projects/${ref}/database/query`, { query, read_only: readOnly })

/** Literal de texto para SQL. */
const lit = (s) => `'${String(s).replaceAll("'", "''")}'`

async function apiKeys(ref) {
  const keys = await api('GET', `/projects/${ref}/api-keys?reveal=true`)
  const anon = keys.find((k) => k.name === 'anon')?.api_key ?? keys.find((k) => k.type === 'publishable')?.api_key
  const service =
    keys.find((k) => k.name === 'service_role')?.api_key ?? keys.find((k) => k.type === 'secret')?.api_key
  if (!anon || !service) throw new Error(`No encontré las llaves anon / service_role del proyecto ${ref}`)
  return { anon, service }
}

// ---------- clientes ----------
// ---------- registro de clientes (src/tenants.json) ----------
const TENANTS_FILE = join(ROOT, 'src', 'tenants.json')
const readTenants = () => JSON.parse(readFileSync(TENANTS_FILE, 'utf8'))
const writeTenants = (t) => writeFileSync(TENANTS_FILE, `${JSON.stringify(t, null, 2)}\n`)
const refFromUrl = (url) => new URL(url).hostname.split('.')[0]

function clientRefs(opts) {
  if (typeof opts.ref === 'string') return [opts.ref]
  let refs = (process.env.CLIENTES ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!refs.length) refs = Object.values(readTenants().clientes).map((c) => refFromUrl(c.supabase_url))
  if (!refs.length) throw new Error('No hay clientes en src/tenants.json. Usa --ref <id>.')
  return [...new Set(refs)]
}

async function projectInfo(ref) {
  const p = await api('GET', `/projects/${ref}`)
  return { ref, name: p.name, status: p.status, region: p.region }
}

// ---------- migraciones ----------
// Mismo registro que usa `supabase db push` (supabase_migrations.schema_migrations),
// así el CLI y este script ven lo mismo.
export function localMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const [, version, name] = file.match(/^(\d+)_(.+)\.sql$/)
      return { file, version, name, sql: readFileSync(join(MIGRATIONS_DIR, file), 'utf8') }
    })
}

async function appliedVersions(ref) {
  const rows = await sql(
    ref,
    `select coalesce(array_agg(version order by version), '{}') as versions
     from supabase_migrations.schema_migrations
     where to_regclass('supabase_migrations.schema_migrations') is not null`,
    true,
  ).catch((e) => {
    // Proyecto recién creado: la tabla aún no existe.
    if (/schema_migrations/.test(e.message)) return [{ versions: [] }]
    throw e
  })
  return new Set(rows[0]?.versions ?? [])
}

async function pendingMigrations(ref) {
  const applied = await appliedVersions(ref)
  const local = localMigrations()
  const localVersions = new Set(local.map((m) => m.version))
  // Aplicadas en la base pero que no están en este código (otra rama sin mergear).
  const unknown = [...applied].filter((v) => !localVersions.has(v))
  return { pending: local.filter((m) => !applied.has(m.version)), unknown, applied }
}

/** La migración y su registro, en una transacción: si falla, no queda a medias ni registrada. */
export function migrationQuery(m) {
  return `begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key, statements text[], name text
);
${m.sql}
;
insert into supabase_migrations.schema_migrations (version, statements, name)
values (${lit(m.version)}, array[${lit(m.sql)}], ${lit(m.name)});
commit;`
}

async function migrate(ref, { dryRun = false } = {}) {
  const { pending, unknown } = await pendingMigrations(ref)
  if (unknown.length) {
    throw new Error(
      `${ref} tiene migraciones que no están en este código (${unknown.join(', ')}). ` +
        'Actualiza tu copia del repositorio antes de migrar.',
    )
  }
  if (!pending.length) {
    console.log(`  ${ref}: al día`)
    return 0
  }
  for (const m of pending) {
    if (dryRun) {
      console.log(`  ${ref}: pendiente ${m.file}`)
      continue
    }
    process.stdout.write(`  ${ref}: ${m.file} … `)
    await sql(ref, migrationQuery(m)).catch((e) => {
      console.log('falló')
      throw e
    })
    console.log('ok')
  }
  return pending.length
}

// ---------- categorías iniciales ----------
/**
 * SQL que crea las categorías de un negocio nuevo. Se puede correr otra vez:
 * no repite nombres ni juegos que ya estén ligados a alguna categoría.
 */
export function seedCategoriesQuery({ juegos = [], categorias = [] }) {
  const games = juegos.filter((j) => j in FUENTES.juegos)
  const accessories = juegos.filter((j) => j in FUENTES.accesorios)
  const unknown = juegos.filter((j) => !games.includes(j) && !accessories.includes(j))
  if (unknown.length) {
    const all = [...Object.keys(FUENTES.juegos), ...Object.keys(FUENTES.accesorios)]
    throw new Error(`Juegos desconocidos: ${unknown.join(', ')}. Disponibles: ${all.join(', ')}`)
  }
  const top = (name, sources, n) =>
    `insert into public.product_categories (name, catalog_sources, sort_order)
     select ${lit(name)}, array[${sources.map(lit).join(', ')}]::text[], ${n}
     where not exists (select 1 from public.product_categories where parent_id is null and lower(name) = lower(${lit(name)}));`
  const parts = []
  let n = 1
  if (games.length) {
    parts.push(top('TCG', [], n++))
    games.forEach((key, i) => {
      parts.push(`insert into public.product_categories (parent_id, name, catalog_sources, sort_order)
     select p.id, ${lit(FUENTES.juegos[key].label)}, array[${lit(key)}], ${i + 1}
     from public.product_categories p
     where p.parent_id is null and lower(p.name) = 'tcg'
       and not exists (select 1 from public.product_categories c where ${lit(key)} = any (c.catalog_sources))
       and not exists (select 1 from public.product_categories c
                       where c.parent_id = p.id and lower(c.name) = lower(${lit(FUENTES.juegos[key].label)}));`)
    })
  }
  if (accessories.length) {
    parts.push(top('Accesorios', [], n++))
    parts.push(`update public.product_categories
     set catalog_sources = catalog_sources || array(
       select s from unnest(array[${accessories.map(lit).join(', ')}]::text[]) s
       where not exists (select 1 from public.product_categories c where s = any (c.catalog_sources)))
     where parent_id is null and lower(name) = 'accesorios';`)
  }
  for (const c of categorias) parts.push(top(c, [], n++))
  return parts.length ? `begin;\n${parts.join('\n')}\ncommit;` : null
}

// ---------- Edge Functions ----------
function deployFunctions(ref) {
  for (const fn of FUNCTIONS) {
    console.log(`  ${ref}: desplegando ${fn} …`)
    const r = spawnSync(
      'npx',
      ['--yes', 'supabase@latest', 'functions', 'deploy', fn, '--project-ref', ref, '--use-api'],
      { cwd: ROOT, stdio: 'inherit', env: process.env },
    )
    if (r.status !== 0) {
      throw new Error(
        `No se pudo desplegar ${fn} en ${ref}. Puedes hacerlo a mano: ` +
          `npx supabase functions deploy ${fn} --project-ref ${ref}`,
      )
    }
  }
}

// ---------- comandos ----------
async function cmdEstado(opts) {
  const local = localMigrations()
  console.log(`Migraciones en el código: ${local.length} (última ${local.at(-1)?.file})\n`)
  for (const ref of clientRefs(opts)) {
    try {
      const info = await projectInfo(ref)
      const { pending, unknown } = await pendingMigrations(ref)
      const settings = await sql(
        ref,
        `select business_name, internal_code_prefix from public.app_settings
         where to_regclass('public.app_settings') is not null`,
        true,
      ).catch(() => [])
      const negocio = settings[0] ? `${settings[0].business_name} (${settings[0].internal_code_prefix}-)` : '—'
      console.log(`${ref} · ${info.name} · ${info.status} · negocio: ${negocio}`)
      if (pending.length) console.log(`  pendientes: ${pending.map((m) => m.file).join(', ')}`)
      else console.log('  migraciones al día')
      if (unknown.length) console.log(`  ⚠️ aplicadas que no están en este código: ${unknown.join(', ')}`)
    } catch (e) {
      console.log(`${ref} · ERROR: ${e.message}`)
      process.exitCode = 1
    }
  }
}

async function cmdMigrar(opts) {
  const dryRun = Boolean(opts.prueba)
  let failed = 0
  for (const ref of clientRefs(opts)) {
    try {
      await migrate(ref, { dryRun })
    } catch (e) {
      // Un cliente con error no detiene a los demás.
      console.error(`  ${ref}: ERROR → ${e.message}`)
      failed++
    }
  }
  if (failed) {
    console.error(`\n${failed} cliente(s) con error.`)
    process.exitCode = 1
  }
}

async function cmdFunciones(opts) {
  for (const ref of clientRefs(opts)) deployFunctions(ref)
}

async function cmdAlta(opts) {
  const ref = opts.ref
  const subdominio = typeof opts.subdominio === 'string' ? opts.subdominio.trim().toLowerCase() : ''
  const negocio = typeof opts.negocio === 'string' ? opts.negocio.trim() : ''
  const prefijo = typeof opts.prefijo === 'string' ? opts.prefijo.trim().toUpperCase() : ''
  const correo = typeof opts['admin-correo'] === 'string' ? opts['admin-correo'].trim().toLowerCase() : ''
  const nombre = typeof opts['admin-nombre'] === 'string' ? opts['admin-nombre'].trim() : ''
  if (typeof ref !== 'string' || !subdominio || !negocio || !prefijo || !correo || !nombre) {
    throw new Error(
      'Uso: npm run clientes -- alta --ref <id> --subdominio tienda --negocio "Nombre" --prefijo ABC ' +
        '--admin-correo a@b.mx --admin-nombre "Nombre" [--juegos pokemon,magic] [--categorias "Cafetería,Comida"]',
    )
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/.test(subdominio) || ['www', 'admin', 'api'].includes(subdominio)) {
    throw new Error('El subdominio debe ser de letras minúsculas, números y guiones (p. ej. dragon-rojo).')
  }
  const tenants = readTenants()
  const taken = tenants.clientes[subdominio]
  if (taken && refFromUrl(taken.supabase_url) !== ref) {
    throw new Error(`El subdominio "${subdominio}" ya es de otro cliente (${taken.nombre}).`)
  }
  if (!/^[A-Z]{2,5}$/.test(prefijo)) throw new Error('El prefijo debe ser de 2 a 5 letras (A-Z), p. ej. DRG.')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) throw new Error('El correo del admin no parece válido.')
  const list = (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : [])
  const juegos = list(opts.juegos).map((j) => j.toLowerCase())
  const categorias = list(opts.categorias)
  // Valida antes de tocar el proyecto.
  const seed = seedCategoriesQuery({ juegos, categorias })

  const info = await projectInfo(ref)
  console.log(`Proyecto ${ref} · ${info.name} · ${info.region} · ${info.status}`)
  if (info.status !== 'ACTIVE_HEALTHY') throw new Error('El proyecto todavía no está listo (espera a que diga ACTIVE_HEALTHY).')

  // Site URL y redirects: los enlaces de los correos de Auth (p. ej. recuperar la
  // contraseña) llevan al subdominio del cliente y no a localhost.
  const siteUrl = `https://${subdominio}.${tenants.dominio_base}`
  console.log('\n1. Cerrando el registro público (solo un admin crea usuarios)')
  await api('PATCH', `/projects/${ref}/config/auth`, {
    disable_signup: true,
    // Contraseñas de al menos 10 caracteres con letras y números.
    password_min_length: 10,
    password_required_characters: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789',
    site_url: siteUrl,
    uri_allow_list: `https://*.${tenants.dominio_base}/**`,
  })
  console.log(`  Site URL ${siteUrl}`)

  console.log('\n2. Migraciones')
  await migrate(ref)

  console.log('\n3. Nombre y prefijo del negocio')
  await sql(
    ref,
    `update public.app_settings set business_name = ${lit(negocio)}, internal_code_prefix = ${lit(prefijo)} where id`,
  )
  console.log(`  ${negocio} · códigos internos ${prefijo}-000001`)

  console.log('\n4. Categorías')
  if (seed) {
    await sql(ref, seed)
    const rows = await sql(
      ref,
      `select public.category_value(c) as value from public.product_categories c order by 1`,
      true,
    )
    console.log(`  ${rows.map((r) => r.value).join(', ')}`)
  } else {
    console.log('  Ninguna (el admin las crea en Configuración)')
  }

  console.log('\n5. Edge Functions')
  deployFunctions(ref)

  console.log('\n6. Primer administrador')
  const { anon, service } = await apiKeys(ref)
  const url = `https://${ref}.supabase.co`
  // Siempre con letras y números (lo exige password_required_characters).
  const password = `${randomBytes(12).toString('base64url')}k7`
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: correo,
      password,
      email_confirm: true,
      // La app le pide cambiar la contraseña temporal al entrar.
      user_metadata: { full_name: nombre, must_change_password: true },
    }),
  })
  let created = true
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    if (res.status === 422 && /exist|registered/i.test(JSON.stringify(body))) {
      created = false
      console.log(`  ${correo} ya existía: se deja su contraseña y se le da rol admin`)
    } else {
      throw new Error(`No se pudo crear el admin: ${res.status} ${JSON.stringify(body)}`)
    }
  }
  await sql(
    ref,
    `update public.profiles set role = 'admin', full_name = ${lit(nombre)} where lower(email) = ${lit(correo)}`,
  )

  if (juegos.length) {
    console.log('\n7. Catálogo TCG (solo sus juegos; puede tardar unos minutos)')
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'importar-catalogo.mjs')], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: service },
    })
    if (r.status !== 0) console.log(`  ⚠️ No se pudo cargar el catálogo. Reintenta con: npm run clientes -- catalogo --ref ${ref}`)
  }

  // La anon key es pública por diseño; la service_role nunca va al registro.
  tenants.clientes[subdominio] = { nombre: negocio, supabase_url: url, anon_key: anon, estado: 'activo' }
  writeTenants(tenants)

  console.log(`
Listo. Se registró en src/tenants.json como ${subdominio}.${tenants.dominio_base}.
Falta publicarlo: commit y push a main (Netlify construye una sola vez para todos).
Y en Netlify → Domain management → Add domain alias: ${subdominio}.${tenants.dominio_base}
(el DNS y el certificado los pone Netlify solo).
${created ? `\nAcceso del admin (la app le pide cambiarla al entrar):\n  ${correo}\n  ${password}\n` : ''}`)
}

async function cmdCatalogo(opts, passthrough) {
  let failed = 0
  for (const ref of clientRefs(opts)) {
    console.log(`\n=== ${ref}`)
    const { service } = await apiKeys(ref)
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'importar-catalogo.mjs'), ...passthrough], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, SUPABASE_URL: `https://${ref}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: service },
    })
    if (r.status !== 0) failed++
  }
  if (failed) process.exitCode = 1
}

function setStatus(estado) {
  return async (opts) => {
    const sub = typeof opts.subdominio === 'string' ? opts.subdominio.trim().toLowerCase() : ''
    const tenants = readTenants()
    if (!tenants.clientes[sub]) throw new Error(`No hay ningún cliente "${sub}" en src/tenants.json.`)
    tenants.clientes[sub].estado = estado
    writeTenants(tenants)
    console.log(`${sub}: ${estado}. Haz commit y push a main para que aplique.`)
  }
}

// ---------- respaldo ----------
const BUCKETS = ['product-images']

/** Acceso temporal a la base (dura 5 minutos; no usa la contraseña). */
async function dbLogin(ref, { readOnly = true } = {}) {
  const { role, password } = await api('POST', `/projects/${ref}/cli/login-role`, { read_only: readOnly })
  const pooler = await api('GET', `/projects/${ref}/config/database/pooler`)
  const list = Array.isArray(pooler) ? pooler : [pooler]
  const host = (list.find((p) => p.database_type === 'PRIMARY') ?? list[0])?.db_host
  if (!host) throw new Error(`No encontré el pooler del proyecto ${ref}`)
  // Puerto 5432 = modo sesión (pg_dump no funciona en modo transacción).
  return {
    args: ['-h', host, '-p', '5432', '-U', `${role}.${ref}`, '-d', 'postgres'],
    env: { ...process.env, PGPASSWORD: password, PGSSLMODE: 'require' },
  }
}

async function pgDump(ref, file, extra) {
  const { args, env } = await dbLogin(ref)
  const r = spawnSync('pg_dump', [...args, '--no-owner', '--file', file, ...extra], { env, stdio: ['ignore', 'inherit', 'inherit'] })
  if (r.error) throw new Error(`No se pudo correr pg_dump (¿está instalado el cliente de Postgres 17?): ${r.error.message}`)
  if (r.status !== 0) throw new Error(`pg_dump falló para ${ref}`)
}

async function backupBucket(ref, bucket, dir, service) {
  const rows = await sql(
    ref,
    `select name from storage.objects where bucket_id = ${lit(bucket)} and name is not null order by name`,
    true,
  )
  const url = `https://${ref}.supabase.co/storage/v1/object/${bucket}`
  const headers = { apikey: service, Authorization: `Bearer ${service}` }
  let done = 0
  const queue = [...rows]
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const path = row.name.split('/').map(encodeURIComponent).join('/')
        const res = await fetch(`${url}/${path}`, { headers })
        if (!res.ok) throw new Error(`No se pudo bajar ${bucket}/${row.name}: ${res.status}`)
        const file = join(dir, bucket, ...row.name.split('/'))
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, Buffer.from(await res.arrayBuffer()))
        done++
      }
    }),
  )
  return done
}

async function cmdRespaldo(opts) {
  const root = typeof opts.dir === 'string' ? opts.dir : 'respaldos'
  const fotos = !opts['sin-fotos']
  let failed = 0
  for (const ref of clientRefs(opts)) {
    const dir = join(root, ref)
    mkdirSync(dir, { recursive: true })
    try {
      console.log(`\n=== ${ref}`)
      // Tablas, funciones, permisos y datos de la app, más el registro de
      // migraciones: se restaura completo en un proyecto nuevo.
      await pgDump(ref, join(dir, 'app.sql'), ['--schema=public', '--schema=supabase_migrations'])
      // Usuarios (con sus contraseñas cifradas) y los buckets: esos esquemas los
      // crea Supabase, así que solo van los datos. Los archivos van aparte.
      await pgDump(ref, join(dir, 'usuarios.sql'), [
        '--data-only',
        '--table=auth.users',
        '--table=auth.identities',
        '--table=storage.buckets',
      ])
      const { service } = fotos ? await apiKeys(ref) : {}
      for (const bucket of fotos ? BUCKETS : []) {
        const n = await backupBucket(ref, bucket, join(dir, 'storage'), service)
        console.log(`  ${bucket}: ${n} archivos`)
      }
      console.log('  ok')
    } catch (e) {
      // Un cliente con error no detiene a los demás.
      console.error(`  ERROR → ${e.message}`)
      failed++
    }
  }
  if (failed) {
    console.error(`\n${failed} cliente(s) sin respaldo.`)
    process.exitCode = 1
  }
}

// ---------- restaurar ----------
// Sin los permisos automáticos de Supabase para tablas nuevas: el respaldo trae
// los permisos exactos de cada tabla (y al final vuelve a poner los automáticos).
// Sin esto, las tablas quedarían con más permisos que los originales.
export const RESTORE_PRELUDE = ['tables', 'sequences', 'functions']
  .map((t) => `alter default privileges for role postgres in schema public revoke all on ${t} from anon, authenticated, service_role;`)
  .join('\n')

/** El respaldo trae CREATE SCHEMA public, que ya existe en un proyecto de Supabase. */
export const restorableAppSql = (text) => text.replace(/^CREATE SCHEMA public;$/m, '')

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

function filesUnder(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? filesUnder(full) : [full]
  })
}

function psql(conn, input, label) {
  const r = spawnSync('psql', [...conn.args, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    env: conn.env,
    input,
    stdio: ['pipe', 'ignore', 'inherit'],
    maxBuffer: 1 << 30,
  })
  if (r.error) throw new Error(`No se pudo correr psql (¿está instalado el cliente de Postgres 17?): ${r.error.message}`)
  if (r.status !== 0) throw new Error(`Falló la restauración en: ${label}. Nada de lo que sigue se aplicó.`)
}

async function cmdRestaurar(opts) {
  const ref = opts.ref
  const dir = opts.dir
  if (typeof ref !== 'string' || typeof dir !== 'string') {
    throw new Error('Uso: npm run clientes -- restaurar --ref <nuevo> --dir respaldos/<ref-original> --confirmar <nuevo>')
  }
  if (opts.confirmar !== ref) throw new Error(`Para confirmar, repite el proyecto destino: --confirmar ${ref}`)
  for (const f of ['app.sql', 'usuarios.sql']) {
    if (!existsSync(join(dir, f))) throw new Error(`No encontré ${join(dir, f)} (¿descifraste y descomprimiste el respaldo?)`)
  }
  // Solo en un proyecto nuevo: nunca encima de una base con datos.
  const [check] = await sql(
    ref,
    `select to_regclass('public.products') is null as vacio, (select count(*) from auth.users) as usuarios`,
    true,
  )
  if (!check.vacio || Number(check.usuarios) > 0) {
    throw new Error(`El proyecto ${ref} no está vacío. Solo se restaura en un proyecto nuevo.`)
  }

  console.log(`Restaurando ${dir} en ${ref}`)
  let conn = await dbLogin(ref, { readOnly: false })
  psql(conn, RESTORE_PRELUDE, 'permisos previos')
  console.log('  1/3 usuarios')
  psql(conn, readFileSync(join(dir, 'usuarios.sql')), 'usuarios.sql')
  console.log('  2/3 base de la app')
  conn = await dbLogin(ref, { readOnly: false })
  psql(conn, restorableAppSql(readFileSync(join(dir, 'app.sql'), 'utf8')), 'app.sql')

  console.log('  3/3 archivos')
  const { service } = await apiKeys(ref)
  const storageDir = join(dir, 'storage')
  for (const bucket of BUCKETS) {
    const base = join(storageDir, bucket)
    const files = filesUnder(base)
    for (const file of files) {
      const name = file.slice(base.length + 1).split(/[\\/]/)
      const ext = name.at(-1).split('.').pop().toLowerCase()
      const res = await fetch(`https://${ref}.supabase.co/storage/v1/object/${bucket}/${name.map(encodeURIComponent).join('/')}`, {
        method: 'POST',
        headers: {
          apikey: service,
          Authorization: `Bearer ${service}`,
          'Content-Type': MIME[ext] ?? 'application/octet-stream',
          'x-upsert': 'true',
        },
        body: readFileSync(file),
      })
      if (!res.ok) throw new Error(`No se pudo subir ${bucket}/${name.join('/')}: ${res.status} ${await res.text()}`)
    }
    console.log(`  ${bucket}: ${files.length} archivos`)
  }
  console.log(`
Listo. Revisa con: npm run clientes -- estado --ref ${ref}
Falta: cerrar el registro público (Authentication → Sign In / Providers), desplegar
las funciones (npm run clientes -- funciones --ref ${ref}) y apuntar el subdominio del
cliente al proyecto nuevo en src/tenants.json.`)
}

const COMMANDS = {
  estado: cmdEstado,
  migrar: cmdMigrar,
  funciones: cmdFunciones,
  alta: cmdAlta,
  catalogo: cmdCatalogo,
  respaldo: cmdRespaldo,
  restaurar: cmdRestaurar,
  suspender: setStatus('suspendido'),
  reactivar: setStatus('activo'),
}

async function main() {
  const { command, opts, passthrough } = parseArgs(process.argv.slice(2))
  const run = COMMANDS[command]
  if (!run) {
    console.log(`Comandos: ${Object.keys(COMMANDS).join(', ')} (ver el encabezado de scripts/clientes.mjs)`)
    process.exit(command ? 1 : 0)
  }
  await run(opts, passthrough)
}

// Solo corre como comando (las pruebas importan migrationQuery).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\nError: ${e.message}`)
    process.exit(1)
  })
}
