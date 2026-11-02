#!/usr/bin/env node
/*
 * Pone foto a los productos que no tienen, a partir de la lista revisada en
 * scripts/fotos-productos.json (código de barras → URL de una foto de
 * producto de TCGplayer, tiendas o Open Food Facts).
 *
 * Uso:
 *   npm run fotos              # descarga, sube al bucket y actualiza products.image_url
 *   npm run fotos -- --prueba  # solo descarga y avisa qué haría, no escribe nada
 *
 * Variables de entorno (en .env.catalogo, las mismas del importador):
 *   SUPABASE_URL               https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  service_role / secret key (NUNCA en el frontend)
 *
 * Solo toca productos que siguen sin foto, así que es seguro correrlo
 * varias veces: no pisa fotos que alguien haya puesto mientras tanto.
 */

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const BUCKET = 'product-images'
const MAX_BYTES = 2 * 1024 * 1024 // límite del bucket
const USER_AGENT = 'inventario-hachiko/1.0 (fotos de productos)'
const TIPOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

const prueba = process.argv.includes('--prueba')
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (ponlas en .env.catalogo).')
  process.exit(1)
}

const headers = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
const lista = JSON.parse(readFileSync(new URL('./fotos-productos.json', import.meta.url), 'utf8'))

async function sinFoto(barcode) {
  const url = `${SUPABASE_URL}/rest/v1/products?select=id,name,image_url&barcode=eq.${encodeURIComponent(barcode)}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`consulta: ${res.status} ${await res.text()}`)
  const [p] = await res.json()
  return p && !p.image_url ? p : null
}

async function descargar(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' } })
  if (!res.ok) throw new Error(`descarga: HTTP ${res.status}`)
  const tipo = (res.headers.get('content-type') ?? '').split(';')[0].trim()
  if (!TIPOS[tipo]) throw new Error(`descarga: tipo no soportado (${tipo || 'desconocido'})`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > MAX_BYTES) throw new Error(`descarga: pesa ${(bytes.length / 1e6).toFixed(1)} MB (máx. 2 MB)`)
  return { bytes, tipo }
}

async function subir({ bytes, tipo }) {
  const path = `products/${randomUUID()}.${TIPOS[tipo]}`
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': tipo, 'x-upsert': 'false' },
    body: bytes,
  })
  if (!res.ok) throw new Error(`subida: ${res.status} ${await res.text()}`)
  return path
}

async function guardar(id, path) {
  // image_url=is.null: si alguien le puso foto mientras tanto, no se pisa.
  const res = await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${id}&image_url=is.null`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ image_url: path }),
  })
  if (!res.ok) throw new Error(`actualización: ${res.status} ${await res.text()}`)
}

let ok = 0, saltados = 0, fallos = 0
for (const item of lista) {
  try {
    const p = await sinFoto(item.barcode)
    if (!p) {
      saltados++
      console.log(`·  ${item.nombre}: ya tiene foto o no existe, se salta`)
      continue
    }
    const img = await descargar(item.url)
    if (prueba) {
      console.log(`?  ${p.name}: ${img.tipo}, ${(img.bytes.length / 1024).toFixed(0)} KB (${item.fuente})`)
      ok++
      continue
    }
    const path = await subir(img)
    await guardar(p.id, path)
    ok++
    console.log(`✓  ${p.name} (${item.fuente})`)
  } catch (e) {
    fallos++
    console.log(`✗  ${item.nombre}: ${e.message}`)
  }
}
console.log(`\n${prueba ? 'Prueba: ' : ''}${ok} con foto, ${saltados} saltados, ${fallos} con error.`)
if (fallos) process.exitCode = 1
