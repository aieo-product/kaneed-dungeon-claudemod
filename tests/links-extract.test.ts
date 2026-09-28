import { describe, expect, test } from 'bun:test'
import { extractFromMessage, extractLinks, MAX_LINKS, mergeLinks, normalizeUrl, parseGithubRef, parseHashRefs, trimUrl, type Link } from '../hooks/links/extract.ts'

const at = 1000

describe('extractLinks', () => {
  test('finds every http(s) URL once, in order', () => {
    const links = extractLinks('see https://example.com/a and http://example.org/b then https://example.com/a again', at)
    expect(links.map(l => l.url)).toEqual(['https://example.com/a', 'http://example.org/b'])
    expect(links[0]).toMatchObject({ kind: 'link', seenAt: at })
  })
  test('drops the punctuation a sentence leaves on the tail', () => {
    expect(extractLinks('PR: https://github.com/o/r/pull/12.', at)[0]?.url).toBe('https://github.com/o/r/pull/12')
    expect(extractLinks('(see https://example.com/x), ok', at)[0]?.url).toBe('https://example.com/x')
    expect(extractLinks('リンク https://example.com/y。', at)[0]?.url).toBe('https://example.com/y')
    expect(extractLinks('「https://example.com/z」', at)[0]?.url).toBe('https://example.com/z')
    expect(extractLinks('<https://example.com/angle>', at)[0]?.url).toBe('https://example.com/angle')
  })
  test('keeps a closing paren that belongs to the URL', () => {
    expect(trimUrl('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
    expect(trimUrl('https://en.wikipedia.org/wiki/Foo_(bar))')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
  })
  test('a Markdown link carries its label', () => {
    const [link] = extractLinks('read [the design doc](https://example.com/design) first', at)
    expect(link).toMatchObject({ url: 'https://example.com/design', label: 'the design doc' })
  })
  test('a GitHub issue or PR URL is parsed and typed', () => {
    const links = extractLinks('https://github.com/aieo-product/linktray-claudemod/issues/1 and https://github.com/o/r/pull/7#issuecomment-99', at)
    expect(links[0]).toMatchObject({ kind: 'issue', github: { owner: 'aieo-product', repo: 'linktray-claudemod', number: 1 } })
    expect(links[1]).toMatchObject({ kind: 'pr', github: { owner: 'o', repo: 'r', number: 7 } })
  })
  test('no URL, no links', () => {
    expect(extractLinks('nothing here, not even ftp://x', at)).toEqual([])
  })
})

describe('parseGithubRef', () => {
  test('issues and pulls, with or without a tail', () => {
    expect(parseGithubRef('https://github.com/o/r/issues/12')).toEqual({ owner: 'o', repo: 'r', number: 12 })
    expect(parseGithubRef('https://github.com/o/r/pull/3/files')).toEqual({ owner: 'o', repo: 'r', number: 3 })
    expect(parseGithubRef('https://www.github.com/o/r.js/issues/4?x=1')).toEqual({ owner: 'o', repo: 'r.js', number: 4 })
  })
  test('a repo, a file or a commit is not one', () => {
    expect(parseGithubRef('https://github.com/o/r')).toBeUndefined()
    expect(parseGithubRef('https://github.com/o/r/blob/main/README.md')).toBeUndefined()
    expect(parseGithubRef('https://github.com/o/r/issues')).toBeUndefined()
    expect(parseGithubRef('https://gitlab.com/o/r/-/issues/1')).toBeUndefined()
  })
})

describe('normalizeUrl', () => {
  test('a GitHub issue folds to owner/repo#N whatever its spelling', () => {
    const a = normalizeUrl('https://github.com/O/R/issues/5')
    expect(normalizeUrl('https://github.com/o/r/issues/5#issuecomment-1')).toBe(a)
    expect(normalizeUrl('https://github.com/o/r/pull/5')).toBe(a)
  })
  test('another URL loses its fragment and trailing slash', () => {
    expect(normalizeUrl('https://Example.com/Docs/#top')).toBe(normalizeUrl('https://example.com/docs'))
  })
})

describe('parseHashRefs', () => {
  test('owner/repo#N anywhere, bare #N only against a default repo', () => {
    const text = 'fix o/r#12 and (#3) then #4; color #123456 and word#5 stay out'
    expect(parseHashRefs(text, at).map(l => l.url)).toEqual(['https://github.com/o/r/issues/12'])
    expect(parseHashRefs(text, at, { owner: 'me', repo: 'proj' }).map(l => l.url)).toEqual([
      'https://github.com/o/r/issues/12',
      'https://github.com/me/proj/issues/3',
      'https://github.com/me/proj/issues/4',
    ])
  })
  test('a reference at the start of a line counts', () => {
    expect(parseHashRefs('#7 is the one', at, { owner: 'a', repo: 'b' }).map(l => l.github?.number)).toEqual([7])
  })
})

describe('mergeLinks', () => {
  const link = (url: string, seenAt = at, extra: Partial<Link> = {}): Link => ({ url, kind: 'link', seenAt, ...extra })
  test('a message\'s links go on top in reading order', () => {
    const merged = mergeLinks([link('https://a')], [link('https://b', 2), link('https://c', 3)])
    expect(merged.map(l => l.url)).toEqual(['https://b', 'https://c', 'https://a'])
  })
  test('merging messages oldest first leaves the newest message on top', () => {
    const older = [link('https://a', 1), link('https://b', 1)]
    const newer = [link('https://c', 2), link('https://a', 2)]
    expect(mergeLinks(mergeLinks([], older), newer).map(l => l.url)).toEqual(['https://c', 'https://a', 'https://b'])
  })
  test('a link repeated inside one message is one row', () => {
    expect(mergeLinks([], [link('https://a', 1), link('https://a', 1)])).toHaveLength(1)
  })
  test('a link seen again moves to the top and keeps its summary', () => {
    const existing = [link('https://a', 1, { summary: 'A' }), link('https://b', 2)]
    const merged = mergeLinks(existing, [link('https://a', 9)])
    expect(merged.map(l => l.url)).toEqual(['https://a', 'https://b'])
    expect(merged[0]).toMatchObject({ summary: 'A', seenAt: 9 })
    expect(merged).toHaveLength(2)
  })
  test('two spellings of one GitHub issue are one row', () => {
    const merged = mergeLinks([link('https://github.com/o/r/issues/1', 1)], [link('https://github.com/o/r/issues/1#issuecomment-5', 2)])
    expect(merged).toHaveLength(1)
  })
  test('the list is capped', () => {
    const many = Array.from({ length: MAX_LINKS + 10 }, (_, i) => link(`https://x/${i}`, i))
    expect(mergeLinks([], many)).toHaveLength(MAX_LINKS)
  })
})

describe('extractFromMessage', () => {
  test('reads the text, the tool results and the tool uses', () => {
    const links = extractFromMessage(
      { text: 'made https://github.com/o/r/pull/1', toolUses: [{ text: 'https://example.com/from-tool' }], toolResults: [{ text: 'https://example.com/from-result' }] },
      at,
      { owner: 'o', repo: 'r' },
    )
    expect(links.map(l => l.url)).toEqual(['https://github.com/o/r/pull/1', 'https://example.com/from-tool', 'https://example.com/from-result'])
  })
})
