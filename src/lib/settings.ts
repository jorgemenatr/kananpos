/*
 * Configuración del negocio (tabla app_settings, una fila por base).
 * Cada cliente tiene su propio proyecto de Supabase: el nombre que muestra la
 * app y el prefijo de los códigos internos salen de su base, no del código.
 *
 * Se guarda una copia local para tenerla sin internet y antes de iniciar
 * sesión (la pantalla de login no puede leer la base).
 */
import { useSyncExternalStore } from 'react'
import { supabase } from './supabase'
import { activeTenant } from './tenant'

export interface AppSettings {
  businessName: string
  /** Prefijo de los códigos internos: "HCH" → HCH-000001. */
  codePrefix: string
  /** Hora (0–23) en que termina el día de operación: las ventas antes de esa hora cuentan para el día anterior. */
  dayCutoffHour: number
  /** Zona horaria de la tienda (IANA). */
  timezone: string
  /** Se pueden pagar abonos de preventa con créditos de tienda. */
  preorderCreditPayments: boolean
  /** Categoría (texto de products.category) cuyos productos son las bebidas de los combos. */
  comboDrinksCategory: string | null
}

const KEY = 'hachiko.ajustes'

const DEFAULTS: AppSettings = {
  // Del registro de clientes: para mostrar el nombre en el login de un equipo nuevo.
  businessName: activeTenant?.name ?? '',
  codePrefix: 'HCH',
  dayCutoffHour: 5,
  timezone: 'America/Mexico_City',
  preorderCreditPayments: true,
  comboDrinksCategory: null,
}

let current: AppSettings = load()
const listeners = new Set<() => void>()
applyTitle()

function load(): AppSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<AppSettings> | null
    const merged = { ...DEFAULTS, ...saved }
    return Number.isInteger(merged.dayCutoffHour) && merged.timezone ? merged : { ...merged, dayCutoffHour: DEFAULTS.dayCutoffHour, timezone: DEFAULTS.timezone }
  } catch {
    return DEFAULTS
  }
}

function applyTitle() {
  if (typeof document === 'undefined') return
  document.title = appTitle(current)
  // Nombre bajo el ícono al "Agregar a Inicio" en iPhone: el del negocio (el título completo se corta).
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', current.businessName || 'Kanan POS')
}

export function appTitle(s: AppSettings = current) {
  return s.businessName ? `${s.businessName} · Kanan POS` : 'Kanan POS'
}

export const getSettings = () => current

export function useSettings(): AppSettings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getSettings,
  )
}

/** Lee la configuración de la base (después de iniciar sesión). */
export async function refreshSettings() {
  const { data, error } = await supabase
    .from('app_settings')
    .select('business_name, internal_code_prefix, day_cutoff_hour, timezone, preorder_credit_payments, combo_drinks_category')
    .maybeSingle()
  // Sin red, o la base aún no tiene la migración: se queda la copia local.
  if (error || !data) return
  const next: AppSettings = {
    businessName: data.business_name,
    codePrefix: data.internal_code_prefix,
    // Una base sin la migración de día operativo no trae estos campos.
    dayCutoffHour: data.day_cutoff_hour ?? DEFAULTS.dayCutoffHour,
    timezone: data.timezone ?? DEFAULTS.timezone,
    preorderCreditPayments: data.preorder_credit_payments ?? DEFAULTS.preorderCreditPayments,
    comboDrinksCategory: data.combo_drinks_category ?? null,
  }
  if (JSON.stringify(next) === JSON.stringify(current)) return
  current = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* no crítico */
  }
  applyTitle()
  listeners.forEach((l) => l())
}

/** El admin cambia el nombre del negocio (el prefijo no se cambia desde la app). */
export async function updateBusinessName(name: string) {
  const { error } = await supabase.from('app_settings').update({ business_name: name.trim() }).eq('id', true)
  if (error) throw new Error(error.code === '42501' ? 'Solo un administrador puede cambiar el nombre.' : error.message)
  await refreshSettings()
}

/** El admin cambia la hora de corte del día y si se aceptan créditos en abonos de preventa. */
export async function updateOperationSettings(patch: {
  dayCutoffHour?: number
  preorderCreditPayments?: boolean
  comboDrinksCategory?: string | null
}) {
  const row: Record<string, unknown> = {}
  if (patch.comboDrinksCategory !== undefined) row.combo_drinks_category = patch.comboDrinksCategory
  if (patch.dayCutoffHour !== undefined) row.day_cutoff_hour = patch.dayCutoffHour
  if (patch.preorderCreditPayments !== undefined) row.preorder_credit_payments = patch.preorderCreditPayments
  const { error } = await supabase.from('app_settings').update(row).eq('id', true)
  if (error) throw new Error(error.code === '42501' ? 'Solo un administrador puede cambiar la configuración.' : error.message)
  await refreshSettings()
}

// ---------- día de operación ----------
/** Minutos que la zona horaria va adelante de UTC en un instante. */
function tzOffsetMinutes(timezone: string, at: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return (Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - at.getTime()) / 60_000
}

/** Instante en que empieza el día de operación AAAA-MM-DD (p. ej. ese día a las 5:00 de la tienda). */
export function businessDayStart(date: string, s: AppSettings = current) {
  const [y, m, d] = date.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, s.dayCutoffHour)
  return new Date(guess - tzOffsetMinutes(s.timezone, new Date(guess)) * 60_000)
}

/** Instante en que termina el día de operación AAAA-MM-DD (el inicio del siguiente). */
export function businessDayEnd(date: string, s: AppSettings = current) {
  const [y, m, d] = date.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
  return businessDayStart(next, s)
}

/** Día de operación (AAAA-MM-DD) de un instante: a las 3:00 a.m. todavía es el día anterior. */
export function businessDate(at: Date | string = new Date(), s: AppSettings = current) {
  const shifted = new Date(new Date(at).getTime() - s.dayCutoffHour * 3_600_000)
  // en-CA da el formato AAAA-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: s.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted)
}

/** "Inventario Dragón Rojo" → "inventario-dragon-rojo" (para nombres de archivo). */
export function fileSlug(text: string) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Nombre de archivo de exportación: "tienda" → "tienda-dragon-rojo". */
export const exportName = (base: string) => fileSlug(`${base} ${current.businessName}`)
