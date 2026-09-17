import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// The mod must never spend a token: the game, the charts and the dashboard only read what the
// engine already has (event inputs, the status line's figures). These calls would each start a
// model request or a token-count request, so none may appear in hooks/.
const FORBIDDEN: [RegExp, string][] = [
  [/\$\.model\./, '$.model.* (a model request)'],
  [/\$\.agent\.(?!list\()/, '$.agent.* other than list() (a subagent run)'],
  [/\$\.prompt\.submit/, '$.prompt.submit (starts a turn)'],
  [/\$\.session\.compact/, '$.session.compact (a summarising request)'],
  [/\$\.tool\.register/, '$.tool.register (a tool the model would read and call)'],
]

// `$.agent.list()` is free too: it names the subagents the session already ran, and starts none.
// `$.session.usage()` is free, and so is the breakdown the dashboard asks for: `summary` estimates
// the context by category locally and sends no request. `full` sends one token-count request per
// tool and memory file, and any other argument cannot be read here — both are refused.
const ALLOWED_USAGE = [/^$/, /^\{\s*breakdown:\s*'summary',?\s*\}$/]

export function badUsageCalls(text: string): string[] {
  const bad: string[] = []
  for (const m of text.matchAll(/\$\.session\.usage\(([^)]*)\)/g)) {
    const args = m[1].trim()
    if (!ALLOWED_USAGE.some(ok => ok.test(args))) bad.push(`$.session.usage(${args}) (only the free call and breakdown: 'summary' are allowed)`)
  }
  return bad
}

const sources = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name)
  if (statSync(path).isDirectory()) return sources(path)
  return /\.tsx?$/.test(name) && name !== 'sprites.ts' ? [path] : []
})

describe('no tokens', () => {
  test('hooks/ makes no call that spends tokens', () => {
    const found: string[] = []
    for (const file of sources(join(import.meta.dir, '..', 'hooks'))) {
      const text = readFileSync(file, 'utf8')
      for (const [re, what] of FORBIDDEN) if (re.test(text)) found.push(`${file}: ${what}`)
      for (const what of badUsageCalls(text)) found.push(`${file}: ${what}`)
    }
    expect(found).toEqual([])
  })
  test('the roster may be read, but no subagent may be started', () => {
    const rule = FORBIDDEN.find(([, what]) => what.startsWith('$.agent.'))![0]
    expect(rule.test('await $.agent.list()')).toBe(false)
    expect(rule.test('await $.agent.spawn({ prompt })')).toBe(true)
    expect(rule.test('await $.agent.listen()')).toBe(true)
  })
  test("the usage rule lets the free call and 'summary' through, and nothing else", () => {
    expect(badUsageCalls('await $.session.usage()')).toEqual([])
    expect(badUsageCalls("await $.session.usage({ breakdown: 'summary' })")).toEqual([])
    expect(badUsageCalls("await $.session.usage({ breakdown: 'full' })")).toHaveLength(1)
    expect(badUsageCalls('await $.session.usage({ breakdown: detail })')).toHaveLength(1)
    expect(badUsageCalls("await $.session.usage({ breakdown: 'summary', columns })")).toHaveLength(1)
  })
})
