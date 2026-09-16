// Is `latest` a newer release than `current`? Versions are `major.minor.patch`; anything that does
// not parse counts as no news, so a bad answer from the network never turns into a notice.

export const parseVersion = (v: unknown): number[] | null => {
  if (typeof v !== 'string') return null
  const parts = v.trim().split('.')
  if (parts.length !== 3) return null
  const nums = parts.map(p => (/^\d+$/.test(p) ? Number(p) : NaN))
  return nums.some(Number.isNaN) ? null : nums
}

export function isNewer(latest: unknown, current: unknown): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

// the manifest on the default branch: what a `claude plugin update` would install
export const MANIFEST_URL = 'https://raw.githubusercontent.com/aieo-product/kaneed-dungeon-claudemod/main/.claude-plugin/plugin.json'
// once a day is enough for a plugin that ships now and then
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000

export const versionIn = (json: string): string | null => {
  try {
    const v = (JSON.parse(json) as { version?: unknown }).version
    return parseVersion(v) ? (v as string) : null
  } catch {
    return null
  }
}
