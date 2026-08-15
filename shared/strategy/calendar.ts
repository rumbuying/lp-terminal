export const SHANGHAI_OFFSET_SECONDS = 8 * 60 * 60
export const DAY_SECONDS = 24 * 60 * 60

/** Integer day identity in Asia/Shanghai, stable across server locales. */
export const shanghaiDay = (unixSeconds: number) => Math.floor((unixSeconds + SHANGHAI_OFFSET_SECONDS) / DAY_SECONDS)

export function shanghaiDate(day: number): string {
  // `day` already represents the shifted civil-date number. Rendering that
  // integer as a UTC date yields the matching YYYY-MM-DD label; subtracting
  // the offset again would move the label to the previous UTC date.
  return new Date(day * DAY_SECONDS * 1000).toISOString().slice(0, 10)
}

export const rawDelta = (opening: string | null, closing: string | null): string | null =>
  opening === null || closing === null ? null : (BigInt(closing) - BigInt(opening)).toString()
