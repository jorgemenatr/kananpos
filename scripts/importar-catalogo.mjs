#!/usr/bin/env node
/*
 * Importa el catálogo de PRODUCTO SELLADO y ACCESORIOS de TCGplayer (vía
 * https://tcgcsv.com, espejo público y gratuito que se actualiza a diario) a
 * la tabla `catalog_products` de Supabase.
 *
 * Uso:
 *   npm run catalogo                          # los juegos que vende el negocio, todo el historial
 *   npm run catalogo -- --juegos pokemon,magic
 *   npm run catalogo -- --juegos dragon-shield,ultra-pro-pokemon
 *   npm run catalogo -- --desde 2025-01-01    # solo sets publicados desde esa fecha
 *   npm run catalogo -- --prueba              # no escribe nada: guarda un JSON local
 *   ... --central --juegos a,b                # escribe en el catálogo CENTRAL (kananpos-catalogo);
 *                                             # lo usa `npm run singles -- sellado`, que luego
 *                                             # copia a cada tienda solo sus fuentes
 *
 * Variables de entorno (en .env.catalogo o en los secrets de GitHub Actions):
 *   SUPABASE_URL               https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  service_role / secret key (NUNCA en el frontend)
 *
 * Sin --juegos se importan las fuentes ligadas a las categorías del negocio
 * (Configuración → Categorías en la app; product_categories.catalog_sources).
 *
 * Es seguro correrlo las veces que quieras: actualiza lo que ya existe (upsert
 * por productId) y nunca borra filas, así que los vínculos con el inventario
 * no se pierden.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const TCGCSV = 'https://tcgcsv.com/tcgplayer'
// Reglas de TCGCSV (https://tcgcsv.com/docs): User-Agent propio con versión y
// una pausa entre peticiones; de una en una, nunca en paralelo.
const USER_AGENT = 'KananPOS-CatalogImport/1.1.0'
const CONCURRENCY = 1
const PAUSE_MS = 150
const BATCH = 500

// Fuentes que se pueden importar: src/lib/catalogSources.json (la misma lista
// que muestra la app en Configuración). Para agregar otra, súmala ahí.
//   categorias: categoryIds de TCGplayer (https://tcgcsv.com/tcgplayer/categories)
//   nombre:     lo que se guarda como "juego"
//   grupo:      solo los sets/grupos cuyo nombre coincide
//   producto:   solo los productos cuyo nombre coincide
//   tema:       ...o cuyo Theme de TCGplayer coincide (p. ej. "Arceus 9-Pocket PRO-Binder")
//   temaPermitido: solo los productos cuyo Theme coincide (Ultra Pro sin licencia)
//   excluir:    nunca los productos cuyo nombre coincide (Magic, Warhammer, D&D…)
const FUENTES = JSON.parse(readFileSync(new URL('../src/lib/catalogSources.json', import.meta.url), 'utf8'))
const JUEGOS = Object.fromEntries(
  Object.entries({ ...FUENTES.juegos, ...FUENTES.accesorios }).map(([key, f]) => [
    key,
    {
      categorias: f.categorias,
      nombre: f.nombre,
      grupo: f.grupo ? new RegExp(f.grupo, 'i') : undefined,
      producto: f.producto ? new RegExp(f.producto, 'i') : undefined,
      tema: f.tema ? new RegExp(f.tema, 'i') : undefined,
      temaPermitido: f.temaPermitido ? new RegExp(f.temaPermitido, 'i') : undefined,
      excluir: f.excluir ? new RegExp(f.excluir, 'i') : undefined,
    },
  ]),
)
// Bases sin categorías configurables (antes de 20261020000200): lo de siempre.
const ANTERIORES = ['pokemon', 'magic', 'yugioh', 'lorcana', 'flesh-and-blood', 'dragon-shield', 'ultra-pro-pokemon']

// ---------- argumentos ----------
function parseArgs(argv) {
  // null = los que vende el negocio (se leen de la base).
  const args = { juegos: null, desde: null, prueba: false, central: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = a.includes('=') ? a.split('=').slice(1).join('=') : argv[++i]
      if (!v) throw new Error(`Falta el valor de ${a}`)
      return v
    }
    if (a.startsWith('--juegos')) args.juegos = value().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    else if (a.startsWith('--desde')) args.desde = value()
    else if (a === '--prueba') args.prueba = true
    else if (a === '--central') args.central = true
    else if (a === '--ayuda' || a === '--help') {
      console.log(`Juegos disponibles: ${Object.keys(JUEGOS).join(', ')}`)
      console.log('Por defecto: los ligados a las categorías del negocio')
      process.exit(0)
    } else throw new Error(`Argumento desconocido: ${a} (usa --ayuda)`)
  }
  for (const j of args.juegos ?? []) {
    if (!(j in JUEGOS)) {
      throw new Error(`Juego desconocido: "${j}". Disponibles: ${Object.keys(JUEGOS).join(', ')}`)
    }
  }
  if (args.desde && !/^\d{4}-\d{2}-\d{2}$/.test(args.desde)) throw new Error('--desde debe ser AAAA-MM-DD')
  if (args.central && !args.juegos?.length) throw new Error('--central necesita --juegos')
  return args
}

// ---------- utilidades ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url, attempt = 1) {
  await sleep(PAUSE_MS)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    if (body.success === false) throw new Error(body.errors?.join('; ') || 'respuesta sin éxito')
    return body.results ?? []
  } catch (e) {
    if (attempt >= 4) throw new Error(`${url}: ${e.message}`)
    await sleep(1000 * 2 ** attempt)
    return getJson(url, attempt + 1)
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i], i)
      }
    }),
  )
  return out
}

function ext(product, ...names) {
  for (const n of names) {
    const v = product.extendedData?.find((e) => e.name === n)?.value
    if (v != null && String(v).trim()) return String(v)
  }
  return null
}

/** HTML de TCGplayer → texto plano. */
function htmlToText(html) {
  if (!html) return null
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&eacute;/g, 'é')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text || null
}

