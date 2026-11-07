/*
 * Modo demo: catálogo de singles de muestra (cartas reales de TCGplayer, con
 * su imagen del CDN) para revisar Configuración → Singles y juegos, Alta de
 * singles, Revisar precios, la ficha y el mostrador sin una base real.
 */
import type { Product } from '../types'

type Row = Record<string, unknown>

const now = Date.now()
const ago = (min: number) => new Date(now - min * 60_000).toISOString()
const AS_OF = ago(9 * 60)
const img = (id: number) => `https://tcgplayer-cdn.tcgplayer.com/product/${id}_200w.jpg`

const games: Row[] = [
  { id: 1, slug: 'pokemon', display_name: 'Pokémon', sort_order: 1, product_count: 28750, catalog_status: 'ready', enabled: true },
  { id: 2, slug: 'pokemon-japan', display_name: 'Pokémon Japón', sort_order: 2, product_count: 0, catalog_status: 'empty', enabled: false },
  { id: 3, slug: 'magic', display_name: 'Magic: The Gathering', sort_order: 3, product_count: 0, catalog_status: 'empty', enabled: false },
  { id: 4, slug: 'yugioh', display_name: 'Yu-Gi-Oh!', sort_order: 4, product_count: 0, catalog_status: 'empty', enabled: false },
  { id: 5, slug: 'one-piece', display_name: 'One Piece', sort_order: 5, product_count: 6120, catalog_status: 'ready', enabled: true },
  { id: 6, slug: 'lorcana', display_name: 'Disney Lorcana', sort_order: 6, product_count: 0, catalog_status: 'empty', enabled: false },
  { id: 7, slug: 'digimon', display_name: 'Digimon', sort_order: 7, product_count: 0, catalog_status: 'empty', enabled: false },
  { id: 8, slug: 'dragon-ball-fusion-world', display_name: 'Dragon Ball Super Fusion World', sort_order: 8, product_count: 0, catalog_status: 'empty', enabled: false },
  { id: 9, slug: 'star-wars-unlimited', display_name: 'Star Wars Unlimited', sort_order: 9, product_count: 0, catalog_status: 'empty', enabled: false },
  { id: 10, slug: 'flesh-and-blood', display_name: 'Flesh and Blood', sort_order: 10, product_count: 0, catalog_status: 'empty', enabled: false },
  { id: 11, slug: 'riftbound', display_name: 'Riftbound', sort_order: 11, product_count: 1793, catalog_status: 'ready', enabled: false },
].map((g) => ({ is_supported: true, status_message: null, status_at: null, last_synced_at: AS_OF, prices_as_of: g.product_count ? AS_OF : null, ...g }))

// [id, juego, set, código del set, nombre, número, rareza, [[subtipo, market, mid]]]
type Card = [number, number, string, string, string, string, string, [string, number | null, number | null][]]
const CARDS: Card[] = [
  [717605, 1, 'ME: 30th Celebration', '30C', 'Mew ex', '152/128', 'Special Illustration Rare', [['Holofoil', 63.36, 80.15]]],
  [717610, 1, 'ME: 30th Celebration', '30C', 'Gengar ex', '154/128', 'Special Illustration Rare', [['Holofoil', 52.37, 65]]],
  [712954, 1, 'ME: 30th Celebration', '30C', 'Pikachu ex', '150/128', 'Special Illustration Rare', [['Holofoil', 41.42, 53.4]]],
  [717607, 1, 'ME: 30th Celebration', '30C', 'Mew - R/RGB', 'R/RGB', 'RGB Rare', [['Holofoil', 4492.45, 4499.99]]],
  [716442, 1, 'ME: 30th Celebration', '30C', 'Vivillon', '008/128', 'Common', [['Normal', 0.1, 0.15], ['Reverse Holofoil', 0.14, 0.2]]],
  [716439, 1, 'ME: 30th Celebration', '30C', 'Tropius', '005/128', 'Common', [['Normal', null, 0.2], ['Reverse Holofoil', null, null]]],
  [726218, 5, 'Extra Booster: One Piece Heroines Edition Vol. 2', 'EB05', 'Nico Robin (Super Leader Alternate Art)', 'EB05-010', 'L', [['Foil', 1251.01, 2475]]],
  [718677, 5, 'Extra Booster: One Piece Heroines Edition Vol. 2', 'EB05', 'Shirahoshi (Manga)', 'EB05-014', 'SR', [['Foil', 558.16, 689.99]]],
  [712884, 5, 'Extra Booster: One Piece Heroines Edition Vol. 2', 'EB05', 'Nami (OP01-016) (SP)', 'OP01-016', 'R', [['Foil', 467.79, 469.98]]],
  [714558, 5, 'Extra Booster: One Piece Heroines Edition Vol. 2', 'EB05', 'Speed', 'EB05-035', 'C', [['Normal', 0.04, 0.1], ['Foil', 0.3, 0.5]]],
]

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

