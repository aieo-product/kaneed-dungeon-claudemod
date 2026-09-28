import { describe, expect, test } from 'bun:test'
import { runs, type Cell } from '../hooks/boards/runs.ts'

const WALL = '#303030'
const MORTAR = '#1c1c1c'

// one wall row as the canvas gives it: 13 cells of brick over mortar (▀), then a mortar cell (blank)
const wallRow = (columns: number): Cell[] =>
  Array.from({ length: columns }, (_, x): Cell => (x % 14 === 13 ? [' ', undefined, MORTAR] : ['▀', WALL, MORTAR]))

const text = (cells: readonly Cell[]) => cells.map(c => c[0]).join('')

describe('runs', () => {
  test('cells sharing a style join one run', () => {
    expect(runs([['a', 'red'], ['b', 'red'], ['c', 'blue']])).toEqual([['ab', 'red', undefined, undefined, undefined], ['c', 'blue', undefined, undefined, undefined]])
  })
  test('a blank joins the run beside it on the same background, either side', () => {
    expect(runs([['▀', WALL, MORTAR], [' ', undefined, MORTAR], ['▀', WALL, MORTAR]])).toEqual([['▀ ▀', WALL, MORTAR, undefined, undefined]])
    expect(runs([[' ', undefined, MORTAR], ['▀', WALL, MORTAR]])).toEqual([[' ▀', WALL, MORTAR, undefined, undefined]])
    // a different background is a different picture: kept apart
    expect(runs([['▀', WALL, MORTAR], [' ', undefined, WALL]])).toHaveLength(2)
  })
  test('a wall row of any width is one run, drawn as it is (issue #47)', () => {
    for (const columns of [140, 330, 520, 800]) {
      const row = wallRow(columns)
      const out = runs(row)
      expect(out).toHaveLength(1)
      expect(text(out)).toBe(text(row))
      expect(out[0][1]).toBe(WALL)
    }
  })
  test('a fold never leaves a half block without a foreground', () => {
    // alternating backgrounds: nothing joins, so the row has to fold
    const row: Cell[] = Array.from({ length: 520 }, (_, x): Cell => (x % 7 === 6 ? [' ', undefined, x % 2 ? MORTAR : WALL] : ['▀', WALL, x % 2 ? WALL : MORTAR]))
    const out = runs(row, 8)
    expect(out.length).toBeLessThanOrEqual(8)
    expect(text(out)).toBe(text(row))
    for (const [t, fg] of out) if (t.includes('▀')) expect(fg).toBeDefined()
  })
})
