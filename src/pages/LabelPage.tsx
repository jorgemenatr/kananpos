import { useEffect, useRef } from 'react'
import { LANGUAGE_LABELS, isProductLanguage } from '../lib/types'
import { useParams, useSearchParams } from 'react-router-dom'
import JsBarcode from 'jsbarcode'
import { Icon } from '../components/Icon'
import { KananMark } from '../components/KananMark'
import { formatMoney } from '../lib/format'
import { useInventory } from '../store/useInventory'

/** Etiqueta imprimible (Code128) para productos con código interno. */
export function LabelPage() {
  const { code = '' } = useParams()
  const [params] = useSearchParams()
  const svgRef = useRef<SVGSVGElement>(null)
  const product = useInventory().products[code]

  useEffect(() => {
    if (!svgRef.current || !code) return
    JsBarcode(svgRef.current, code, {
      format: 'CODE128',
      width: 2,
      height: 60,
      fontSize: 18,
      margin: 0,
      displayValue: true,
    })
    if (params.get('print') === '1') {
      const t = setTimeout(() => window.print(), 300)
      return () => clearTimeout(t)
    }
  }, [code, params])

  return (
    <div className="min-h-full bg-app p-6 print:bg-white">
      <style>{`
        @page { size: 50mm 30mm; margin: 0; }
        @media print {
          html, body, #root { background: #fff; height: auto; }
          .label { width: 50mm; height: 30mm; padding: 1.5mm 2mm; border: none !important; margin: 0 !important; }
        }
      `}</style>
      <div className="mb-6 flex flex-wrap items-center gap-3 print:hidden">
        <KananMark size={36} className="shrink-0" />
        <h1 className="mr-auto text-title uppercase md:text-title-lg">Etiqueta</h1>
        <button type="button" onClick={() => window.close()} className="btn btn-secondary">
          Cerrar
        </button>
        <button type="button" onClick={() => window.print()} className="btn btn-primary">
          <Icon name="printer" />
          Imprimir
        </button>
        <p className="w-full text-caption text-ink-muted">
          Tamaño de etiqueta: 50 × 30 mm. Ajusta la escala en el diálogo de impresión si hace falta.
        </p>
      </div>
      <div className="label mx-auto flex w-[50mm] flex-col items-center justify-center overflow-hidden border border-dashed border-control bg-white font-sans text-black" style={{ height: '30mm' }}>
        {product && <p className="w-full truncate text-center text-[9pt] font-bold leading-tight">{product.name}</p>}
        <svg ref={svgRef} className="h-auto max-w-full" />
        {product && (
          <p className="flex items-center gap-1.5 text-[9pt] font-bold leading-tight">
            {/* Impresora térmica: recuadro en negro, no color. */}
            {isProductLanguage(product.language) && (
              <span className="border border-black px-1 text-[7pt] uppercase">{LANGUAGE_LABELS[product.language]}</span>
            )}
            {formatMoney(product.price)}
          </p>
        )}
      </div>
    </div>
  )
}
