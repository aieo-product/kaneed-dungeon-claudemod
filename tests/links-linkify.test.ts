import { describe, expect, test } from 'bun:test'
import { fileKind, fileUrl, findPaths, lineOfFileUrl, linkify, linkTarget, looksLikePath, openCommands, pathOfFileUrl, resolvePath, spellingsOf, splitLine, trimPath } from '../hooks/links/linkify.ts'
import type { LinkDest } from '../hooks/links/linkify.ts'

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
    // `..` is left for the file system: past a symbolic link it is not the name before it
    expect(resolvePath('../other/./x', cwd, home)).toBe('/work/repo/../other/x')
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

describe('openCommands', () => {
  test('a plain directory is opened', () => {
    expect(openCommands('/work/repo/docs', 'dir')).toEqual({ cmds: [['open', '/work/repo/docs'], ['xdg-open', '/work/repo/docs']], revealed: false })
  })
  test('a script, an unlisted file, an app bundle or an unknown is only revealed, never run', () => {
    expect(openCommands('/tmp/evil.command', 'file')).toEqual({ cmds: [['open', '-R', '/tmp/evil.command'], ['xdg-open', '/tmp']], revealed: true })
    expect(openCommands('/tmp/run.py', 'file', { line: 3 }).revealed).toBe(true)
    expect(openCommands('/Applications/Evil.app', 'dir').cmds[0]).toEqual(['open', '-R', '/Applications/Evil.app'])
    expect(openCommands('/x/Thing.WORKFLOW/', 'dir').revealed).toBe(true)
    expect(openCommands('/x/y', 'other').revealed).toBe(true)
    expect(openCommands('/top', 'file').cmds[1]).toEqual(['xdg-open', '/'])
  })
  test('text opens in an editor at its line', () => {
    const { cmds, revealed } = openCommands('/w/a b.ts', 'file', { line: 12 })
    expect(revealed).toBe(false)
    expect(cmds).toEqual([
      ['code', '-g', '/w/a b.ts:12'],
      ['cursor', '-g', '/w/a b.ts:12'],
      ['open', 'vscode://file/w/a%20b.ts:12'],
      ['open', 'cursor://file/w/a%20b.ts:12'],
      ['open', '-t', '/w/a b.ts'],
      ['xdg-open', '/w/a b.ts'],
    ])
    expect(openCommands('/w/x#1.md', 'file').cmds[2]).toEqual(['open', 'vscode://file/w/x%231.md'])
  })
  test('an image, a PDF or a page opens in its viewer', () => {
    expect(openCommands('/w/r.html', 'file').cmds[0]).toEqual(['open', '/w/r.html'])
    expect(openCommands('/w/shot.PNG', 'file')).toEqual({ cmds: [['open', '/w/shot.PNG'], ['xdg-open', '/w/shot.PNG']], revealed: false })
  })
  test('openFiles off: every file is only revealed', () => {
    expect(openCommands('/w/a.md', 'file', { openFiles: false }).revealed).toBe(true)
    expect(openCommands('/w/docs', 'dir', { openFiles: false }).revealed).toBe(false)
  })
})

describe('file links', () => {
  test('fileKind by extension', () => {
    expect(fileKind('/a/README.md')).toBe('text')
    expect(fileKind('/a/x.TSX')).toBe('text')
    expect(fileKind('/a/doc.pdf')).toBe('view')
    expect(fileKind('/a/report.HTML')).toBe('view')
    for (const p of ['/a/run.py', '/a/x.sh', '/a/x.command', '/a/i.svg', '/a/Makefile', '/a/.env', '/a.d/noext']) expect(fileKind(p)).toBeUndefined()
  })
  test('a listed file links to itself, at its line', () => {
    expect(linkTarget('/w/package.json', 'file')).toBe('/w/package.json')
    const out = linkify('see hooks/a.ts:12 and /w/b.md', { paths: new Map<string, LinkDest>([['hooks/a.ts:12', { path: '/w/hooks/a.ts', line: 12 }], ['/w/b.md', '/w/b.md']]) })
    expect(out).toBe('see [hooks/a.ts:12](file:///w/hooks/a.ts#L12) and [/w/b.md](file:///w/b.md)')
  })
  test('lineOfFileUrl', () => {
    expect(lineOfFileUrl('file:///w/a.ts#L12')).toBe(12)
    expect(lineOfFileUrl('file:///w/a.ts#L12C3')).toBe(12)
    expect(lineOfFileUrl('file:///w/a.ts#L12-L20')).toBe(12)
    expect(lineOfFileUrl('file:///w/a.ts')).toBeUndefined()
  })
})

