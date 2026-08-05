export const CLINVAR_CATEGORIES = [
  { id: 'pathogenic', label: 'Pathogenic / likely pathogenic' },
  { id: 'uncertain', label: 'Uncertain significance' },
  { id: 'benign', label: 'Benign / likely benign' },
  { id: 'conflicting', label: 'Conflicting interpretations' },
  { id: 'association', label: 'Association / risk / drug response' },
  { id: 'other', label: 'Other / not provided' },
]

export function clinvarCategory(value) {
  const significance = String(value || '').toLowerCase().replace(/[_|]/g, ' ')
  if (/conflicting/.test(significance)) return 'conflicting'
  if (/pathogenic/.test(significance) && !/benign/.test(significance)) return 'pathogenic'
  if (/uncertain/.test(significance)) return 'uncertain'
  if (/benign/.test(significance) && !/pathogenic/.test(significance)) return 'benign'
  if (/drug response|risk factor|association|protective/.test(significance)) return 'association'
  return 'other'
}
export const DEFAULT_GNOMAD_MAF = 1e-5
