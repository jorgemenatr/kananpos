import { useState, type FormEvent } from 'react'
import { internalCodeLabel, isInternalCode, normalizeBarcode } from '../lib/barcode'
import { sounds } from '../lib/sounds'
import { useSettings } from '../lib/settings'
import type { CreateOutcome } from '../store/inventoryStore'
import { useInventory } from '../store/useInventory'
import { Icon } from './Icon'
import { ProductFormModal } from './ProductFormModal'

/**
 * Alta de producto desde Inventario: primero el código (escanearlo o
 * escribirlo; o sin código → código interno) y luego el formulario.
 * La cantidad inicial solo se pide mientras el inventario inicial esté
 * abierto; si no, las piezas entran por Compras o por Conteo y ajustes.
 */
export function NewProductDialog({
  onCancel,
  onSaved,
}: {
  onCancel: () => void
  onSaved: (outcome: Extract<CreateOutcome, { type: 'ok' }>) => void
}) {
  const { products, online } = useInventory()
  const settings = useSettings()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<{ barcode: string | null } | null>(null)

  function submit(e: FormEvent) {
    e.preventDefault()
    const barcode = normalizeBarcode(code)
    if (!barcode) return setError('Escanea o escribe el código, o usa "Sin código".')
    const existing = products[barcode]
    if (existing) {
      sounds.error()
      return setError(`Ese código ya es de "${existing.name}".`)
    }
    if (isInternalCode(barcode)) {
      sounds.error()
      return setError(`Los códigos ${internalCodeLabel()} se generan solos: usa "Sin código".`)
    }
    setForm({ barcode })
  }

  if (form) {
    return (
      <ProductFormModal
        barcode={form.barcode}
        defaultQuantity={0}
        hint={
          settings.initialLoadOpen
            ? undefined
            : 'Se da de alta sin piezas: la mercancía entra por Compras y las correcciones por Conteo y ajustes.'
        }
        onCancel={onCancel}
        onSaved={(out) => onSaved(out)}
      />
    )
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4" role="dialog" aria-modal="true" aria-labelledby="np-title">
      <form
        onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        className="w-full max-w-lg dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <h2 id="np-title" className="text-title">Nuevo producto</h2>
          <button type="button" onClick={onCancel} className="btn btn-ghost">
            <Icon name="x" />
            Cancelar
          </button>
        </div>
        <div className="space-y-3 px-6 py-5">
          <label htmlFor="np-code" className="field-label">
            Escanea o escribe el código de barras y presiona Enter
          </label>
          <input
            id="np-code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value)
              setError(null)
            }}
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="Código de barras…"
            className="field h-12 font-mono text-heading"
          />
          {error && (
            <p className="notice bg-danger-bg text-danger-fg">
              <Icon name="alert" className="mt-0.5" />
              {error}
            </p>
          )}
          <p className="text-caption text-ink-muted">
            ¿Llegó de un proveedor? Mejor dalo de alta desde Compras: ahí mismo se registran las piezas y su costo.
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-3 border-t border-line bg-subtle px-6 py-4">
          <button
            type="button"
            onClick={() => setForm({ barcode: null })}
            disabled={!online}
            title={online ? undefined : 'Se necesita conexión para generar un código interno'}
            className="btn btn-secondary"
          >
            Sin código ({internalCodeLabel()})
          </button>
          <button type="submit" className="btn btn-primary">
            Continuar
          </button>
        </div>
      </form>
    </div>
  )
}