describe('link text', () => {
  test('a path with parens stays one link target', () => {
    const url = fileUrl('/a/b (1)/c')
    expect(url).toBe('file:///a/b%20%281%29/c')
    expect(pathOfFileUrl(url)).toBe('/a/b (1)/c')
  })
  test('emphasis marks in a label are escaped', () => {
    const paths = new Map([['pkg/__init__.py', '/w/pkg/__init__.py']])
    expect(linkify('see pkg/__init__.py', { paths })).toBe('see [pkg/\\_\\_init\\_\\_.py](file:///w/pkg/__init__.py)')
  })
})

describe('review #51: the reply is never corrupted', () => {
  const repo = { owner: 'o', repo: 'r' }
  test('a URL in backticks stays as written', () => {
    const text = 'Use `https://example.com` here and `curl https://x.dev/a` too'
    expect(linkify(text, { paths: new Map(), defaultRepo: repo })).toBe(text)
  })
  test('a ```` fence holding a ``` block is left whole', () => {
    const text = '````md\n```sh\nls /tmp/dir\n```\nsee #12\n````\nafter #3'
    const out = linkify(text, { paths: new Map([['/tmp/dir', '/tmp/dir']]), defaultRepo: repo })
    expect(out).toBe('````md\n```sh\nls /tmp/dir\n```\nsee #12\n````\nafter [#3](https://github.com/o/r/issues/3)')
  })
  test('a ~~~ fence is not closed by ```', () => {
    const text = '~~~\n```\n#12\n~~~\n#4'
    expect(linkify(text, { paths: new Map(), defaultRepo: repo })).toBe('~~~\n```\n#12\n~~~\n[#4](https://github.com/o/r/issues/4)')
  })
  test('a Markdown link with a title is left whole', () => {
    const paths = new Map([['/tmp/dir', '/tmp/dir']])
    for (const text of ['[#12](https://example.com "Issue")', "[/tmp/dir](https://e.com/x 'title')", '[a](https://e.com/(x))']) {
      expect(linkify(text, { paths, defaultRepo: repo })).toBe(text)
    }
  })
  test('the placeholder mark never leaks', () => {
    const text = '`a` https://e.com `#1` [x](https://e.com "t") `` `b` `` #2'
    expect(linkify(text, { paths: new Map(), defaultRepo: repo })).not.toContain('')
  })
})

describe('review #51 round 2', () => {
  const repo = { owner: 'o', repo: 'r' }
  test('only a plain directory may be a link target', () => {
    expect(linkTarget('/work/repo/docs', 'dir')).toBe('/work/repo/docs')
    expect(linkTarget('/Applications/Evil.app', 'dir')).toBeUndefined()
    expect(linkTarget('/x', 'other')).toBeUndefined()
  })
  test('an unlisted file (or any, with openFiles off) links to the directory holding it', () => {
    expect(linkTarget('/tmp/evil.command', 'file')).toBe('/tmp')
    expect(linkTarget('/tmp/run.py', 'file')).toBe('/tmp')
    expect(linkTarget('/work/repo/package.json', 'file', false)).toBe('/work/repo')
    expect(linkTarget('/top', 'file')).toBe('/')
    // a file right in a bundle: opening the bundle would launch it
    expect(linkTarget('/Applications/Evil.app/run', 'file')).toBeUndefined()
    expect(linkTarget('/Applications/Evil.app/Contents/MacOS/evil', 'file')).toBe('/Applications/Evil.app/Contents/MacOS')
  })
  test('a file path is labelled as written and leads to its directory', () => {
    const out = linkify('see /work/repo/package.json:12 now', { paths: new Map([['/work/repo/package.json:12', '/work/repo']]) })
    expect(out).toBe('see [/work/repo/package.json:12](file:///work/repo) now')
  })
  test('fences inside a quote or a list item are left whole', () => {
    for (const text of ['> ```sh\n> ls /tmp/dir #12\n> ```', '- step\n    ```\n    cd /tmp/dir #12\n    ```', '1. ```\n   #12\n   ```']) {
      expect(linkify(text, { paths: new Map([['/tmp/dir', '/tmp/dir']]), defaultRepo: repo })).toBe(text)
    }
  })
  test('reference links and their definitions are left whole', () => {
    const text = 'see [#12][issue] and [/tmp/dir][]\n\n[issue]: https://example.com/#3 "t"\n[/tmp/dir]: /tmp/dir'
    expect(linkify(text, { paths: new Map([['/tmp/dir', '/tmp/dir']]), defaultRepo: repo })).toBe(text)
  })
  test('a path with non-ASCII names is one path, never its prefix', () => {
    expect(findPaths('see /tmp/日本語/report.md here')).toEqual(['/tmp/日本語/report.md'])
    const paths = new Map([['/tmp/', '/tmp']])
    expect(linkify('see /tmp/日本語/report.md here', { paths })).toBe('see /tmp/日本語/report.md here')
  })
  test('prose run on after a path still finds the path', () => {
    expect(spellingsOf('/tmp/xと書いた')).toEqual(['/tmp/xと書いた', '/tmp/x'])
    expect(spellingsOf('/tmp/日本語/a.md')).toEqual(['/tmp/日本語/a.md'])
    expect(findPaths('パスは/tmp/xと書いた')).toEqual(['/tmp/xと書いた', '/tmp/x'])
    expect(linkify('パスは/tmp/xと書いた', { paths: new Map([['/tmp/x', '/tmp/x']]) })).toBe('パスは[/tmp/x](file:///tmp/x)と書いた')
  })
  test('owner/repo#N is an issue even where owner/repo is a directory', () => {
    const paths = new Map([['nodejs/node', '/work/nodejs/node']])
    expect(linkify('see nodejs/node#12', { paths })).toBe('see [nodejs/node#12](https://github.com/nodejs/node/issues/12)')
  })
})