const searchRow = (c: Card) => ({
  id: c[0],
  game_id: c[1],
  game_name: games.find((g) => g.id === c[1])?.display_name,
  set_id: c[1] * 1000,
  set_name: c[2],
  set_code: c[3],
  release_date: '2026-09-26',
  name: c[4],
  number: c[5],
  rarity: c[6],
  image_url: img(c[0]),
  prices: c[7].map(([subtype, market, mid]) => ({ subtype, market_usd: market, mid_usd: mid, low_usd: null, fetched_at: AS_OF })),
  prices_as_of: AS_OF,
})

// Singles en el inventario: [carta, subtipo, estado, idioma, precio, tienda, bodega, costo]
type Cond = 'NM' | 'LP' | 'MP' | 'HP' | 'DMG'
type Rest = [subtype: string, condition: Cond, language: 'en' | 'es' | 'ja', price: number, store: number, warehouse: number, cost: number]
type Single = [number, ...Rest]
const SINGLES: Single[] = [
  [717605, 'Holofoil', 'NM', 'en', 1100, 2, 0, 700],
  [717605, 'Holofoil', 'LP', 'en', 1050, 1, 0, 600],
  [717610, 'Holofoil', 'NM', 'en', 1050, 1, 1, 650],
  [712954, 'Holofoil', 'NM', 'es', 700, 3, 0, 400],
  [716442, 'Reverse Holofoil', 'NM', 'en', 5, 12, 0, 1],
  [726218, 'Foil', 'NM', 'en', 22000, 1, 0, 18000],
  [712884, 'Foil', 'MP', 'en', 9000, 1, 0, 5000],
]

const singleName = (c: Card, subtype: string, cond: string) =>
  `${c[4]} (${c[5]}) · ${c[3]}${subtype === 'Normal' ? '' : ` · ${subtype}`} · ${cond}`

