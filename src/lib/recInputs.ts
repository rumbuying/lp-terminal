// The recommender's last-used inputs (capital, risk profile), persisted per
// chain so the POOL RANK tab can label its recommendation badges with the same
// basis the user last saw on the recommender page instead of a surprise
// default. Pure parse/serialize here; storage wrappers stay thin.

import type { RecommendationRisk } from '../../shared/recommendation/types'

export type RecInputs = { capitalUsd: number; risk: RecommendationRisk }

export const REC_INPUTS_FALLBACK: RecInputs = { capitalUsd: 1000, risk: 'balanced' }

const storageKey = (chainKey: string) => `lp-terminal:rec:inputs:v1:${chainKey}`

const RISKS: RecommendationRisk[] = ['conservative', 'balanced', 'aggressive']

export function parseRecInputs(raw: string | null | undefined, fallback: RecInputs): RecInputs {
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw) as { capitalUsd?: unknown; risk?: unknown }
    const capitalUsd = Number(parsed.capitalUsd)
    const risk = RISKS.find((candidate) => candidate === parsed.risk)
    // the recommender page rejects capital under $10 — mirror that floor here
    if (Number.isFinite(capitalUsd) && capitalUsd >= 10 && risk) return { capitalUsd, risk }
  } catch { /* corrupted entry — fall back */ }
  return fallback
}

export function loadRecInputs(chainKey: string, fallback: RecInputs = REC_INPUTS_FALLBACK): RecInputs {
  try {
    return parseRecInputs(localStorage.getItem(storageKey(chainKey)), fallback)
  } catch {
    return fallback
  }
}

export function saveRecInputs(chainKey: string, inputs: RecInputs): void {
  try {
    localStorage.setItem(storageKey(chainKey), JSON.stringify(inputs))
  } catch { /* storage unavailable — the basis label just keeps its default */ }
}
