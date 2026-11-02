import { LANGUAGE_LABELS, LANGUAGES, type ProductLanguage } from '../lib/types'
import { Segmented } from './Segmented'

interface Props {
  value: ProductLanguage | null
  onChange: (value: ProductLanguage | null) => void
}

type Choice = ProductLanguage | 'none'

/** Idioma del producto: Inglés / Español / Japonés / Chino, o "No aplica". */
export function LanguageSelect({ value, onChange }: Props) {
  return (
    <Segmented<Choice>
      label="Idioma del producto"
      value={value ?? 'none'}
      onChange={(v) => onChange(v === 'none' ? null : v)}
      options={[...LANGUAGES.map((l) => ({ value: l as Choice, label: LANGUAGE_LABELS[l] })), { value: 'none', label: 'No aplica' }]}
    />
  )
}
