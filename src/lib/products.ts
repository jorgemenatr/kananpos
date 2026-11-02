import { uploadProductImage } from './images'
import { supabase } from './supabase'
import type { LotPick, MovementHistoryRow, MovementResult, PreorderDepositType, Product, ProductLanguage, StockLocation } from './types'

export interface ProductPatch {
  name: string
  price: number
  cost: number | null
  category: string | null
  supplier: string | null
  description: string | null
  trackStock: boolean
  isPreorder: boolean
  preorderDepositType: PreorderDepositType
  preorderDepositValue: number
  isCombo: boolean
  /** Idioma; null = no aplica. */
  language: ProductLanguage | null
}

// Sin cost: esa columna solo la lee un admin, con la vista product_costs.
const COLUMNS =
  'id, barcode, name, category, supplier, supplier_id, price, quantity, warehouse_quantity, image_url, is_internal_code, track_stock, ' +
  'is_preorder, preorder_deposit_type, preorder_deposit_value, is_combo, description, catalog_product_id, language, created_by, created_at, updated_at'

const num = (p: Product): Product => ({
  ...p,
  price: Number(p.price),
  cost: p.cost == null ? null : Number(p.cost),
  preorder_deposit_value: Number(p.preorder_deposit_value ?? 0),
})

/** Último costo del producto (null si no tiene o si quien consulta no es admin). */
/** Piezas comprometidas en preventas sin entregar (vista product_reservations). */
async function getReserved(id: string): Promise<number> {
  const { data, error } = await supabase.from('product_reservations').select('reserved').eq('product_id', id).maybeSingle()
  if (error) throw error
  return Number((data as { reserved: number } | null)?.reserved ?? 0)
}

async function getCost(id: string): Promise<number | null> {
  const { data, error } = await supabase.from('product_costs').select('cost').eq('product_id', id).maybeSingle()
  if (error) throw error
  const cost = (data as { cost: number | null } | null)?.cost
  return cost == null ? null : Number(cost)
}

export async function getProduct(id: string): Promise<Product | null> {
  const [{ data, error }, cost, reserved] = await Promise.all([
    supabase.from('products').select(COLUMNS).eq('id', id).maybeSingle(),
    getCost(id),
    getReserved(id),
  ])
  if (error) throw error
  return data ? num({ ...(data as unknown as Omit<Product, 'cost'>), cost, preorder_reserved: reserved }) : null
}

/**
 * Edita los datos del producto (no la cantidad: esa cambia con movimientos).
 * image: Blob = foto nueva, null = quitar la foto, undefined = no tocarla.
 */
export async function updateProduct(id: string, patch: ProductPatch, image?: Blob | null): Promise<Product> {
  const row: Partial<Product> = {
    name: patch.name.trim(),
    price: patch.price,
    cost: patch.cost,
    category: patch.category?.trim() || null,
    supplier: patch.supplier?.trim() || null,
    description: patch.description?.trim() || null,
    track_stock: patch.trackStock,
    is_preorder: patch.isPreorder,
    preorder_deposit_type: patch.preorderDepositType,
    preorder_deposit_value: patch.preorderDepositValue,
    is_combo: patch.isCombo,
    language: patch.language,
  }
  if (image === null) row.image_url = null
  else if (image) row.image_url = await uploadProductImage(image)
  const { data, error } = await supabase.from('products').update(row).eq('id', id).select(COLUMNS).single()
  if (error) throw error
  const [cost, reserved] = await Promise.all([getCost(id), getReserved(id)])
  return num({ ...(data as unknown as Omit<Product, 'cost'>), cost, preorder_reserved: reserved })
}

const rpcProduct = (data: unknown) => num((data as MovementResult).product)

/**
 * Desvincula el producto de su código de barras y del catálogo: se queda con
 * un código interno (HCH-) y el código real queda libre.
 */
export async function unlinkProduct(id: string, reason: string): Promise<Product> {
  const { data, error } = await supabase.rpc('unlink_product', {
    p_product_id: id,
    p_reason: reason.trim(),
    p_client_op_id: crypto.randomUUID(),
  })
  if (error) throw error
  return rpcProduct(data)
}

/** Asigna su código de barras real a un producto con código interno (HCH-). */
export async function assignBarcode(id: string, barcode: string): Promise<Product> {
  const { data, error } = await supabase.rpc('assign_barcode', {
    p_product_id: id,
    p_barcode: barcode,
    p_client_op_id: crypto.randomUUID(),
  })
  if (error) throw error
  return rpcProduct(data)
}

export interface AdjustInput {
  location: StockLocation
  /** Si baja: de qué lotes salen las piezas (null = el único lote que hay). */
  lots?: LotPick[] | null
  /** Si sube: proveedor y costo del lote nuevo (null = los últimos del producto). */
  supplierId?: string | null
  unitCost?: number | null
}

/** Fija la cantidad correcta de una ubicación con un ajuste y su motivo. */
export async function adjustStock(id: string, quantity: number, reason: string, opts: AdjustInput): Promise<Product> {
  const { data, error } = await supabase.rpc('adjust_stock', {
    p_product_id: id,
    p_quantity: quantity,
    p_reason: reason.trim(),
    p_client_op_id: crypto.randomUUID(),
    p_location: opts.location,
    p_lots: opts.lots?.length ? opts.lots : null,
    p_supplier_id: opts.supplierId ?? null,
    p_unit_cost: opts.unitCost ?? null,
  })
  if (error) throw error
  return rpcProduct(data)
}

/** Cancela un movimiento (no se borra: queda marcado y se revierte la cantidad). */
export async function cancelMovement(movementId: string, reason: string, lots?: LotPick[] | null): Promise<Product> {
  const { data, error } = await supabase.rpc('cancel_movement', {
    p_movement_id: movementId,
    p_reason: reason.trim(),
    p_client_op_id: crypto.randomUUID(),
    p_lots: lots?.length ? lots : null,
  })
  if (error) throw error
  const res = data as MovementResult
  if (res.status === 'already_undone') throw new Error('Este movimiento ya estaba cancelado.')
  return num(res.product)
}

/** Última vez que se desvinculó este código (para no volver a vincularlo solo). */
export async function findUnlink(barcode: string) {
  const { data, error } = await supabase
    .from('movement_history')
    .select('created_at, product_name, note, created_by_name, created_by_email')
    .eq('type', 'barcode_unlink')
    .eq('old_barcode', barcode)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data as Pick<MovementHistoryRow, 'created_at' | 'product_name' | 'note' | 'created_by_name' | 'created_by_email'> | null
}

/** Nombre del producto del catálogo TCGplayer con el que está vinculado. */
export async function getCatalogName(id: number): Promise<string | null> {
  const { data } = await supabase.from('catalog_products').select('name, game, set_name').eq('id', id).maybeSingle()
  const c = data as { name: string; game: string; set_name: string | null } | null
  return c ? `${c.name} · ${c.game}${c.set_name ? ` · ${c.set_name}` : ''}` : null
}
