import { parseUnits } from 'viem'

/** Reject limits that the quote token cannot represent before a live job starts. */
export function validateFablesDailyTurnover(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw new Error('E_FABLES_QUOTE_DECIMALS')
  const amount = parseUnits(value, decimals)
  if (amount <= 0n) throw new Error('E_FABLES_DAILY_LIMIT')
  return amount
}
