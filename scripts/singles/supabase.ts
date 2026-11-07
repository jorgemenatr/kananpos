/*
 * Acceso a Supabase para el job de singles:
 *   - Management API (SUPABASE_ACCESS_TOKEN) para sacar la service_role de
 *     cada proyecto, igual que scripts/clientes.mjs.
 *   - REST (PostgREST) con la service_role para leer y escribir.
 * Nada de esto corre en el navegador.
 */
import { readFileSync } from 'node:fs'

const API = 'https://api.supabase.com/v1'

export class RestError extends Error {
  readonly status: number
  readonly code: string | null
  constructor(status: number, code: string | null, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class RestClient {
  readonly url: string
  /** service_role: solo en el servidor (job). */
  readonly key: string

  constructor(url: string, key: string) {
    this.url = url.replace(/\/+$/, '')
    this.key = key
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { apikey: this.key, 'Content-Type': 'application/json', ...extra }
    // Las llaves "legacy" (service_role) son JWT; las nuevas (sb_secret_…) van solo en apikey.
    if (this.key.startsWith('eyJ')) h.Authorization = `Bearer ${this.key}`
    return h
  }

  async request(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let res: Response
      try {
        res = await fetch(`${this.url}/rest/v1/${path}`, {
          method,
          headers: this.headers(extra),
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      } catch (e) {
        if (attempt >= 4) throw e
        await sleep(1000 * 2 ** attempt)
        continue
      }
      if (res.ok) return res
      const text = await res.text()
      if ((res.status >= 500 || res.status === 429) && attempt < 4) {
        await sleep(1000 * 2 ** attempt)
        continue
      }
      let code: string | null = null
      let msg = text
      try {
        const j = JSON.parse(text) as { code?: string; message?: string }
        code = j.code ?? null
        msg = j.message ?? text
      } catch {
        /* texto plano */
      }
      throw new RestError(res.status, code, `${method} ${path.split('?')[0]} → ${res.status}: ${msg}`)
    }
  }

  async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const res = await this.request('POST', `rpc/${fn}`, args)
    const text = await res.text()
    return (text ? JSON.parse(text) : null) as T
  }

  async select<T>(pathAndQuery: string): Promise<T[]> {
    const res = await this.request('GET', pathAndQuery)
    return (await res.json()) as T[]
  }

  async insert<T>(table: string, row: Record<string, unknown>): Promise<T> {
    const res = await this.request('POST', table, row, { Prefer: 'return=representation' })
    return ((await res.json()) as T[])[0]
  }

  async patch(table: string, filter: string, body: Record<string, unknown>): Promise<void> {
    await this.request('PATCH', `${table}?${filter}`, body, { Prefer: 'return=minimal' })
  }

  /** Upsert por lotes (idempotente: merge por la llave on_conflict). */
  async upsert(table: string, rows: Record<string, unknown>[], onConflict: string, batch = 1000): Promise<void> {
    for (let i = 0; i < rows.length; i += batch) {
      await this.request('POST', `${table}?on_conflict=${onConflict}`, rows.slice(i, i + batch), {
        Prefer: 'resolution=merge-duplicates,return=minimal',
      })
    }
  }

  async count(table: string, filter: string): Promise<number> {
    const res = await this.request('HEAD', `${table}?${filter}`, undefined, { Prefer: 'count=exact' })
    const range = res.headers.get('content-range') ?? ''
    const n = Number(range.split('/')[1])
    return Number.isFinite(n) ? n : 0
  }
}

// ---------- Management API ----------
function token(): string {
  const t = process.env.SUPABASE_ACCESS_TOKEN
  if (!t) {
    throw new Error(
      'Falta SUPABASE_ACCESS_TOKEN (token personal de Supabase). Ponlo en .env.clientes o en los secrets de GitHub.',
    )
  }
  return t
}

export async function managementApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`)
  return (text ? JSON.parse(text) : null) as T
}

/** Corre SQL como postgres (para las migraciones del proyecto central). */
export const runSql = (ref: string, query: string) =>
  managementApi<unknown[]>('POST', `/projects/${ref}/database/query`, { query })

export async function serviceKey(ref: string): Promise<string> {
  const keys = await managementApi<{ name: string; type?: string; api_key: string }[]>(
    'GET',
    `/projects/${ref}/api-keys?reveal=true`,
  )
  const key = keys.find((k) => k.name === 'service_role')?.api_key ?? keys.find((k) => k.type === 'secret')?.api_key
  if (!key) throw new Error(`No encontré la service_role del proyecto ${ref}`)
  return key
}

// ---------- proyectos ----------
/** Proyecto central del catálogo: CATALOGO_URL + CATALOGO_SERVICE_ROLE_KEY, o CATALOGO_REF + token. */
export async function centralClient(env = process.env): Promise<{ ref: string | null; rest: RestClient }> {
  if (env.CATALOGO_URL && env.CATALOGO_SERVICE_ROLE_KEY) {
    return { ref: env.CATALOGO_REF ?? null, rest: new RestClient(env.CATALOGO_URL, env.CATALOGO_SERVICE_ROLE_KEY) }
  }
  const ref = env.CATALOGO_REF
  if (!ref) {
    throw new Error(
      'Falta CATALOGO_REF (ID del proyecto kananpos-catalogo) o CATALOGO_URL + CATALOGO_SERVICE_ROLE_KEY.',
    )
  }
  return { ref, rest: new RestClient(`https://${ref}.supabase.co`, await serviceKey(ref)) }
}

export interface TenantRef {
  ref: string
  name: string
}

interface TenantsFile {
  clientes: Record<string, { nombre: string; supabase_url: string; estado: string }>
}

/** Tiendas activas de src/tenants.json (o las de CLIENTES / --ref). */
export function tenantRefs(only?: string, env = process.env): TenantRef[] {
  if (only) return [{ ref: only, name: only }]
  const fromEnv = (env.CLIENTES ?? '').split(/[\s,]+/).filter(Boolean)
  if (fromEnv.length) return [...new Set(fromEnv)].map((ref) => ({ ref, name: ref }))
  const file = new URL('../../src/tenants.json', import.meta.url)
  const data = JSON.parse(readFileSync(file, 'utf8')) as TenantsFile
  const out = new Map<string, TenantRef>()
  for (const [sub, c] of Object.entries(data.clientes)) {
    if (c.estado !== 'activo') continue
    const ref = new URL(c.supabase_url).hostname.split('.')[0]
    out.set(ref, { ref, name: sub })
  }
  return [...out.values()]
}

export async function tenantClient(t: TenantRef): Promise<RestClient> {
  return new RestClient(`https://${t.ref}.supabase.co`, await serviceKey(t.ref))
}
