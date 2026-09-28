import { describe, expect, test } from 'bun:test'
import { githubSummary, hostSummary, htmlTitle, isFetchable } from '../hooks/links/summary.ts'

describe('githubSummary', () => {
  test('an open issue', () => {
    expect(githubSummary({ number: 1, title: 'feat: tray', state: 'open' })).toEqual({ kind: 'issue', state: 'open', text: '#1 feat: tray [open]' })
  })
  test('a closed issue', () => {
    expect(githubSummary({ number: 2, title: 'bug', state: 'closed' })?.text).toBe('#2 bug [closed]')
  })
  test('an open PR is told apart by its pull_request key', () => {
    expect(githubSummary({ number: 3, title: 'add tray', state: 'open', pull_request: { url: 'x', merged_at: null } })).toMatchObject({ kind: 'pr', state: 'open' })
  })
  test('a merged PR reads merged, not closed', () => {
    expect(githubSummary({ number: 4, title: 'done', state: 'closed', pull_request: { merged_at: '2026-09-22T00:00:00Z' } })?.text).toBe('#4 done [merged]')
    expect(githubSummary({ number: 5, title: 'done', state: 'closed', merged: true, pull_request: {} })?.state).toBe('merged')
  })
  test('a closed PR that was not merged reads closed', () => {
    expect(githubSummary({ number: 6, title: 'dropped', state: 'closed', pull_request: { merged_at: null } })?.state).toBe('closed')
  })
  test('whitespace in a title is collapsed and a long one is cut', () => {
    expect(githubSummary({ number: 7, title: '  a \n b  ', state: 'open' })?.text).toBe('#7 a b [open]')
    const long = 'x'.repeat(300)
    expect(githubSummary({ number: 8, title: long, state: 'open' })!.text.length).toBeLessThan(140)
  })
  test('not an issue: undefined', () => {
    expect(githubSummary(null)).toBeUndefined()
    expect(githubSummary({ message: 'Not Found' })).toBeUndefined()
    expect(githubSummary('nope')).toBeUndefined()
  })
})

describe('htmlTitle', () => {
  test('reads the title, decodes entities, collapses whitespace', () => {
    expect(htmlTitle('<html><head><title>\n  Foo &amp; Bar &#x2014; Baz &#39;q&#39;\n</title></head></html>')).toBe("Foo & Bar — Baz 'q'")
  })
  test('a title with attributes, case-insensitive', () => {
    expect(htmlTitle('<TITLE lang="ja">タイトル</TITLE>')).toBe('タイトル')
  })
  test('no title, or an empty one: undefined', () => {
    expect(htmlTitle('<html><body>hi</body></html>')).toBeUndefined()
    expect(htmlTitle('<title>   </title>')).toBeUndefined()
  })
})

describe('hostSummary', () => {
  test('host and the start of the path', () => {
    expect(hostSummary('https://example.com/')).toBe('example.com')
    expect(hostSummary('https://docs.example.com/guide/intro?x=1')).toBe('docs.example.com/guide/intro')
    expect(hostSummary('not a url')).toBe('not a url')
  })
})

describe('isFetchable', () => {
  test('public http(s) hosts are', () => {
    expect(isFetchable('https://example.com/x')).toBe(true)
    expect(isFetchable('http://8.8.8.8/')).toBe(true)
  })
  test('loopback, private and link-local addresses are not', () => {
    for (const url of [
      'http://localhost:3000/',
      'http://app.localhost/',
      'http://127.0.0.1/',
      'http://10.1.2.3/',
      'http://192.168.0.10/',
      'http://172.16.5.5/',
      'http://172.31.255.1/',
      'http://169.254.1.1/',
      'http://printer.local/',
      'http://[::1]/',
    ]) expect(isFetchable(url)).toBe(false)
    expect(isFetchable('http://172.32.0.1/')).toBe(true)
  })
  test('other schemes and junk are not', () => {
    expect(isFetchable('ftp://example.com/')).toBe(false)
    expect(isFetchable('nope')).toBe(false)
  })
})
