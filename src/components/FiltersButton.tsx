import { Icon } from './Icon'

/**
 * En el celular los filtros van plegados: este botón (solo el ícono) los muestra u oculta.
 * El panel de filtros usa `open ? '' : 'max-md:hidden'`. En md+ no se ve.
 */
export function FiltersButton({
  open,
  active,
  onToggle,
  className,
}: {
  open: boolean
  active: boolean
  onToggle: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={active ? 'Filtros (hay filtros activos)' : 'Filtros'}
      title="Filtros"
      className={`btn btn-secondary btn-icon relative self-start md:hidden ${className ?? ''}`}
    >
      <Icon name="filter" />
      {active && <span className="absolute top-1 right-1 size-2 bg-brand" aria-hidden />}
    </button>
  )
}