/**
 * Sellado = sin número de carta ni rareza. Las cartas sueltas traen "Number"
 * y/o "Rarity" (las japonesas viejas solo "Rarity"); las Code Cards también.
 */
const isSealed = (p) => !p.extendedData?.some((e) => e.name === 'Number' || e.name === 'Rarity')

/** La imagen por defecto es de 200 px; el CDN también sirve 1000×1000. */
const bigImage = (url) => (url ? url.replace(/_200w\.jpg$/, '_in_1000x1000.jpg') : null)

// ---------- descarga ----------
let categoriesCache = null

/** Importa una categoría de TCGplayer, opcionalmente filtrando grupos y productos. */
async function importCategory(categoryId, { desde, nombre, grupo, producto, tema, temaPermitido, excluir, source } = {}) {
  categoriesCache ??= await getJson(`${TCGCSV}/categories`)
  const category = categoriesCache.find((c) => c.categoryId === categoryId)
  if (!category) throw new Error(`No existe la categoría ${categoryId} en TCGplayer`)
  const game = nombre ?? (category.displayName || category.name)
  // En accesorios los grupos son marcas, no sets: --desde no aplica.
  const accesorio = Boolean(grupo)

  let groups = await getJson(`${TCGCSV}/${categoryId}/groups`)
  if (grupo) groups = groups.filter((g) => grupo.test(g.name ?? ''))
  if (desde && !accesorio) groups = groups.filter((g) => (g.publishedOn ?? '').slice(0, 10) >= desde)

  let done = 0
  const perGroup = await mapLimit(groups, CONCURRENCY, async (g) => {
    const products = await getJson(`${TCGCSV}/${categoryId}/${g.groupId}/products`)
    const prices = await getJson(`${TCGCSV}/${categoryId}/${g.groupId}/prices`).catch(() => [])
    const price = new Map()
    for (const p of prices) {
      // Para sellado casi siempre hay un solo subtipo ("Normal").
      if (!price.has(p.productId) || p.subTypeName === 'Normal') price.set(p.productId, p.marketPrice ?? p.midPrice ?? null)
    }
    done++
    if (process.stdout.isTTY) process.stdout.write(`\r  ${game}: ${done}/${groups.length} grupos`)
    return products
      .filter(
        (p) =>
          isSealed(p) &&
          (!producto || producto.test(p.name ?? '') || tema?.test(ext(p, 'Theme') ?? '')) &&
          (!temaPermitido || temaPermitido.test((ext(p, 'Theme') ?? '').trim())) &&
          !excluir?.test(p.name ?? ''),
      )
      .map((p) => ({
        id: p.productId,
        category_id: categoryId,
        game,
        // Solo en bases con categorías configurables (columna source).
        ...(source ? { source } : {}),
        group_id: g.groupId,
        set_name: g.name ?? null,
        set_code: g.abbreviation || null,
        name: p.name,
        description: htmlToText(ext(p, 'CardText', 'Description', 'OracleText')),
        image_url: bigImage(p.imageUrl),
        upc: ext(p, 'UPC'),
        market_price: price.get(p.productId) ?? null,
        // La fecha del grupo de un accesorio es la de la marca en TCGplayer, no la del producto.
        released_on: (p.presaleInfo?.releasedOn ?? (accesorio ? '' : g.publishedOn) ?? '').slice(0, 10) || null,
        tcgplayer_url: p.url ?? null,
        source_modified_on: p.modifiedOn ?? null,
      }))
  })
  if (process.stdout.isTTY) process.stdout.write('\n')
  return { game, groups: groups.length, rows: perGroup.flat() }
}

