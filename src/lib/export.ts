import { supabase } from './supabase'
import { getSignedUrlsForExport } from './images'
import { LANGUAGE_LABELS, LOCATION_LABELS, MOVEMENT_LABELS, isProductLanguage, type MovementHistoryRow, type Product, type StockLocation } from './types'

type Row = Record<string, string | number | null>

const PAGE = 1000

async function fetchAll<T>(table: string, columns: string, orderBy: string): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    rows.push(...((data ?? []) as T[]))
    if (!data || data.length < PAGE) break
  }
  return rows
}

function localDateTime(iso: string) {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function stamp() {
  return localDateTime(new Date().toISOString()).replace(/[: ]/g, '-').slice(0, 16)
}

/** Qué existencias se exportan: las de una ubicación o tienda + bodega + total. */
export type StockScope = StockLocation | 'total'

export async function buildInventoryRows(scope: StockScope = 'total'): Promise<Row[]> {
  const [products, costs] = await Promise.all([
    fetchAll<Product>(
      'products',
      'id, barcode, name, category, supplier, price, quantity, warehouse_quantity, image_url, description, catalog_product_id, language, created_at',
      'created_at',
    ),
    // Solo un admin recibe costos (vista product_costs).
    fetchAll<{ product_id: string; cost: number | null }>('product_costs', 'product_id, cost', 'product_id'),
  ])
  const costOf = new Map(costs.map((c) => [c.product_id, c.cost]))
  const urls = await getSignedUrlsForExport(products.map((p) => p.image_url ?? ''))
  return products.map((p) => ({
    'Código': p.barcode,
    'Nombre': p.name,
    'Idioma': isProductLanguage(p.language) ? LANGUAGE_LABELS[p.language] : null,
    'Categoría': p.category,
    'Proveedor': p.supplier,
    'Costo': costOf.get(p.id) == null ? null : Number(costOf.get(p.id)),
    'Precio': Number(p.price),
    ...(scope === 'total'
      ? { 'Tienda': p.quantity, 'Bodega': p.warehouse_quantity, 'Total': p.quantity + p.warehouse_quantity }
      : { [`Cantidad (${LOCATION_LABELS[scope].toLowerCase()})`]: scope === 'store' ? p.quantity : p.warehouse_quantity }),
    'URL de imagen': p.image_url ? (urls.get(p.image_url) ?? '') : '',
    'Descripción': p.description,
    'ID TCGplayer': p.catalog_product_id,
    'Fecha de alta': localDateTime(p.created_at),
  }))
}

export async function buildMovementRows(): Promise<Row[]> {
  const rows = await fetchAll<MovementHistoryRow>('movement_history', '*', 'created_at')
  return rows.map((m) => ({
    'Fecha': localDateTime(m.created_at),
    'Código': m.barcode,
    'Producto': m.product_name,
    'Tipo': MOVEMENT_LABELS[m.type] ?? m.type,
    'Ubicación': LOCATION_LABELS[m.location ?? 'store'],
    'Cambio': m.delta,
    'Cantidad resultante': m.quantity_after,
    'Nota': m.note,
    'Usuario': m.created_by_name || m.created_by_email || '',
  }))
}

function csvCell(v: string | number | null) {
  if (v == null) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function download(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

/** CSV UTF-8 con BOM (para que Excel respete los acentos). */
export function exportCsv(rows: Row[], baseName: string) {
  const headers = rows.length ? Object.keys(rows[0]) : []
  const lines = [headers.map(csvCell).join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(','))]
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  download(blob, `${baseName}-${stamp()}.csv`)
}

/** Excel: el código se guarda como texto para no perder ceros ni dígitos. */
export async function exportXlsx(rows: Row[], baseName: string, sheetName: string) {
  // SheetJS se carga solo al exportar (es pesado).
  const { utils, writeFile } = await import('xlsx')
  const ws = utils.json_to_sheet(rows)
  const headers = rows.length ? Object.keys(rows[0]) : []
  // Forzar celdas de código como texto (formato "@").
  const codeCol = headers.indexOf('Código')
  if (codeCol >= 0) {
    for (let r = 1; r <= rows.length; r++) {
      const cell = ws[utils.encode_cell({ r, c: codeCol })]
      if (cell) {
        cell.t = 's'
        cell.v = String(cell.v)
        cell.z = '@'
      }
    }
  }
  ws['!cols'] = headers.map((h) => ({ wch: Math.min(60, Math.max(h.length + 2, ...rows.slice(0, 200).map((r) => String(r[h] ?? '').length + 2))) }))
  const wb = utils.book_new()
  utils.book_append_sheet(wb, ws, sheetName)
  writeFile(wb, `${baseName}-${stamp()}.xlsx`, { compression: true })
}
