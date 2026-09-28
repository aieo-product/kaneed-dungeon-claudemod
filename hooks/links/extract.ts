// Finding links in conversation text, and keeping the list of them in order.
// Pure functions: no engine, no I/O, so `bun test` runs them as they are.

export type GithubRef = { owner: string; repo: string; number: number }

export type LinkKind = 'issue' | 'pr' | 'link'

export type Link = {
  /** The URL as shown and opened. */
  url: string
  /** The Markdown link label it came with, when it had one. */
  label?: string
  /** For a GitHub issue / PR URL: what to ask `gh api` about. */
  github?: GithubRef
  /** The one-line summary drawn beside the URL, once known. */
  summary?: string
  /** `issue` / `pr` once the summary says which; `link` until then and for everything else. */
  kind: LinkKind
  /** When it was last seen in the conversation, in ms since the epoch. */
  seenAt: number
}

/** One row as the board draws it: plain data, no key holding undefined. */
export type LinkRow = { url: string; text: string; kind: LinkKind }

export const MAX_LINKS = 200

// characters a sentence or a Markdown wrapper leaves stuck to the end of a URL
const TRAILING = new Set([')', '.', ',', '>', "'", '"', '」', '。', '、', ']', ';', ':', '!', '?', '）', '】', '*', '`'])

const URL_RE = /https?:\/\/[^\s<>"'`　]+/g
const MD_LINK_RE = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g

/** Strips the punctuation a sentence leaves on a URL's tail, keeping a `)` that closes one opened inside it. */
export function trimUrl(raw: string): string {
  let url = raw
  while (url.length > 0) {
    const last = url[url.length - 1]!
    if (!TRAILING.has(last)) break
    if (last === ')') {
      const opens = (url.match(/\(/g) ?? []).length
      const closes = (url.match(/\)/g) ?? []).length
      if (closes <= opens) break
    }
    url = url.slice(0, -1)
  }
  return url
}

/** Parses a GitHub issue or pull request URL; anything else (a repo, a file, a comment on a commit) is undefined. */
export function parseGithubRef(url: string): GithubRef | undefined {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)(?:[/?#]|$)/.exec(url)
  if (!m) return undefined
  const number = Number(m[3])
  if (!Number.isSafeInteger(number) || number <= 0) return undefined
  return { owner: m[1]!, repo: m[2]!, number }
}

/** The key two spellings of one link share: GitHub issue / PR URLs fold to `owner/repo#N`, others lose their fragment and trailing slash. */
export function normalizeUrl(url: string): string {
  const ref = parseGithubRef(url)
  if (ref) return `github:${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`
  let key = url.replace(/#.*$/, '')
  key = key.replace(/\/+$/, '')
  return key.toLowerCase()
}

const kindOf = (url: string): LinkKind => (/\/pull\/\d+/.test(url) ? 'pr' : parseGithubRef(url) ? 'issue' : 'link')

/** Every http(s) URL in `text`, first occurrence first, each once; a Markdown link's label rides along. */
export function extractLinks(text: string, seenAt: number): Link[] {
  const labels = new Map<string, string>()
  for (const m of text.matchAll(MD_LINK_RE)) {
    const url = trimUrl(m[2]!)
    const label = m[1]!.trim()
    if (label && !labels.has(normalizeUrl(url))) labels.set(normalizeUrl(url), label)
  }
  const out: Link[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0])
    if (!url || url.length > 2048) continue
    const key = normalizeUrl(url)
    if (seen.has(key)) continue
    seen.add(key)
    const github = parseGithubRef(url)
    const link: Link = { url, kind: kindOf(url), seenAt }
    const label = labels.get(key)
    if (label && label !== url) link.label = label
    if (github) link.github = github
    out.push(link)
  }
  return out
}

/** `owner/repo#N` references, and bare `#N` against `defaultRepo` (none: ignored), as links to github.com. */
export function parseHashRefs(text: string, seenAt: number, defaultRepo?: GithubRef | { owner: string; repo: string }): Link[] {
  const out: Link[] = []
  const seen = new Set<string>()
  const push = (owner: string, repo: string, number: number) => {
    if (!Number.isSafeInteger(number) || number <= 0) return
    const url = `https://github.com/${owner}/${repo}/issues/${number}`
    const key = normalizeUrl(url)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ url, kind: 'issue', github: { owner, repo, number }, seenAt })
  }
  for (const m of text.matchAll(/(?:^|[\s(（])([\w.-]+)\/([\w.-]+)#(\d+)(?=$|[^\w])/gm)) push(m[1]!, m[2]!, Number(m[3]))
  if (defaultRepo) {
    // `#12` only where a sentence would put a reference: after whitespace, a bracket or at the line's start,
    // never inside a word; at most five digits, so a six-digit color like `#123456` stays out
    for (const m of text.matchAll(/(?:^|[\s(（「[])#(\d{1,5})(?=$|[^\w#])/gm)) push(defaultRepo.owner, defaultRepo.repo, Number(m[1]))
  }
  return out
}

/**
 * `found` (one message's links, in reading order) merged over `existing`: the block goes on top in
 * that order, a link seen again moves up into it and keeps what it already knew. Merge messages
 * oldest first, so the newest message's links end up on top.
 */
export function mergeLinks(existing: readonly Link[], found: readonly Link[]): Link[] {
  if (found.length === 0) return [...existing]
  const byKey = new Map<string, Link>()
  for (const link of existing) byKey.set(normalizeUrl(link.url), link)
  const front: Link[] = []
  const moved = new Set<string>()
  for (const link of found) {
    const key = normalizeUrl(link.url)
    if (moved.has(key)) continue
    moved.add(key)
    const old = byKey.get(key)
    const merged: Link = old
      ? { ...old, seenAt: Math.max(old.seenAt, link.seenAt), label: old.label ?? link.label, github: old.github ?? link.github }
      : { ...link }
    if (merged.label === undefined) delete merged.label
    if (merged.github === undefined) delete merged.github
    front.push(merged)
  }
  const rest = existing.filter(link => !moved.has(normalizeUrl(link.url)))
  return [...front, ...rest].slice(0, MAX_LINKS)
}

/** Every link one transcript message mentions: its text and the text of the tool results and tool uses it holds. */
export function extractFromMessage(message: { text: string; toolUses?: readonly { text?: string }[]; toolResults?: readonly { text?: string }[] }, seenAt: number, defaultRepo?: { owner: string; repo: string }): Link[] {
  const parts = [message.text]
  for (const use of message.toolUses ?? []) if (typeof use.text === 'string') parts.push(use.text)
  for (const result of message.toolResults ?? []) if (typeof result.text === 'string') parts.push(result.text)
  const text = parts.join('\n')
  return [...extractLinks(text, seenAt), ...parseHashRefs(text, seenAt, defaultRepo)]
}
