// Turning the paths and link words of an assistant reply into Markdown links, so a click on one in
// the transcript opens it. Pure functions: which paths exist is asked by the caller (register.tsx),
// so `bun test` runs these as they are.

import { trimUrl } from './extract.ts'

/** A path found in the text: as written, and where it leads once `~` and the cwd are applied. */
export type PathHit = { written: string; abs: string }

// `/abs/path`, `~/path`, `./rel`, `../rel` or `dir/file.ext`, with an optional `:line[:col]` tail.
// A bare word without a slash is never a path. Names may be any script (`/tmp/日本語/a.md` is one
// path), but a relative path starts with an ASCII name, so `パスは/tmp/x` yields `/tmp/x`.
const PATH_RE = /(?<![\w:/.~-])(?:~\/|\.{1,2}\/|\/|(?=[\w.@+-]))(?:[\p{L}\p{N}\p{M}_.@+-]+\/)*[\p{L}\p{N}\p{M}_.@+-]+\/?(?::\d+(?::\d+)?)?/gu

/**
 * The spellings a matched word may mean: itself, and, when prose runs on after it with no space
 * (`/tmp/xと書いた`), the word up to where its last name stops being ASCII. Only the last name is
 * cut, so `/tmp/日本語/a.md` never falls back to `/tmp/`.
 */
export function spellingsOf(word: string): string[] {
  const m = /^(.*\/[\w.@+-]+)[^\p{ASCII}][^/]*$/u.exec(word)
  return m && looksLikePath(m[1]!) ? [word, m[1]!] : [word]
}

const LINE_TAIL = /:\d+(?::\d+)?$/

/** A matched word without the punctuation a sentence leaves on it, keeping a trailing `.` / `..` segment. */
export function trimPath(raw: string): string {
  const word = trimUrl(raw)
  if (!word.endsWith('/')) return word
  const dots = /^\.{1,2}(?!\.)/.exec(raw.slice(word.length))
  return dots ? word + dots[0] : word
}

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
  if (path.startsWith('/')) return path.length > 1 && /[\p{L}\p{N}]/u.test(path) && !path.startsWith('//')
  // relative: needs a slash between two names (`hooks/register.tsx`, `docs/`) and no scheme-like start
  return /^[\w.@+-][\p{L}\p{N}\p{M}_.@+-]*\/[\p{L}\p{N}\p{M}_.@+/-]*$/u.test(path) && !/^\d+\/\d+/.test(path)
}

/**
 * Where a written path leads: `~` against `home`, a relative one against `cwd`. `.` is dropped but
 * `..` is kept, for the file system to fold: past a symbolic link it is not the name before it.
 */
export function resolvePath(written: string, cwd: string, home?: string): string | undefined {
  const { path } = splitLine(written)
  let abs: string
  if (path.startsWith('~/')) {
    if (!home) return undefined
    abs = `${home}/${path.slice(2)}`
  } else if (path.startsWith('/')) abs = path
  else abs = `${cwd}/${path}`
  return `/${abs.split('/').filter(part => part !== '' && part !== '.').join('/')}`
}