export function demoSingles(products: Product[], prefix = 'DEMO') {
  const makeProduct = (c: Card, s: Rest, i: number): Product => ({
    id: `sg${i}`,
    barcode: `${prefix}-${String(900 + i).padStart(5, '0')}`,
    name: singleName(c, s[0], s[1]),
    category: c[1] === 1 ? 'TCG · Pokémon' : 'TCG · One Piece',
    supplier: 'Distribuidora Kanto',
    supplier_id: 's1',
    cost: s[6],
    price: s[3],
    quantity: s[4],
    warehouse_quantity: s[5],
    image_url: img(c[0]),
    is_internal_code: true,
    track_stock: true,
    is_preorder: false,
    preorder_deposit_type: 'percent',
    preorder_deposit_value: 0,
    is_combo: false,
    description: null,
    catalog_product_id: null,
    language: s[2],
    tcg_product_id: c[0],
    tcg_subtype: s[0],
    card_condition: s[1],
    created_by: 'demo-admin',
    created_at: ago(5000 - i),
    updated_at: ago(100),
  })
  SINGLES.forEach(([id, ...rest], i) => products.push(makeProduct(CARDS.find((c) => c[0] === id)!, rest, i)))

  const rules: Row = {
    id: true,
    usd_mxn_rate: 20,
    multiplier: 1,
    rounding: '5',
    condition_percentages: { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 30 },
    min_price: 5,
    review_threshold_pct: 10,
    rate_updated_at: ago(60 * 26),
    rate_updated_by: 'demo-admin',
  }

  const tables: Record<string, Row[]> = {
    tcg_game_settings: games,
    store_pricing_rules: [rules],
    fx_rate_history: [
      { id: 2, old_rate: 19.5, new_rate: 20, changed_at: ago(60 * 26), changed_by_name: 'Admin Demo', changed_by_email: 'admin@demo.mx' },
      { id: 1, old_rate: null, new_rate: 19.5, changed_at: ago(60 * 24 * 12), changed_by_name: 'Admin Demo', changed_by_email: 'admin@demo.mx' },
    ],
  }

  const cardOf = (id: unknown) => CARDS.find((c) => c[0] === Number(id))
  const enabled = (gameId: number) => games.find((g) => g.id === gameId)?.enabled === true

  const reference = (p: Product) => {
    const c = cardOf(p.tcg_product_id)!
    const price = c[7].find(([s]) => s === p.tcg_subtype)
    return {
      product_id: p.id,
      barcode: p.barcode,
      name: p.name,
      price: p.price,
      quantity: p.quantity,
      warehouse_quantity: p.warehouse_quantity,
      language: p.language,
      image_url: p.image_url,
      tcg_product_id: c[0],
      tcg_subtype: p.tcg_subtype,
      card_condition: p.card_condition,
      card_name: c[4],
      card_number: c[5],
      set_name: c[2],
      game_id: c[1],
      game_name: games.find((g) => g.id === c[1])?.display_name,
      market_usd: price?.[1] ?? null,
      mid_usd: price?.[2] ?? null,
      price_fetched_at: AS_OF,
      prices_as_of: AS_OF,
      fifo_cost: p.cost,
    }
  }

  const rpcs: Record<string, (a: Row) => unknown> = {
    search_singles: (a) => {
      const words = norm(String(a.p_query ?? '')).split(/\s+/).filter(Boolean)
      return CARDS.filter((c) => enabled(c[1]) && (a.p_game_id == null || c[1] === Number(a.p_game_id)))
        .filter((c) => words.every((w) => norm(`${c[4]} ${c[5]} ${c[2]} ${c[3]}`).includes(w)))
        .map(searchRow)
    },
    single_variants: (a) =>
      products
        .filter((p) => p.tcg_product_id === Number(a.p_tcg_product_id))
        .map((p) => ({
          product_id: p.id,
          barcode: p.barcode,
          tcg_subtype: p.tcg_subtype,
          card_condition: p.card_condition,
          language: p.language,
          price: p.price,
          quantity: p.quantity,
          warehouse_quantity: p.warehouse_quantity,
        })),
    add_single_stock: (a) => {
      const c = cardOf(a.p_tcg_product_id)
      if (!c) throw new Error('Esa carta no está en el catálogo')
      const qty = Number(a.p_quantity ?? 0)
      if (qty > 0 && !a.p_supplier_id) throw new Error('Elige el proveedor')
      let p = products.find(
        (x) => x.tcg_product_id === c[0] && x.tcg_subtype === a.p_subtype && x.card_condition === a.p_condition && x.language === a.p_language,
      )
      const created = !p
      if (!p) {
        if (a.p_price == null) throw new Error('Escribe el precio de venta')
        p = makeProduct(c, [String(a.p_subtype), a.p_condition as Cond, a.p_language as Rest[2], Number(a.p_price), 0, 0, Number(a.p_unit_cost ?? 0)], products.length)
        products.push(p)
      }
      if (a.p_location === 'warehouse') p.warehouse_quantity += qty
      else p.quantity += qty
      if (qty > 0) p.cost = Number(a.p_unit_cost)
      return { status: 'ok', created, product: p, purchase_id: null }
    },
    singles_reference: (a) => {
      const ids = a.p_product_ids as string[] | null
      return products.filter((p) => p.tcg_product_id && (!ids || ids.includes(p.id))).map(reference)
    },
    apply_single_prices: (a) => {
      let applied = 0
      const skipped: Row[] = []
      for (const i of a.p_items as { product_id: string; price: number; expected_price?: number }[]) {
        const p = products.find((x) => x.id === i.product_id)
        if (!p) continue
        if (i.expected_price != null && p.price !== i.expected_price) {
          skipped.push({ product_id: i.product_id, reason: 'el precio cambió' })
          continue
        }
        p.price = i.price
        applied++
      }
      return { applied, skipped }
    },
    set_tcg_game_enabled: (a) => {
      const g = games.find((x) => x.id === Number(a.p_game_id))!
      g.enabled = Boolean(a.p_enabled)
      if (g.enabled && g.catalog_status === 'empty') g.catalog_status = 'pending'
      return { game_id: g.id, slug: g.slug, enabled: g.enabled, catalog_status: g.catalog_status, stock: 0 }
    },
    tcg_game_stock: (a) =>
      products
        .filter((p) => p.tcg_product_id && cardOf(p.tcg_product_id)?.[1] === Number(a.p_game_id))
        .reduce((s, p) => s + p.quantity + p.warehouse_quantity, 0),
  }

  return { tables, rpcs }
}
