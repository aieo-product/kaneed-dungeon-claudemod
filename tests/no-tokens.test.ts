import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// The mod must never spend a token: the game, the charts and the dashboard only read what the
// engine already has (event inputs, the status line's figures). These calls would each start a
// model request or a token-count request, so none may appear in hooks/.
const FORBIDDEN: [RegExp, string][] = [
  [/\$\.model\./, '$.model.* (a model request)'],
  [/\$\.agent\./, '$.agent.* (a subagent run)'],
  [/\$\.prompt\.submit/, '$.prompt.submit (starts a turn)'],
  [/\$\.session\.compact/, '$.session.compact (a summarising request)'],
  [/\$\.session\.usage\(\s*[^)\s]/, '$.session.usage with arguments (a breakdown counts tokens by API)'],
  [/\$\.tool\.register/, '$.tool.register (a tool the model would read and call)'],
]

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
    }
    expect(found).toEqual([])
  })
})
