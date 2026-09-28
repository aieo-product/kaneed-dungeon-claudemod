import { describe, expect, test } from 'bun:test'
import { fit, join, MAX_RUNS, runs, share, withinSize, type Cell } from '../hooks/boards/runs.ts'

const WALL = '#303030'
const MORTAR = '#1c1c1c'
const FLOOR = '#af875f'
const GRIT = '#875f00'
const MAP = '#121212'

// one wall row as the canvas gives it: 13 cells of brick over mortar (▀), then a mortar cell (blank)
const wallRow = (columns: number): Cell[] =>
  Array.from({ length: columns }, (_, x): Cell => (x % 14 === 13 ? [' ', undefined, MORTAR] : ['▀', WALL, MORTAR]))
// the floor: grit every few cells, then the minimap's dark inside over its right end
const floorRow = (columns: number, map = 34): Cell[] =>
  Array.from({ length: columns }, (_, x): Cell => (x >= columns - map ? [' ', undefined, MAP] : x % 5 === 2 ? ['▀', GRIT, FLOOR] : ['▀', FLOOR, FLOOR]))

const text = (cells: readonly Cell[]) => cells.map(c => c[0]).join('')

describe('join', () => {
  test('cells sharing a style join one run', () => {
    expect(join([['a', 'red'], ['b', 'red'], ['c', 'blue']])).toEqual([['ab', 'red', undefined, undefined, undefined], ['c', 'blue', undefined, undefined, undefined]])
  })
  test('a blank joins the run beside it on the same background, either side', () => {
    expect(join([['▀', WALL, MORTAR], [' ', undefined, MORTAR], ['▀', WALL, MORTAR]])).toEqual([['▀ ▀', WALL, MORTAR, undefined, undefined]])
    expect(join([[' ', undefined, MORTAR], ['▀', WALL, MORTAR]])).toEqual([[' ▀', WALL, MORTAR, undefined, undefined]])
    expect(join([['▀', WALL, MORTAR], [' ', undefined, WALL]])).toHaveLength(2)
  })
  test('a wall row of any width is one run (issue #47)', () => {
    for (const columns of [140, 330, 520, 800]) {
      const out = join(wallRow(columns))
      expect(out).toHaveLength(1)
      expect(text(out)).toBe(text(wallRow(columns)))
    }
  })
})

describe('fit', () => {
  test('specks go first: the minimap at the end of a busy floor keeps its colour (issue #47)', () => {
    const out = runs(floorRow(373), MAX_RUNS)
    expect(out.length).toBeLessThanOrEqual(MAX_RUNS)
    expect(text(out)).toBe(text(floorRow(373)))
    const last = out[out.length - 1]
    expect(last[2]).toBe(MAP)
    expect(last[0]).toBe(' '.repeat(34))
  })
  test('a half block never loses its foreground', () => {
    const row: Cell[] = Array.from({ length: 520 }, (_, x): Cell => (x % 7 === 6 ? [' ', undefined, x % 2 ? MORTAR : WALL] : ['▀', WALL, x % 2 ? WALL : MORTAR]))
    const out = fit(join(row), 8)
    expect(out.length).toBeLessThanOrEqual(8)
    expect(text(out)).toBe(text(row))
    for (const [t, fg] of out) if (t.includes('▀')) expect(fg).toBeDefined()
  })
})

describe('withinSize', () => {
  test('draws with the full budget when it fits, and with less until it does', () => {
    const tried: number[] = []
    const draw = (budget: number) => { tried.push(budget); return 'x'.repeat(budget * 10) }
    expect(withinSize(13, draw, 10_000).length).toBe(13 * MAX_RUNS * 10)
    tried.length = 0
    const out = withinSize(13, draw, 5000)
    expect(out.length).toBeLessThanOrEqual(5000 + 2)
    expect(tried[0]).toBe(13 * MAX_RUNS)
    expect(tried.at(-1)!).toBeLessThan(13 * MAX_RUNS)
  })
  test('a drawing that never fits ends after a few tries, never below one span a row', () => {
    const tried: number[] = []
    withinSize(4, budget => { tried.push(budget); return 'x'.repeat(100_000) }, 10)
    expect(tried.length).toBeLessThanOrEqual(7)
    expect(Math.min(...tried)).toBeGreaterThanOrEqual(4)
  })
})

describe('share', () => {
  test('quiet rows lend their share to busy ones, and the whole stays within budget', () => {
    // 373 columns: the width the minimap went wrong at
    const rows = [...Array.from({ length: 11 }, () => wallRow(373)), floorRow(373), floorRow(373)]
    const out = share(rows)
    expect(out.reduce((n, r) => n + r.length, 0)).toBeLessThanOrEqual(rows.length * MAX_RUNS)
    // the floor needs ~140 runs a row: over one row's 64, inside what the walls leave
    expect(out[11]).toEqual(join(floorRow(373)))
    out.forEach((r, i) => expect(text(r)).toBe(text(rows[i])))
  })
  test('a picture over budget as a whole is cut, every row keeping at least one run', () => {
    const rows = Array.from({ length: 4 }, () => floorRow(700))
    const out = share(rows, 40)
    expect(out.reduce((n, r) => n + r.length, 0)).toBeLessThanOrEqual(40)
    out.forEach((r, i) => {
      expect(r.length).toBeGreaterThan(0)
      expect(text(r)).toBe(text(rows[i]))
      // the minimap at the end survives the cut
      expect(r[r.length - 1][2]).toBe(MAP)
    })
  })
})
