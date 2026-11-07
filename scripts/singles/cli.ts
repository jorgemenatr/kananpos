/*
 * Catálogo de singles: sincronización y administración.
 *
 * Uso (npm run singles -- <comando> …):
 *   sync [--juego magic,pokemon] [--ref <id>] [--forzar] [--sin-copiar] [--solo-copiar]
 *        Descarga del proveedor al catálogo central los juegos activos en
 *        alguna tienda (o los de --juego) y los copia a cada tienda.
 *        --ref limita la copia a una tienda; con --juego copia ese juego
 *        aunque la tienda todavía no lo tenga activo (carga inicial).
 *        --forzar baja todo aunque el proveedor no haya cambiado.
 *   juegos                 Lista curada y su ID en el proveedor (1 petición).
 *   muestra --juego <slug> [--sets 3]
 *        Baja unos sets SIN guardar nada y muestra qué cuenta como single y
 *        qué queda fuera (para revisar la regla is_single).
 *   sellado [--juegos pokemon,dragon-shield] [--ref <id>] [--sin-descargar]
 *        Catálogo de PRODUCTO SELLADO y accesorios: descarga UNA vez al central
 *        las fuentes que usa alguna tienda (scripts/importar-catalogo.mjs
 *        --central) y copia a cada tienda solo las suyas. Lo corre el workflow
 *        "Importar catálogo TCG" (lunes).
 *   corridas [--n 20]      Últimas corridas registradas en catalog_sync_runs.
 *   migrar-central [--prueba]
 *        Aplica supabase/catalogo/migrations al proyecto central (CATALOGO_REF).
 *
 * Variables (en .env.clientes o en los secrets de GitHub Actions):
 *   SUPABASE_ACCESS_TOKEN   token personal de Supabase (llaves de cada proyecto)
 *   CATALOGO_REF            ID del proyecto central (kananpos-catalogo)
 *   CATALOG_PROVIDER        tcgcsv (por defecto) | tcgapi
 *   TCGAPI_KEY              solo con CATALOG_PROVIDER=tcgapi
 *   CLIENTES                opcional: IDs de tiendas en vez de src/tenants.json
 *
 * Nada de esto corre en el navegador.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadCuratedGames, resolveGames } from './games.ts'
import { createProvider } from './providers/index.ts'
import { TcgCsvProvider } from './providers/tcgcsv.ts'
import { CentralRest, TenantRest } from './stores.ts'
import { copySealed, planSealed, SEALED_COLUMNS, type SealedCentral, type SealedRow, type SealedTenant } from './sealed.ts'
import { centralClient, RestError, runSql, tenantClient, tenantRefs } from './supabase.ts'
import { runSync, type SyncSummary, type TenantStore } from './sync.ts'

type Opts = Record<string, string | true>

function parseArgs(argv: string[]): { command: string | undefined; opts: Opts } {
  const [command, ...rest] = argv
  const opts: Opts = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) throw new Error(`Argumento inesperado: ${a}`)
    const [k, inline] = a.slice(2).split(/=(.*)/s)
    if (inline !== undefined) opts[k] = inline
    else if (rest[i + 1] && !rest[i + 1].startsWith('--')) opts[k] = rest[++i]
    else opts[k] = true
  }
  return { command, opts }
}

const str = (v: string | true | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function slugList(v: string | true | undefined): string[] | undefined {
  const s = str(v)
  if (!s) return undefined
  const list = s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
  for (const x of list) if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(x)) throw new Error(`Juego inválido: "${x}"`)
  return list
}

function refArg(v: string | true | undefined): string | undefined {
  const s = str(v)
  if (s && !/^[a-z0-9]{10,40}$/.test(s)) throw new Error(`--ref inválido: "${s}"`)
  return s
}

// ---------- sync ----------
async function cmdSync(opts: Opts) {
  const provider = createProvider(str(opts.proveedor) ?? process.env.CATALOG_PROVIDER ?? 'tcgcsv')
  const { rest } = await centralClient()
  const central = new CentralRest(rest)
  const onlyRef = refArg(opts.ref)
  const tenants: TenantStore[] = []
  for (const t of tenantRefs(onlyRef)) {
    try {
      tenants.push(new TenantRest(t.ref, t.name, await tenantClient(t)))
    } catch (e) {
      console.warn(`⚠️ ${t.name}: ${(e as Error).message}`)
    }
  }
  const started = Date.now()
  const summary = await runSync(
    { provider, central, tenants, curated: loadCuratedGames() },
    {
      games: slugList(opts.juego),
      singleTenant: Boolean(onlyRef),
      force: opts.forzar === true,
      skipDownload: opts['solo-copiar'] === true,
      skipCopy: opts['sin-copiar'] === true,
      log: (m) => console.log(m),
    },
  )
  const requests = provider instanceof TcgCsvProvider ? provider.requestCount : null
  report(summary, requests, Date.now() - started)
  if ([...summary.downloads, ...summary.copies].some((r) => r.status === 'error')) process.exitCode = 1
}

function report(s: SyncSummary, requests: number | null, ms: number) {
  for (const w of s.warnings) console.warn(`⚠️ ${w}`)
  const fmt = (n: number | undefined) => (n ?? 0).toLocaleString('es-MX')
  const lines = [
    '### Catálogo de singles',
    '',
    `Dato del proveedor: ${s.sourceUpdatedAt ?? 'sin fecha'} · ${requests ?? '?'} peticiones al proveedor · ${Math.round(ms / 1000)} s`,
    '',
    '| Juego | Estado | Sets | Cartas nuevas | Cartas cambiadas | Precios nuevos | Precios cambiados | Sets con error |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...s.downloads.map(
      (d) =>
        `| ${d.slug} | ${d.status} | ${fmt(d.counts.sets)} | ${fmt(d.counts.products_inserted)} | ${fmt(d.counts.products_updated)} | ${fmt(d.counts.prices_inserted)} | ${fmt(d.counts.prices_updated)} | ${d.errors.length} |`,
    ),
    '',
    '| Tienda | Juego | Estado | Cartas copiadas | Precios copiados |',
    '| --- | --- | --- | ---: | ---: |',
    ...s.copies.map((c) => `| ${c.tenant} | ${c.slug} | ${c.status} | ${fmt(c.counts.products)} | ${fmt(c.counts.prices)} |`),
    ...(s.warnings.length ? ['', ...s.warnings.map((w) => `- ⚠️ ${w}`)] : []),
    '',
  ]
  console.log(`\n${lines.join('\n')}`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'))
  for (const d of s.downloads.filter((x) => x.status === 'partial')) {
    console.log(`::warning::${d.slug}: ${d.errors.length} set(s) con error (ver catalog_sync_runs)`)
  }
}

// ---------- producto sellado ----------
async function cmdSellado(opts: Opts) {
  const fuentes = JSON.parse(readFileSync(new URL('../../src/lib/catalogSources.json', import.meta.url), 'utf8')) as {
    juegos: Record<string, unknown>
    accesorios: Record<string, unknown>
  }
  const known = new Set([...Object.keys(fuentes.juegos), ...Object.keys(fuentes.accesorios)])
  const only = slugList(opts.juegos)
  for (const j of only ?? []) if (!known.has(j)) throw new Error(`Fuente desconocida: "${j}". Disponibles: ${[...known].join(', ')}`)

  const { rest: central } = await centralClient()
  const tenants: SealedTenant[] = []
  for (const t of tenantRefs(refArg(opts.ref))) {
    try {
      const db = await tenantClient(t)
      tenants.push({
        ref: t.ref,
        name: t.name,
        enabledSources: async () => {
          try {
            return await db.rpc<string[]>('enabled_catalog_sources', {})
          } catch (e) {
            if (e instanceof RestError && (e.status === 404 || e.code === 'PGRST202')) return null
            throw e
          }
        },
        upsert: (rows) => db.upsert('catalog_products', rows, 'id', 500),
      })
    } catch (e) {
      console.warn(`⚠️ ${t.name}: ${(e as Error).message}`)
    }
  }

  const plan = await planSealed(tenants, known, only)
  for (const w of plan.warnings) console.warn(`⚠️ ${w}`)
  if (!plan.download.length) {
    console.log('Ninguna tienda tiene fuentes del catálogo ligadas a sus categorías: no hay nada que importar.')
    return
  }

  // 1. Una sola descarga al central.
  if (opts['sin-descargar'] !== true) {
    console.log(`Descargando al catálogo central: ${plan.download.join(', ')}`)
    const importer = fileURLToPath(new URL('../importar-catalogo.mjs', import.meta.url))
    const r = spawnSync(process.execPath, [importer, '--central', '--juegos', plan.download.join(',')], {
      stdio: 'inherit',
      env: { ...process.env, SUPABASE_URL: central.url, SUPABASE_SERVICE_ROLE_KEY: central.key },
    })
    // Si falló a medias, igual se copia lo que ya está en el central.
    if (r.status !== 0) {
      console.warn('⚠️ La descarga terminó con error; se copia a las tiendas lo que ya hay en el central.')
      process.exitCode = 1
    }
  }

  // 2. Copia a cada tienda solo sus fuentes.
  const reader: SealedCentral = {
    page: (source, after, limit) =>
      central.select<SealedRow>(
        `catalog_products?select=${SEALED_COLUMNS}&source=eq.${encodeURIComponent(source)}&id=gt.${after}&order=id&limit=${limit}`,
      ),
  }
  const lines = ['', '### Copia a las tiendas', '', '| Tienda | Fuente | Productos |', '| --- | --- | ---: |']
  for (const { tenant, sources, withSource } of plan.tenants) {
    try {
      const counts = await copySealed(reader, tenant, sources, withSource)
      for (const [source, n] of Object.entries(counts)) lines.push(`| ${tenant.name} | ${source} | ${n.toLocaleString('es-MX')} |`)
      console.log(`  → ${tenant.name}: ${JSON.stringify(counts)}`)
    } catch (e) {
      lines.push(`| ${tenant.name} | — | error: ${(e as Error).message} |`)
      console.error(`  → ${tenant.name}: ${(e as Error).message}`)
      process.exitCode = 1
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
}

// ---------- juegos ----------
async function cmdJuegos() {
  const provider = createProvider(process.env.CATALOG_PROVIDER ?? 'tcgcsv')
  const resolved = resolveGames(loadCuratedGames(), await provider.listGames(), provider.id)
  console.table(resolved.map((g) => ({ slug: g.slug, juego: g.display_name, id_proveedor: g.external_id, nombre_proveedor: g.name })))
}

// ---------- muestra ----------
async function cmdMuestra(opts: Opts) {
  const slug = slugList(opts.juego)?.[0]
  if (!slug) throw new Error('Usa --juego <slug>')
  const n = Number(str(opts.sets) ?? 3)
  const provider = new TcgCsvProvider()
  const game = resolveGames(loadCuratedGames(), await provider.listGames(), provider.id).find((g) => g.slug === slug)
  if (!game) throw new Error(`Juego desconocido: ${slug}`)
  const sets = (await provider.listSets(game.external_id))
    .sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))
    .slice(0, n)
  for (const s of sets) {
    const products = await provider.listProducts(game.external_id, s.externalId)
    const out = products.filter((p) => !p.isSingle)
    console.log(`\n${s.name}: ${products.length - out.length} singles · ${out.length} fuera`)
    for (const p of out.slice(0, 12)) console.log(`   ✗ ${p.name}${p.rarity ? ` (Rarity: ${p.rarity})` : ''}`)
  }
  console.log(`\n${provider.requestCount} peticiones`)
}

// ---------- corridas ----------
async function cmdCorridas(opts: Opts) {
  const { rest } = await centralClient()
  const n = Math.min(Number(str(opts.n) ?? 20), 200)
  const rows = await rest.select<Record<string, unknown>>(
    `catalog_sync_runs?select=id,kind,target,status,started_at,finished_at,counts,error,tcg_games(slug)&order=id.desc&limit=${n}`,
  )
  console.table(
    rows.map((r) => ({
      id: r.id,
      juego: (r.tcg_games as { slug?: string } | null)?.slug,
      tipo: r.kind,
      tienda: r.target,
      estado: r.status,
      inicio: r.started_at,
      error: r.error,
    })),
  )
}

// ---------- migraciones del central ----------
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`

async function cmdMigrarCentral(opts: Opts) {
  const ref = process.env.CATALOGO_REF
  if (!ref) throw new Error('Falta CATALOGO_REF (ID del proyecto kananpos-catalogo).')
  const dir = new URL('../../supabase/catalogo/migrations/', import.meta.url)
  const local = readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const [, version, name] = file.match(/^(\d+)_(.+)\.sql$/) as RegExpMatchArray
      return { file, version, name, sql: readFileSync(new URL(file, dir), 'utf8') }
    })
  const rows = (await runSql(
    ref,
    `select coalesce((select array_agg(version) from supabase_migrations.schema_migrations), '{}') as versions`,
  ).catch(() => [{ versions: [] }])) as { versions: string[] }[]
  const applied = new Set(rows[0]?.versions ?? [])
  const pending = local.filter((m) => !applied.has(m.version))
  if (!pending.length) return console.log(`${ref}: al día`)
  for (const m of pending) {
    if (opts.prueba) {
      console.log(`${ref}: pendiente ${m.file}`)
      continue
    }
    process.stdout.write(`${ref}: ${m.file} … `)
    await runSql(
      ref,
      `begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
${m.sql}
;
insert into supabase_migrations.schema_migrations (version, statements, name)
values (${lit(m.version)}, array[${lit(m.sql)}], ${lit(m.name)});
commit;`,
    )
    console.log('ok')
  }
}

const COMMANDS: Record<string, (opts: Opts) => Promise<void>> = {
  sync: cmdSync,
  sellado: cmdSellado,
  juegos: cmdJuegos,
  muestra: cmdMuestra,
  corridas: cmdCorridas,
  'migrar-central': cmdMigrarCentral,
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2))
  const run = command ? COMMANDS[command] : undefined
  if (!run) {
    console.log(`Comandos: ${Object.keys(COMMANDS).join(', ')} (ver el encabezado de scripts/singles/cli.ts)`)
    process.exit(command ? 1 : 0)
  }
  await run(opts)
}

main().catch((e) => {
  console.error(`\nError: ${(e as Error).message}`)
  process.exit(1)
})