/** A `file://` URL for an absolute path, every segment percent-encoded. */
export function fileUrl(abs: string): string {
  // `(` and `)` too: a Markdown link target ends at the first unbalanced `)`
  const encode = (seg: string) => encodeURIComponent(seg).replace(/[()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `file://${abs.split('/').map(encode).join('/')}`
}

// a directory macOS runs when it is opened, not shows
const BUNDLE = /\.(?:app|appex|bundle|framework|plugin|kext|prefpane|qlgenerator|saver|workflow|xpc|mdimporter|action)\/?$/i

// files whose default handler only shows them, so a link may name the file itself (a cmd-click goes
// to the OS past any check here). Text goes to an editor, at its line; the rest to its viewer (a page
// to the browser, for checking one). A script (`.py`, `.sh`, `.command`) or anything unlisted is never
// opened: its link leads to the directory holding it.
const TEXT_EXT = new Set(('md markdown mdx txt text rst adoc org log csv tsv json jsonc json5 jsonl ndjson yaml yml toml ini cfg conf xml ' +
  'ts tsx mts cts js jsx mjs cjs css scss sass less vue svelte astro c h cc cpp cxx hpp hh m mm swift kt kts java scala go rs zig ' +
  'cs fs dart sql graphql gql proto diff patch lock tf hcl gradle s asm inc cmake mk').split(' '))
const VIEW_EXT = new Set('png jpg jpeg gif webp bmp tif tiff heic ico pdf html htm'.split(' '))

/** How a file may be opened, by its extension: in an editor, in a viewer, or not at all. */
export function fileKind(path: string): 'text' | 'view' | undefined {
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase()
  if (!ext) return undefined
  return TEXT_EXT.has(ext) ? 'text' : VIEW_EXT.has(ext) ? 'view' : undefined
}

/**
 * Where a written path's link leads, judged where it lands: a plain directory itself; a file itself
 * when `openFiles` and its kind is listed, else the directory holding it. Never an app or other
 * bundle (one a file sits right in, too).
 */
export function linkTarget(realPath: string, kind: 'file' | 'dir' | 'other', openFiles = true): string | undefined {
  if (kind === 'dir') return BUNDLE.test(realPath) ? undefined : realPath
  if (kind !== 'file') return undefined
  if (openFiles && fileKind(realPath)) return realPath
  const parent = realPath.replace(/\/[^/]*$/, '') || '/'
  return BUNDLE.test(parent) ? undefined : parent
}

/** An editor's `scheme://file/path:line` URL. */
const editorUrl = (scheme: string, path: string, line?: number) =>
  `${scheme}://file${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}${line ? `:${line}` : ''}`

/**
 * What opening a pressed path runs, tried in order until one succeeds: a plain directory is shown; a
 * listed file (when `openFiles`) opened, text in an editor at `line`; anything else only revealed.
 */
export function openCommands(path: string, kind: 'file' | 'dir' | 'other', opts: { line?: number; openFiles?: boolean } = {}): { cmds: string[][]; revealed: boolean } {
  const { line, openFiles = true } = opts
  // a click never runs what it lands on: a script or an app bundle is revealed, not opened
  if (kind === 'dir' && !BUNDLE.test(path)) return { cmds: [['open', path], ['xdg-open', path]], revealed: false }
  const fk = kind === 'file' && openFiles ? fileKind(path) : undefined
  if (fk === 'text') {
    const at = line ? `${path}:${line}` : path
    return {
      cmds: [['code', '-g', at], ['cursor', '-g', at], ['open', editorUrl('vscode', path, line)], ['open', editorUrl('cursor', path, line)], ['open', '-t', path], ['xdg-open', path]],
      revealed: false,
    }
  }
  if (fk === 'view') return { cmds: [['open', path], ['xdg-open', path]], revealed: false }
  const parent = path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'
  return { cmds: [['open', '-R', path], ['xdg-open', parent]], revealed: true }
}

/** The line a `file://` URL's `#L12` (or `#12`) names. */
export function lineOfFileUrl(url: string): number | undefined {
  const m = /#L?(\d+)(?:[-:C].*)?$/.exec(url)
  return m ? Number(m[1]) : undefined
}

/** The absolute path a `file://` URL names; undefined for anything else. */
export function pathOfFileUrl(url: string): string | undefined {
  if (!url.startsWith('file://')) return undefined
  try {
    // the path alone: a `#L12` or `?x` is not part of the file's name (an encoded `%23` still is)
    const path = decodeURIComponent(url.slice('file://'.length).replace(/^localhost/, '').replace(/[?#].*$/, ''))
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
      for (const word of spellingsOf(trimPath(m[0]))) {
        if (!looksLikePath(word) || seen.has(word)) continue
        seen.add(word)
        out.push(word)
      }
    }
  }
  return out
}

type Chunk = { text: string; fenced: boolean }

/**
 * The text cut at fences (``` or ~~~, three or more): what is inside one is left as written. A fence
 * closes only on a line of the same character at least as long, so a ```` block may hold a ```.
 */
export function splitFences(text: string): Chunk[] {
  const out: Chunk[] = []
  let buf: string[] = []
  let open: { char: string; len: number; quotes: number } | undefined
  const flush = (fenced: boolean) => {
    if (buf.length) out.push({ text: buf.join('\n'), fenced })
    buf = []
  }
  for (const line of text.split('\n')) {
    // inside a quote (`> `) or a list item (`- `, `1. `, indented) too
    const m = /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d+[.)](?=[ \t])))*[ \t]*(`{3,}|~{3,})(.*)$/.exec(line)
    // a fence closes only in the container it opened in: as many `>` before it
    const quotes = m ? (line.slice(0, line.indexOf(m[1]!)).match(/>/g) ?? []).length : 0
    if (!open && m && !(m[1]![0] === '`' && m[2]!.includes('`'))) {
      flush(false)
      open = { char: m[1]![0]!, len: m[1]!.length, quotes }
      buf.push(line)
    } else if (open && m && m[1]![0] === open.char && m[1]!.length >= open.len && m[2]!.trim() === '' && quotes === open.quotes) {
      buf.push(line)
      flush(true)
      open = undefined
    } else buf.push(line)
  }
  flush(open !== undefined)
  // a chunk ends without its newline; put them back between chunks
  return out.map((c, i) => (i < out.length - 1 ? { ...c, text: `${c.text}\n` } : c))
}

/** Where a path's link leads: an absolute path, and the line to open a file at. */
export type LinkDest = string | { path: string; line?: number }

const hrefOf = (dest: LinkDest) =>
  typeof dest === 'string' ? fileUrl(dest) : `${fileUrl(dest.path)}${dest.line ? `#L${dest.line}` : ''}`

export type LinkifyOptions = {
  /** Path as written → where its link leads, for the paths that exist; others stay text. */
  paths: ReadonlyMap<string, LinkDest>
  /** The session's repo, for a bare `#12`. */
  defaultRepo?: { owner: string; repo: string }
}

const PROTECT = [
  // inline code, which may run over a line break but not a blank line
  /(`+)(?!`)((?:(?!\n[ \t]*\n)[\s\S])*?[^`])\1(?!`)/.source,
  // a line indented as code (four spaces or a tab, inside quotes too): left whole, a list item's
  // deeper lines with it, rather than risk rewriting an indented code block
  /^(?:[ \t]*>[ \t]?)*(?: {4}|\t)[^\n]*$/.source,
  // an inline link, its label holding one level of brackets (`[a [b]](url)`), with or without a title
  /\[(?:[^[\]\n]|\[[^[\]\n]*\])*\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/.source,
  // a reference link (`[text][ref]`, `[text][]`) and a reference definition line (`[ref]: url`, quoted too)
  /\[(?:[^[\]\n]|\[[^[\]\n]*\])*\]\[[^\]\n]*\]/.source,
  /^(?:[ \t]*>)*[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S[^\n]*$/.source,
  /<https?:[^>\s]+>/.source,
  /https?:\/\/[^\s<>"'`　]+/.source,
]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The protecting pattern, with a shortcut reference (`[label]`) for each label the text defines. */
function protectRe(text: string): RegExp {
  const labels = [...text.matchAll(/^(?:[ \t]*>)*[ \t]{0,3}\[([^\]\n]+)\]:/gm)].map(m => escapeRe(m[1]!))
  const shortcut = labels.length ? [`\\[(?:${labels.join('|')})\\](?![(\\[])`] : []
  return new RegExp([...PROTECT, ...shortcut].join('|'), 'gmi')
}

const escapeLabel = (s: string) => s.replace(/([[\]\\*_`~])/g, '\\$1')

/**
 * `text` with each known path and each `#12` / `owner/repo#12` written as a Markdown link, and bare
 * URLs left for the renderer. Fenced code is left alone; a path in backticks becomes a link labelled
 * with it (a link cannot live inside inline code). Returns the text unchanged when nothing applied.
 */
export function linkify(text: string, options: LinkifyOptions): string {
  const { paths, defaultRepo } = options
  return splitFences(text)
    // a reference definition anywhere in the reply protects its shortcut uses everywhere
    .map(chunk => (chunk.fenced ? chunk.text : linkifyPlain(chunk.text, text, paths, defaultRepo)))
    .join('')
}

function linkifyPlain(text: string, defs: string, paths: ReadonlyMap<string, LinkDest>, defaultRepo?: { owner: string; repo: string }): string {
  // protect, in one pass so nothing is held twice: inline code (made a link when it is just a known
  // path), a Markdown link with or without a title, an autolink, a bare URL
  const held: string[] = []
  const hold = (s: string) => `\uE000${held.push(s) - 1}\uE000`
  let out = text.replace(protectRe(defs), (m, _ticks: string | undefined, inner: string | undefined) => {
    if (inner === undefined) return hold(m)
    const dest = paths.get(inner.trim())
    return hold(dest ? `[${escapeLabel(inner.trim())}](${hrefOf(dest)})` : m)
  })
  // issue words first: `owner/repo#12` is an issue even where `owner/repo` is also a directory
  out = out.replace(/(^|[\s(（])([\w.-]+)\/([\w.-]+)#(\d+)(?=$|[^\w])/gm, (_m, pre: string, owner: string, repo: string, n: string) =>
    `${pre}${hold(`[${owner}/${repo}#${n}](https://github.com/${owner}/${repo}/issues/${n})`)}`)
  if (defaultRepo) {
    // after Japanese punctuation too (`ファイル、#47`)
    out = out.replace(/(^|[\s(（「[、。，：])#(\d{1,5})(?=$|[^\w#])/gm, (_m, pre: string, n: string) =>
      `${pre}${hold(`[#${n}](https://github.com/${defaultRepo.owner}/${defaultRepo.repo}/issues/${n})`)}`)
  }
  if (paths.size) {
    out = out.replace(PATH_RE, m => {
      for (const word of spellingsOf(trimPath(m))) {
        const dest = paths.get(word)
        if (dest) return hold(`[${escapeLabel(word)}](${hrefOf(dest)})`) + m.slice(word.length)
      }
      return m
    })
  }
  return out.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => held[Number(i)]!)
}
