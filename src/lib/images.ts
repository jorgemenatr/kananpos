import { supabase } from './supabase'

const BUCKET = 'product-images'
const MAX_SIDE = 800
const QUALITY = 0.82

/** Redimensiona (máx. 800px por lado) y comprime a JPEG en el navegador. */
export async function compressImage(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source)
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No se pudo procesar la imagen')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo comprimir la imagen'))), 'image/jpeg', QUALITY),
  )
}

/** Sube la imagen al bucket privado y devuelve su ruta (lo que se guarda en products.image_url). */
export async function uploadProductImage(image: Blob): Promise<string> {
  const path = `products/${crypto.randomUUID()}.jpg`
  const { error } = await supabase.storage.from(BUCKET).upload(path, image, {
    contentType: 'image/jpeg',
    upsert: false,
  })
  if (error) throw error
  return path
}

// Caché de URLs firmadas para no pedirlas en cada render.
const signedCache = new Map<string, { url: string; expires: number }>()
const DISPLAY_TTL_S = 60 * 60

// Las imágenes que se piden en el mismo instante (p. ej. una cuadrícula entera)
// se firman juntas: una petición por cada 100 en lugar de una por imagen.
const pending = new Map<string, Promise<string | null>>()
let batch: { path: string; resolve: (url: string | null) => void }[] = []

function flushBatch() {
  const items = batch
  batch = []
  for (let i = 0; i < items.length; i += 100) {
    const chunk = items.slice(i, i + 100)
    Promise.resolve(supabase.storage.from(BUCKET).createSignedUrls(chunk.map((c) => c.path), DISPLAY_TTL_S))
      .then(({ data }) => {
        const urls = new Map<string, string>()
        for (const item of data ?? []) {
          if (item.path && item.signedUrl) urls.set(item.path, item.signedUrl)
        }
        return urls
      })
      .catch(() => new Map<string, string>())
      .then((urls) => {
        for (const { path, resolve } of chunk) {
          const url = urls.get(path) ?? null
          if (url) signedCache.set(path, { url, expires: Date.now() + DISPLAY_TTL_S * 1000 })
          pending.delete(path)
          resolve(url)
        }
      })
  }
}

/** Imagen externa (la de una carta del catálogo de singles): se usa tal cual. */
export const isExternalImage = (path: string) => /^https:\/\//i.test(path)

export function getSignedImageUrl(path: string): Promise<string | null> {
  if (isExternalImage(path)) return Promise.resolve(path)
  const cached = signedCache.get(path)
  if (cached && cached.expires > Date.now() + 60_000) return Promise.resolve(cached.url)
  const inFlight = pending.get(path)
  if (inFlight) return inFlight
  const p = new Promise<string | null>((resolve) => {
    if (batch.length === 0) setTimeout(flushBatch, 0)
    batch.push({ path, resolve })
  })
  pending.set(path, p)
  return p
}

/** URLs firmadas de larga duración para exportar (por defecto 7 días). */
export async function getSignedUrlsForExport(paths: string[], ttlSeconds = 7 * 24 * 60 * 60) {
  const result = new Map<string, string>()
  const unique = [...new Set(paths.filter(Boolean))]
  for (const p of unique.filter(isExternalImage)) result.set(p, p)
  const own = unique.filter((p) => !isExternalImage(p))
  for (let i = 0; i < own.length; i += 500) {
    const chunk = own.slice(i, i + 500)
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(chunk, ttlSeconds)
    if (error) throw error
    for (const item of data ?? []) {
      if (item.path && item.signedUrl) result.set(item.path, item.signedUrl)
    }
  }
  return result
}
