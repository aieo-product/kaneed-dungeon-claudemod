// Turning the paths and link words of an assistant reply into Markdown links, so a click on one in
// the transcript opens it. Pure functions: which paths exist is asked by the caller (register.tsx),
// so `bun test` runs these as they are.

import { trimUrl } from './extract.ts'

/** A path found in the text: as written, and where it leads once `~` and the cwd are applied. */
export type PathHit = { written: string; abs: string }

// `/abs/path`, `~/path`, `./rel`, `../rel` or `dir/file.ext`, with an optional `:line[:col]` tail.
// A bare word without a slash is never a path; a relative one needs a `./` or an extension at its end.
const PATH_RE = /(?<![\w:/.~-])(?:~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+\/)*[\w.@+-]+\/?(?::\d+(?::\d+)?)?/g

const LINE_TAIL = /:\d+(?::\d+)?$/

/** Splits `path:12:3` into the path and its line, if any. */
export function splitLine(written: string): { path: string; line?: number } {
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(written)
  return m ? { path: m[1]!, line: Number(m[2]) } : { path: written }
}

/** Whether a word reads as a path at all: anchored (`/`, `~/`, `./`), or relative with a slash and an extension or trailing name. */
export function looksLikePath(word: string): boolean {
  const path = word.replace(LINE_TAIL, '')
  if (path.length < 2 || path.length > 1024) return false
  if (/^(?:~\/|\.{1,2}\/)/.test(path)) return true
  if (path.startsWith('/')) return path.length > 1 && /[\w]/.test(path) && !path.startsWith('//')
  // relative: needs a slash between two names (`hooks/register.tsx`, `docs/`) and no scheme-like start
  return /^[\w.@+-]+\/[\w.@+/-]*$/.test(path) && !/^\d+\/\d+/.test(path)
}

/** Where a written path leads: `~` against `home`, a relative one against `cwd`, `.` and `..` folded. */
export function resolvePath(written: string, cwd: string, home?: string): string | undefined {
  const { path } = splitLine(written)
  let abs: string
  if (path.startsWith('~/')) {
    if (!home) return undefined
    abs = `${home}/${path.slice(2)}`
  } else if (path.startsWith('/')) abs = path
  else abs = `${cwd}/${path}`
  const parts: string[] = []
  for (const part of abs.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** A `file://` URL for an absolute path, every segment percent-encoded. */
export function fileUrl(abs: string): string {
  return `file://${abs.split('/').map(encodeURIComponent).join('/')}`
}

/** The absolute path a `file://` URL names; undefined for anything else. */
export function pathOfFileUrl(url: string): string | undefined {
  if (!url.startsWith('file://')) return undefined
  try {
    const path = decodeURIComponent(url.slice('file://'.length).replace(/^localhost/, ''))
    return path.startsWith('/') ? path : undefined
  } catch {
    return undefined
  }
}

/** Every path-looking word in `text`, outside fences, each once, in order. */
export function findPaths(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const chunk of splitFences(text)) {
    if (chunk.fenced) continue
    // a Markdown link's target is already a link; leave it out of the search
    const plain = chunk.text.replace(/\]\([^)\s]*\)/g, '] ').replace(/https?:\/\/[^\s<>"'`　]+/g, ' ')
    for (const m of plain.matchAll(PATH_RE)) {
      const word = trimUrl(m[0])
      if (!looksLikePath(word) || seen.has(word)) continue
      seen.add(word)
      out.push(word)
    }
  }
  return out
}

type Chunk = { text: string; fenced: boolean }

/** The text cut at ``` fences: what is inside one is left as written. */
export function splitFences(text: string): Chunk[] {
  const out: Chunk[] = []
  const lines = text.split('\n')
  let buf: string[] = []
  let fenced = false
  const flush = () => {
    if (buf.length) out.push({ text: buf.join('\n'), fenced })
    buf = []
  }
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (!fenced) {
        flush()
        fenced = true
        buf.push(line)
      } else {
        buf.push(line)
        flush()
        fenced = false
      }
      continue
    }
    buf.push(line)
  }
  flush()
  // a chunk ends without its newline; put them back between chunks
  return out.map((c, i) => (i < out.length - 1 ? { ...c, text: `${c.text}\n` } : c))
}

export type LinkifyOptions = {
  /** Path as written → absolute path, for the paths that exist; others stay text. */
  paths: ReadonlyMap<string, string>
  /** The session's repo, for a bare `#12`. */
  defaultRepo?: { owner: string; repo: string }
}

const escapeLabel = (s: string) => s.replace(/([[\]\\])/g, '\\$1')

/**
 * `text` with each known path and each `#12` / `owner/repo#12` written as a Markdown link, and bare
 * URLs left for the renderer. Fenced code is left alone; a path in backticks becomes a link labelled
 * with it (a link cannot live inside inline code). Returns the text unchanged when nothing applied.
 */
export function linkify(text: string, options: LinkifyOptions): string {
  const { paths, defaultRepo } = options
  return splitFences(text)
    .map(chunk => (chunk.fenced ? chunk.text : linkifyPlain(chunk.text, paths, defaultRepo)))
    .join('')
}

function linkifyPlain(text: string, paths: ReadonlyMap<string, string>, defaultRepo?: { owner: string; repo: string }): string {
  // protect what is already a link, a bare URL, or inline code that holds no path
  const held: string[] = []
  const hold = (s: string) => `\uE000${held.push(s) - 1}\uE000`
  let out = text.replace(/\[[^\]\n]*\]\([^)\s]*\)|<https?:[^>\s]+>|https?:\/\/[^\s<>"'`　]+/g, m => hold(m))
  out = out.replace(/`([^`\n]+)`/g, (m, inner: string) => {
    const abs = paths.get(inner.trim())
    return hold(abs ? `[${escapeLabel(inner)}](${fileUrl(abs)})` : m)
  })
  if (paths.size) {
    out = out.replace(PATH_RE, m => {
      const word = trimUrl(m)
      const abs = paths.get(word)
      if (!abs) return m
      return hold(`[${escapeLabel(word)}](${fileUrl(abs)})`) + m.slice(word.length)
    })
  }
  out = out.replace(/(^|[\s(（])([\w.-]+)\/([\w.-]+)#(\d+)(?=$|[^\w])/gm, (_m, pre: string, owner: string, repo: string, n: string) =>
    `${pre}${hold(`[${owner}/${repo}#${n}](https://github.com/${owner}/${repo}/issues/${n})`)}`)
  if (defaultRepo) {
    out = out.replace(/(^|[\s(（「[])#(\d{1,5})(?=$|[^\w#])/gm, (_m, pre: string, n: string) =>
      `${pre}${hold(`[#${n}](https://github.com/${defaultRepo.owner}/${defaultRepo.repo}/issues/${n})`)}`)
  }
  return out.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => held[Number(i)]!)
}