// ---------- escritura en Supabase ----------
async function upsert(rows, url, key) {
  const headers = {
    apikey: key,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  }
  // Las llaves "legacy" (service_role) son JWT; las nuevas (sb_secret_…) van solo en apikey.
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`
  const now = new Date().toISOString()
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH).map((r) => ({ ...r, imported_at: now }))
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${url}/rest/v1/catalog_products?on_conflict=id`, {
        method: 'POST',
        headers,
        body: JSON.stringify(chunk),
      })
      if (res.ok) break
      const text = await res.text()
      if (res.status < 500 || attempt >= 4) throw new Error(`Supabase respondió ${res.status}: ${text}`)
      await sleep(1000 * 2 ** attempt)
    }
    if (process.stdout.isTTY) process.stdout.write(`\r  Guardando: ${Math.min(i + BATCH, rows.length)}/${rows.length}`)
  }
  if (process.stdout.isTTY) process.stdout.write('\n')
}

/** En GitHub Actions, deja el resumen como tabla en la página "Summary" de la corrida. */
function writeStepSummary(resumen, total, prueba) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (!file) return
  const fmt = (n) => n.toLocaleString('es-MX')
  const lines = [
    '### Catálogo TCG',
    '',
    '| Fuente | Grupos | Productos | Con código de barras |',
    '| --- | ---: | ---: | ---: |',
    ...resumen.map((r) => `| ${r.juego} | ${fmt(r.grupos)} | ${fmt(r.productos)} | ${fmt(r.con_upc)} |`),
    '',
    prueba
      ? `Modo prueba: no se escribió nada en Supabase (${fmt(total)} productos).`
      : `**${fmt(total)} productos** actualizados en el catálogo.`,
    '',
  ]
  appendFileSync(file, lines.join('\n'))
}

/**
 * Fuentes que vende el negocio (ligadas a sus categorías). null = la base aún
 * no tiene categorías configurables (antes de 20261020000200).
 */
async function enabledSources(url, key) {
  const headers = { apikey: key, 'Content-Type': 'application/json' }
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`
  const res = await fetch(`${url}/rest/v1/rpc/enabled_catalog_sources`, { method: 'POST', headers, body: '{}' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Supabase respondió ${res.status}: ${await res.text()}`)
  return res.json()
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, '')
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
  if (!args.prueba && (!url || !key)) {
    throw new Error(
      'Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY. Copia .env.catalogo.example a .env.catalogo y llénalo ' +
        '(o usa --prueba para solo descargar).',
    )
  }

  // ¿La base guarda la fuente? (también decide qué importar si no hay --juegos)
  // El central no tiene categorías: siempre guarda la fuente y usa --juegos.
  const configured = url && key && !args.central ? await enabledSources(url, key) : null
  const withSource = args.central || configured !== null || (args.prueba && !url)
  if (!args.juegos) {
    if (configured === null) {
      args.juegos = ANTERIORES
    } else {
      const unknown = configured.filter((j) => !(j in JUEGOS))
      if (unknown.length) console.warn(`Fuentes desconocidas en la base (se ignoran): ${unknown.join(', ')}`)
      args.juegos = configured.filter((j) => j in JUEGOS)
      if (!args.juegos.length) {
        console.log('El negocio no tiene juegos del catálogo ligados a sus categorías: no hay nada que importar.')
        return
      }
    }
  }

  console.log(`Juegos: ${args.juegos.join(', ')}${args.desde ? ` · sets desde ${args.desde}` : ''}`)
  const all = []
  const resumen = []
  for (const j of args.juegos) {
    const fuente = JUEGOS[j]
    let grupos = 0
    const rows = []
    for (const id of fuente.categorias) {
      const r = await importCategory(id, { ...fuente, desde: args.desde, source: withSource ? j : undefined })
      grupos += r.groups
      rows.push(...r.rows)
    }
    const conUpc = rows.filter((r) => r.upc).length
    resumen.push({ juego: j, grupos, productos: rows.length, con_upc: conUpc })
    all.push(...rows)
  }
  console.table(resumen)
  // Un mismo productId repetido en un lote hace fallar el upsert.
  const unique = [...new Map(all.map((r) => [r.id, r])).values()]

  if (args.prueba) {
    const file = 'catalogo-prueba.json'
    writeFileSync(file, JSON.stringify(unique, null, 1))
    console.log(`Modo prueba: no se escribió nada en Supabase. ${unique.length} productos en ${file}`)
    writeStepSummary(resumen, unique.length, true)
    return
  }
  await upsert(unique, url, key)
  console.log(`Listo: ${unique.length} productos actualizados en el catálogo.`)
  writeStepSummary(resumen, unique.length, false)
}

main().catch((e) => {
  console.error(`\nError: ${e.message}`)
  process.exit(1)
})
