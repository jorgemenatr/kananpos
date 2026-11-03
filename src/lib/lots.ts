import { supabase } from './supabase'
import type { LotPick, ProductLot, StockLocation, Supplier } from './types'

/*
 * Lotes y proveedores (solo los lee un admin: RLS).
 * Un lote es una entrada de mercancía con su proveedor y su costo; sus piezas
 * pueden estar en tienda y en bodega.
 */

const num = (l: ProductLot): ProductLot => ({ ...l, unit_cost: Number(l.unit_cost) })

/** Lotes con piezas de un producto (todas las ubicaciones o solo una), del más viejo al más nuevo. */
export async function getProductLots(productId: string, location?: StockLocation): Promise<ProductLot[]> {
  let q = supabase
    .from('product_lots')
    .select('*')
    .eq('product_id', productId)
    .order('received_at', { ascending: true })
    .order('number', { ascending: true })
  if (location) q = q.eq('location', location)
  const { data, error } = await q
  if (error) throw error
  return ((data ?? []) as ProductLot[]).map(num)
}

const SUPPLIERS_KEY = 'hachiko.suppliers.v1'

/** Copia local de los proveedores: para capturar compras sin conexión. */
export function cachedSuppliers(): Supplier[] | null {
  try {
    return JSON.parse(localStorage.getItem(SUPPLIERS_KEY) ?? 'null') as Supplier[] | null
  } catch {
    return null
  }
}

export function saveSuppliersCache(list: Supplier[]) {
  try {
    localStorage.setItem(SUPPLIERS_KEY, JSON.stringify(list))
  } catch {
    /* no crítico */
  }
}

export async function listSuppliers(): Promise<Supplier[]> {
  const { data, error } = await supabase.from('suppliers').select('id, name, contact, note').order('name')
  if (error) throw error
  const list = (data ?? []) as Supplier[]
  saveSuppliersCache(list)
  return list
}

/** Crea el proveedor; si ya existe uno con ese nombre (sin importar mayúsculas), lo devuelve. */
export async function createSupplier(name: string): Promise<Supplier> {
  const clean = name.trim().replace(/\s+/g, ' ')
  if (!clean) throw new Error('Escribe el nombre del proveedor.')
  const { data, error } = await supabase.from('suppliers').insert({ name: clean }).select('id, name, contact, note').single()
  if (!error) return data as Supplier
  if (error.code !== '23505') throw error
  const existing = (await listSuppliers()).find((s) => s.name.toLowerCase() === clean.toLowerCase())
  if (!existing) throw error
  return existing
}

/**
 * ¿El servidor pide elegir de qué lote salen las piezas? (hint 'choose_lot').
 * Pasa cuando se bajan existencias y el producto tiene más de un lote ahí.
 */
export function needsLotChoice(error: unknown): boolean {
  return (error as { hint?: string } | null)?.hint === 'choose_lot'
}

/** Quita los renglones en 0 antes de mandar los lotes elegidos. */
export const cleanPicks = (picks: LotPick[]) => picks.filter((p) => p.quantity > 0)
