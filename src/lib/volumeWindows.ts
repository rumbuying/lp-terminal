export type VolumeWindows = {
  vol5mUsd: number | null
  vol1hUsd: number | null
  vol6hUsd: number | null
  vol24hUsd: number | null
}

type ExternalVolumes = { m5?: unknown; h1?: unknown; h6?: unknown; h24?: unknown }

const finiteOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** DexScreener and GeckoTerminal use the same interval keys. Missing windows
 * stay null — zero is reserved for an explicitly reported zero-volume window. */
export function volumeWindowsOf(volume?: ExternalVolumes): VolumeWindows {
  return {
    vol5mUsd: finiteOrNull(volume?.m5),
    vol1hUsd: finiteOrNull(volume?.h1),
    vol6hUsd: finiteOrNull(volume?.h6),
    vol24hUsd: finiteOrNull(volume?.h24),
  }
}
