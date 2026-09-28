// The one-line summary drawn beside each link, from what `gh api` or a page answered.
// Pure functions, so `bun test` runs them as they are.

import type { LinkKind } from './extract.ts'

export type GithubSummary = { kind: Exclude<LinkKind, 'link'>; text: string; state: 'open' | 'closed' | 'merged' }

const MAX_TITLE = 120

/** The summary of one `repos/{owner}/{repo}/issues/{n}` answer: `#N title [open|closed|merged]`; undefined when the JSON is not one. */
export function githubSummary(json: unknown): GithubSummary | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const o = json as Record<string, unknown>
  const number = typeof o.number === 'number' ? o.number : Number(o.number)
  if (!Number.isSafeInteger(number) || number <= 0) return undefined
  const title = typeof o.title === 'string' ? collapse(o.title) : ''
  const pr = typeof o.pull_request === 'object' && o.pull_request !== null ? (o.pull_request as Record<string, unknown>) : undefined
  const kind: GithubSummary['kind'] = pr ? 'pr' : 'issue'
  const merged = pr ? (typeof pr.merged_at === 'string' && pr.merged_at !== '') || o.merged === true : o.merged === true
  const state: GithubSummary['state'] = merged ? 'merged' : o.state === 'closed' ? 'closed' : 'open'
  return { kind, state, text: `#${number} ${cut(title || '(no title)', MAX_TITLE)} [${state}]` }
}

/** The `<title>` of an HTML page, entities decoded and whitespace collapsed, or undefined when it has none. */
export function htmlTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)
  if (!m) return undefined
  const title = collapse(decodeEntities(m[1]!))
  return title ? cut(title, MAX_TITLE) : undefined
}

/** A summary from the URL alone: its host and the start of its path. */
export function hostSummary(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : cut(decodeURIComponent(u.pathname), 40)
    return `${u.hostname}${path}`
  } catch {
    return cut(url, 60)
  }
}

/** Whether a page is worth asking for its title: http(s) on a public host, never a loopback, private or `.local` one. */
export function isFetchable(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '0.0.0.0') return false
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 127 || a === 10 || a === 0) return false
    if (a === 192 && b === 168) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 169 && b === 254) return false
  }
  return true
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function cut(s: string, max: number): string {
  const chars = [...s]
  return chars.length <= max ? s : chars.slice(0, max - 1).join('') + '…'
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, body: string) => {
    const key = body.toLowerCase()
    if (key.startsWith('#x')) {
      const cp = parseInt(key.slice(2), 16)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole
    }
    if (key.startsWith('#')) {
      const cp = parseInt(key.slice(1), 10)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole
    }
    return ENTITIES[key] ?? whole
  })
}