describe('review #51 round 3', () => {
  const repo = { owner: 'o', repo: 'r' }
  const dir = new Map([['/tmp/dir', '/tmp/dir']])
  test('an indented code block and a fence nested in a list and a quote are left whole', () => {
    for (const text of ['text\n\n    cd /tmp/dir #12\n', '- item\n  > ```\n  > ls /tmp/dir #12\n  > ```', '> \tls /tmp/dir #12']) {
      expect(linkify(text, { paths: dir, defaultRepo: repo })).toBe(text)
    }
  })
  test('inline code over a line break is left whole', () => {
    const text = 'run `cd /tmp/dir\n#12` then'
    expect(linkify(text, { paths: dir, defaultRepo: repo })).toBe(text)
  })
  test('a shortcut reference with a definition is left whole, one without is linked', () => {
    const text = 'see [#12] and #3\n\n[#12]: https://example.com/original'
    expect(linkify(text, { paths: new Map(), defaultRepo: repo })).toBe('see [#12] and [#3](https://github.com/o/r/issues/3)\n\n[#12]: https://example.com/original')
  })
  test('a trailing . or .. segment stays part of the path', () => {
    expect(trimPath('hooks/..')).toBe('hooks/..')
    expect(trimPath('hooks/.')).toBe('hooks/.')
    expect(trimPath('hooks/...')).toBe('hooks/')
    expect(trimPath('/tmp/dir.')).toBe('/tmp/dir')
    expect(findPaths('go up with hooks/.. now')).toEqual(['hooks/..'])
    expect(linkify('go up with hooks/.. now', { paths: new Map([['hooks/..', '/w']]) })).toBe('go up with [hooks/..](file:///w) now')
  })
})

describe('review #51 round 4', () => {
  const repo = { owner: 'o', repo: 'r' }
  const dir = new Map([['/tmp/dir', '/tmp/dir']])
  test('a quoted fence line inside a plain fence does not close it', () => {
    const text = '```\n> ```\n> #12 /tmp/dir\n```\n#3'
    expect(linkify(text, { paths: dir, defaultRepo: repo })).toBe('```\n> ```\n> #12 /tmp/dir\n```\n[#3](https://github.com/o/r/issues/3)')
  })
  test('a code span ending in a line break is left whole', () => {
    const text = 'run `\ncd /tmp/dir #12\n` now'
    expect(linkify(text, { paths: dir, defaultRepo: repo })).toBe(text)
  })
  test('a link whose label holds brackets, and a quoted definition, are left whole', () => {
    for (const text of ['[#12 and [closed]](https://example.com)', '> [#12]: https://example.com/x\n\nsee [#12]']) {
      expect(linkify(text, { paths: dir, defaultRepo: repo })).toBe(text)
    }
  })
  test('a file URL loses its fragment and query, not an encoded #', () => {
    expect(pathOfFileUrl('file:///work/repo/main.ts#L12')).toBe('/work/repo/main.ts')
    expect(pathOfFileUrl('file:///work/a?x=1')).toBe('/work/a')
    expect(pathOfFileUrl('file:///work/a%23b')).toBe('/work/a#b')
  })
})

describe('issue words after Japanese punctuation', () => {
  test('、#47 and 。#3 are issue words', () => {
    expect(linkify('ファイル、#47。#3', { paths: new Map(), defaultRepo: { owner: 'o', repo: 'r' } })).toBe('ファイル、[#47](https://github.com/o/r/issues/47)。[#3](https://github.com/o/r/issues/3)')
  })
})
