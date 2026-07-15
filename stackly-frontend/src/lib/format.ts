const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

/** Formats an integer amount of cents as USD, e.g. 2450 -> "$24.50". */
export function formatUSD(cents: number): string {
  return usd.format(cents / 100)
}
