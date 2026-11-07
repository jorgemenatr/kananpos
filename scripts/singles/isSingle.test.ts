import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/tcgcsv-productos.json'
import { isSingle } from './isSingle.ts'
import { normalizeProduct } from './providers/tcgcsv.ts'

// Etiquetado a mano: qué es y qué no es una carta suelta (datos reales de TCGCSV).
const EXPECTED: Record<string, boolean> = {
  // Singles
  Victini: true,
  'Basic Fighting Energy': true, // Pokémon Japón, Number "FIG"
  "Brock's Scouting": true, // Rarity "None" pero con número: carta de mazo
  'Citizen // The Monarch Double-Sided Token': true,
  'Klothys, God of Destiny (Showcase)': true,
  'Token: Joey and Red-Eyes Black Dragon': true,
  'DON!! Card': true, // One Piece: sin número, rareza "DON!!"
  Jukebox: true,
  'Howler Pack': true, // carta de Star Wars Unlimited, no un sobre
  'Mordekaiser, Dominating (Alternate Art)': true,
  // Fuera: sellado
  '30th Celebration Booster Pack': false,
  'Guardians Rising Elite Trainer Box': false,
  'MEGA Expansion 30th Celebration Booster Box': false,
  'Theros Beyond Death - Bundle': false,
  'Magnificent Monsters Booster Pack': false,
  'Extra Booster: One Piece Heroines Edition Vol.2 - Booster Box': false,
  'Disney Lorcana: Hyperia City Booster Pack': false,
  'Homeworlds - Booster Display': false,
  'GEM Pack 6 Booster Pack': false,
  'Radiance - Booster Pack': false,
  // Fuera: códigos digitales e insertos
  'Code Card - 30th Celebration Elite Trainer Box': false,
  'Code Card - New Adventure Booster (FB05)': false,
  'Ink Drop': false,
  'Hyperia City Puzzle Insert (Set of 9)': false,
  'Viserai, the Forsaken // Viserai, Usurper Double Sided Art Card (Top Left)': false,
}

describe('isSingle con productos reales de TCGCSV', () => {
  const productos = fixture.productos
  it('la fixture tiene todos los casos etiquetados', () => {
    expect(productos.map((p) => p.name).sort()).toEqual(Object.keys(EXPECTED).sort())
  })
  for (const p of productos) {
    it(`${EXPECTED[p.name] ? '✓' : '✗'} ${p.name}`, () => {
      expect(normalizeProduct(p, p.groupId).isSingle).toBe(EXPECTED[p.name])
    })
  }
})

describe('isSingle: reglas', () => {
  it('Code Card nunca es single, aunque traiga número', () => {
    expect(isSingle({ Rarity: 'Code Card', Number: '001' })).toBe(false)
    expect(isSingle({ Rarity: 'code card' })).toBe(false)
  })
  it('con número es single', () => {
    expect(isSingle({ Number: '199/165' })).toBe(true)
    expect(isSingle({ Number: '038/040', Rarity: 'None' })).toBe(true)
  })
  it('solo rareza (Pokémon japonés antiguo) es single, salvo "None"', () => {
    expect(isSingle({ Rarity: 'Holo Rare' })).toBe(true)
    expect(isSingle({ Rarity: 'None' })).toBe(false)
  })
  it('sin número ni rareza (o vacíos) es sellado', () => {
    expect(isSingle({})).toBe(false)
    expect(isSingle({ Number: '  ', Rarity: '' })).toBe(false)
    expect(isSingle({ UPC: '0820650' })).toBe(false)
  })
})
