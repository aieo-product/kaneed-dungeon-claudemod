import { describe, expect, test } from 'bun:test'
import { fileUrl, findPaths, linkify, looksLikePath, pathOfFileUrl, resolvePath, splitLine } from '../hooks/links/linkify.ts'

const cwd = '/work/repo'
const home = '/Users/me'

describe('findPaths', () => {
  test('absolute, home, relative and line-tailed paths, each once', () => {
    const text = 'see /Volumes/SSD/a b, ~/notes/x.md and hooks/register.tsx:12 then ./tools/ again /Volumes/SSD/a'
    expect(findPaths(text)).toEqual(['/Volumes/SSD/a', '~/notes/x.md', 'hooks/register.tsx:12', './tools/'])
  })
  test('inside backticks and after Japanese text', () => {
    expect(findPaths('ファイルは `hooks/links/extract.ts` と/tmp/x。')).toEqual(['hooks/links/extract.ts', '/tmp/x'])
  })
  test('not inside a fence, a URL or a Markdown link target', () => {
    const text = '```\n/etc/hosts\n```\nhttps://example.com/a/b and [doc](https://x.dev/p/q)'
    expect(findPaths(text)).toEqual([])
  })
  test('words without a slash and dates are not paths', () => {
    expect(looksLikePath('README.md')).toBe(false)
    expect(looksLikePath('2026/10/08')).toBe(false)
    expect(looksLikePath('/')).toBe(false)
    expect(looksLikePath('docs/')).toBe(true)
  })
})

describe('resolvePath', () => {
  test('home, relative and dot segments', () => {
    expect(resolvePath('~/a/b', cwd, home)).toBe('/Users/me/a/b')
    expect(resolvePath('hooks/register.tsx:12:3', cwd, home)).toBe('/work/repo/hooks/register.tsx')
    expect(resolvePath('../other/./x', cwd, home)).toBe('/work/other/x')
    expect(resolvePath('~/a', cwd)).toBeUndefined()
  })
  test('splitLine', () => {
    expect(splitLine('a/b.ts:12:3')).toEqual({ path: 'a/b.ts', line: 12 })
    expect(splitLine('a/b.ts')).toEqual({ path: 'a/b.ts' })
  })
})

describe('file URLs', () => {
  test('round-trip with spaces and Japanese', () => {
    const abs = '/Volumes/AI Work/プロジェクト/a.md'
    const url = fileUrl(abs)
    expect(url).not.toContain(' ')
    expect(pathOfFileUrl(url)).toBe(abs)
    expect(pathOfFileUrl('https://example.com')).toBeUndefined()
  })
})

describe('linkify', () => {
  test('existing paths become file links, others stay text', () => {
    const paths = new Map([['hooks/register.tsx:12', '/work/repo/hooks/register.tsx'], ['/tmp/dir', '/tmp/dir']])
    const out = linkify('edit hooks/register.tsx:12 and /tmp/dir, not /nope/x', { paths })
    expect(out).toBe('edit [hooks/register.tsx:12](file:///work/repo/hooks/register.tsx) and [/tmp/dir](file:///tmp/dir), not /nope/x')
  })
  test('a path in backticks becomes a link labelled with it', () => {
    const paths = new Map([['docs/', '/work/repo/docs']])
    expect(linkify('open `docs/` now, keep `code`', { paths })).toBe('open [docs/](file:///work/repo/docs) now, keep `code`')
  })
  test('issue words link to GitHub', () => {
    const out = linkify('fixes #47 and o/r#3, not color#123456', { paths: new Map(), defaultRepo: { owner: 'aieo', repo: 'kd' } })
    expect(out).toBe('fixes [#47](https://github.com/aieo/kd/issues/47) and [o/r#3](https://github.com/o/r/issues/3), not color#123456')
  })
  test('fences, existing links and URLs are left as written', () => {
    const paths = new Map([['/tmp/dir', '/tmp/dir']])
    const text = '```sh\nls /tmp/dir #1\n```\n[x](https://e.com/#2) https://e.com/tmp/dir'
    expect(linkify(text, { paths, defaultRepo: { owner: 'o', repo: 'r' } })).toBe(text)
  })
})
