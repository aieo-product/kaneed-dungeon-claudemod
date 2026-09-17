import { describe, expect, test } from 'bun:test'
import { cellWidth, compact, duration, hbar, padCells, resample, spark } from '../hooks/game/charts.ts'
import { newHero } from '../hooks/game/hero.ts'
import { addTally, cacheHitRate, promptLabel, recordAgents, countEvent, countTool, dash, HEAVY_KEEP, isTally, MINUTES_KEEP, newTally, newTelemetry, recordContext, recordHero, recordPrompt, recordTurn, tallyEvents, tokenTotal, toolLabel, TURNS_KEEP } from '../hooks/game/telemetry.ts'
import { startRun, step, takeEvents, type GameEvent } from '../hooks/game/sim.ts'

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0, model = 'claude-opus-5') =>
  ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, model })
const turn = (id: string, u: ReturnType<typeof usage> | undefined, at: number, agentId?: string, ms = 1000) =>
  ({ usage: u, ms, agentId, turnId: id, reason: 'answer' })

describe('charts', () => {
  test('sparklines scale to the largest value and pad to width', () => {
    expect(spark([0, 4, 8], 3)).toBe('▁▅█')
    expect(spark([1, 2], 5)).toBe('▅█   ')
    expect(spark([], 3)).toBe('   ')
    expect(spark([5, 5, 5], 3, { min: 5 })).toBe('▁▁▁')
    expect(spark([0.5], 1, { min: 0, max: 1 })).toBe('▅')
  })
  test('a long series keeps its tail, or is bucketed by mean or sum', () => {
    expect(resample([1, 2, 3, 4, 5, 6], 3)).toEqual([4, 5, 6])
    expect(resample([1, 3, 5, 7], 2, 'mean')).toEqual([2, 6])
    expect(resample([1, 3, 5, 7], 2, 'sum')).toEqual([4, 12])
    expect(spark(Array.from({ length: 100 }, (_, i) => i), 10, { mode: 'mean' })).toHaveLength(10)
  })
  test('bars are exactly as wide as asked, with a sliver for any non-zero value', () => {
    expect(hbar(10, 10, 4)).toBe('████')
    expect(hbar(5, 10, 4)).toBe('██  ')
    expect(hbar(1, 1000, 4)).toBe('▏   ')
    expect(hbar(0, 10, 4)).toBe('    ')
    for (let v = 0; v <= 10; v++) expect(cellWidth(hbar(v, 10, 7))).toBe(7)
  })
  test('Japanese labels count two cells a character', () => {
    expect(cellWidth('出力')).toBe(4)
    expect(padCells('出力', 8)).toBe('出力    ')
    expect(cellWidth(padCells('キャッシュ読み込み', 8))).toBe(8)
  })
  test('numbers and durations read short', () => {
    expect(compact(950)).toBe('950')
    expect(compact(1234)).toBe('1.2k')
    expect(compact(34_567)).toBe('35k')
    expect(compact(1_500_000)).toBe('1.5M')
    expect(duration(45_000)).toBe('45秒')
    expect(duration(12 * 60_000)).toBe('12分')
    expect(duration(65 * 60_000)).toBe('1時間05分')
  })
})

describe('telemetry', () => {
  test('events, tools and the per-minute series', () => {
    const t = newTelemetry(0)
    countEvent(t, 'ターン開始', 1000)
    countTool(t, 'Bash', 2000)
    countTool(t, 'Bash', 61_000)
    countTool(t, 'mcp__plugin_claude-mem_mcp-search__search', 125_000)
    expect(t.events).toEqual({ ターン開始: 1, ツール: 3 })
    expect(t.tools).toEqual({ Bash: 2, 'mcp-search:search': 1 })
    expect(t.perMinute).toEqual([2, 1, 1])
    expect(toolLabel('mcp__parts-manager__add_item')).toBe('parts-manager:add_item')
  })
  test('the per-minute series keeps a bounded window', () => {
    const t = newTelemetry(0)
    for (let m = 0; m < MINUTES_KEEP + 20; m++) countEvent(t, 'ターン開始', m * 60_000)
    expect(t.perMinute.length).toBe(MINUTES_KEEP)
    expect(t.minuteBase).toBe(20)
    countEvent(t, 'ターン開始', (MINUTES_KEEP + 19) * 60_000 + 5)
    expect(t.perMinute[t.perMinute.length - 1]).toBe(2)
  })
  test('turns add up their tokens; subagents and models are counted apart', () => {
    const t = newTelemetry(0)
    recordTurn(t, turn('t1', usage(100, 50, 1000, 10), 1), 1)
    recordTurn(t, turn('t2', usage(10, 5, 0, 0, 'claude-haiku-4-5'), 2, 'agent-1'), 2)
    recordTurn(t, turn('t3', usage(10, 5, 0, 0, 'claude-haiku-4-5'), 3, 'agent-1'), 3)
    recordTurn(t, turn('t4', undefined, 4), 4)
    expect(t.totals).toEqual({ input: 120, output: 60, cacheRead: 1000, cacheWrite: 10 })
    expect(t.mainTurns).toBe(2)
    expect(t.agentTurns).toBe(2)
    expect(t.turns.length).toBe(3)
    expect(t.events).toEqual({ ターン完了: 2, サブ完了: 2 })
    expect(dash(t).agentCount).toBe(1)
    expect(t.loops.main.turns).toBe(1)
    expect(tokenTotal(t.loops['agent-1'])).toBe(30)
    expect(t.models['claude-haiku-4-5'].turns).toBe(2)
    expect(cacheHitRate(t.totals)).toBeCloseTo(1000 / 1130, 6)
    expect(cacheHitRate({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0 })).toBeNull()
  })
  test('a turn carries the prompt it answered, and keeps its place among the heaviest', () => {
    const t = newTelemetry(0)
    recordPrompt(t, 't1', '  ダッシュボードの\n  確認をしたい  ')
    recordTurn(t, turn('t1', usage(10, 5), 1), 1)
    expect(t.turns[0].label).toBe('ダッシュボードの 確認をしたい')
    // a turn the engine began arrives wrapped in a tag: it reads as what it is, not as markup
    expect(promptLabel('<task-notification>\n  Explore finished\n</task-notification>')).toBe('仕事の終わりの知らせ')
    expect(promptLabel('<agent-message from="a15a6">done</agent-message>')).toBe('エージェントからの連絡')
    expect(promptLabel('<odd-wrapper>x</odd-wrapper>')).toBe('odd-wrapper')
    expect(promptLabel('<3 のような書き出しはそのまま')).toBe('<3 のような書き出しはそのまま')
    // the label is handed over once: a turn id never labels a second turn
    expect(t.labels).toEqual({})
    for (let i = 0; i < TURNS_KEEP + 10; i++) recordTurn(t, turn(`x${i}`, usage(i, 0), i + 2), i + 2)
    expect(t.turns.length).toBe(TURNS_KEEP)
    expect(t.heavy.length).toBe(HEAVY_KEEP)
    expect(t.heavy.map(tokenTotal)).toEqual([209, 208, 207, 206, 205])
  })
  test('the roster names the loops the turns were counted under', () => {
    const t = newTelemetry(0)
    recordTurn(t, turn('t1', usage(10, 5), 1, 'agent-1'), 1)
    expect(t.kinds).toEqual({})
    recordAgents(t, [
      { id: 'agent-1', type: 'Explore', description: '認証まわりの実装を探す' },
      { id: 'agent-2', type: '', description: '', name: 'reviewer' },
      { id: 'agent-3' },
    ])
    expect(t.kinds['agent-1']).toEqual({ type: 'Explore', description: '認証まわりの実装を探す' })
    // a roster entry with a name but no type is named by it; one with neither says nothing
    expect(t.kinds['agent-2']).toEqual({ type: 'reviewer', description: '' })
    expect(t.kinds['agent-3']).toBeUndefined()
    expect(t.turns[0].agentId).toBe('agent-1')
    expect(dash(t).kinds['agent-1'].type).toBe('Explore')
  })
  test('a turn is priced by how far the cost ledger rose while it ran', () => {
    const t = newTelemetry(0)
    // the first reading only marks where the ledger stood (a resumed session starts part-spent)
    recordContext(t, { cost: { usd: 1.0 } })
    recordTurn(t, turn('t1', usage(10, 5), 1), 1)
    recordContext(t, { cost: { usd: 1.25 } })
    recordTurn(t, turn('t2', usage(10, 5), 2, 'agent-1'), 2)
    recordTurn(t, turn('t3', usage(10, 5), 3), 3)
    recordContext(t, { cost: { usd: 1.75 } })
    expect(t.turns[0].usd).toBeCloseTo(0.25, 6)
    // a subagent's turn is not priced on its own: its cost is the main turn's
    expect(t.turns[1].usd).toBeUndefined()
    expect(t.turns[2].usd).toBeCloseTo(0.5, 6)
  })
  test('the context reading keeps the rate-limit windows and the breakdown', () => {
    const t = newTelemetry(0)
    recordContext(t, {
      context: { tokens: 45_000, window: 200_000, percent: 22.5, breakdown: { categories: [{ name: 'System prompt', tokens: 3000, kind: 'used' }, { name: 'Free space', tokens: 150_000, kind: 'free' }], totalTokens: 45_000, rawMaxTokens: 195_000, percentage: 23, model: 'claude-opus-5' } },
      cost: { usd: 0.42 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 38, resetsAt: '2026-09-16T22:10:00Z' }],
    }, 1000)
    expect(t.context.rateLimits[0].kind).toBe('five_hour')
    expect(t.context.breakdown?.slices).toHaveLength(2)
    // a later plain reading keeps the breakdown it cannot refresh
    recordContext(t, { context: { window: 200_000 }, cost: { usd: 0.5 } }, 2000)
    expect(t.context.breakdown?.total).toBe(45_000)
    expect(t.context.percent).toBe(22.5)
  })
  test("the simulation's events are counted as the record's numbers", () => {
    const events: GameEvent[] = [
      { type: 'engage', kind: 0, boss: true, lv: 3, hp: 20, maxHp: 20 },
      { type: 'hit', target: 'foe', dmg: 7, crit: true, hpLeft: 13 },
      { type: 'hit', target: 'hero', dmg: 4, crit: false, hpLeft: 26 },
      { type: 'miss', target: 'hero' },
      { type: 'kill', kind: 0, xp: 12, gold: 9 },
      { type: 'chest', gold: 25 },
      { type: 'item', name: '鉄の剣', rarity: 2, better: false, replaced: '鋼の剣', wizard: false },
      { type: 'levelup', lv: 4, hp: 30 },
      { type: 'heal', amount: 11 },
      { type: 'shop', shelf: [], lv: 4, gold: 80, hp: 20, equipment: newHero(1, 0).equipment, pick: 0, price: 30, healed: 12, item: null },
      { type: 'shop', shelf: [], lv: 4, gold: 50, hp: 32, equipment: newHero(1, 0).equipment, pick: 1, price: 40, healed: 0, item: { name: '鋼の盾', rarity: 3, better: true, replaced: '木の盾', wizard: false } },
    ]
    const tally = tallyEvents(newTally(), events)
    // the shop's ware counts as equipment too, and its remedy as a heal
    expect(tally).toMatchObject({ attacks: 1, crits: 1, dealt: 7, hitsTaken: 1, taken: 4, dodges: 1, kills: 1, bossKills: 1, chests: 1, gold: 34, items: 2, downgrades: 1, healLevel: 1, healTest: 1, healShop: 1, healed: 23, buys: 2, spent: 70 })
    // the foe on the field is remembered across the posts the board splits its events into
    const state = { boss: false }
    const split = tallyEvents(newTally(), [events[0]], state)
    tallyEvents(split, [events[4]], state)
    expect(split.bossKills).toBe(1)
    expect(isTally(tally)).toBe(true)
    expect(isTally({ attacks: 1 })).toBe(false)
    expect(addTally(newTally(), tally).dealt).toBe(7)
  })
  test('the record adds up across a death, and keeps the best the session reached', () => {
    const t = newTelemetry(0)
    const hero = newHero(1, 0)
    const save = (floor: number, died = false, levels = 0, tally = newTally()) =>
      recordHero(t, { hero: { ...hero }, floor, died, levels, tally })
    save(1)
    hero.steps = 40
    hero.lv = 6
    save(4, false, 1, { ...newTally(), kills: 3, attacks: 9 })
    // the run ends and the next starts from nothing
    Object.assign(hero, { run: 2, steps: 5, lv: 1 })
    save(1, true, 0, { ...newTally(), kills: 1 })
    expect(t.steps).toBe(45)
    expect(t.deaths).toBe(1)
    expect(t.levels).toBe(1)
    expect(t.maxFloor).toBe(4)
    expect(t.maxLv).toBe(6)
    expect(t.tally.kills).toBe(4)
    expect(t.tally.attacks).toBe(9)
  })
  test('the dashboard snapshot is detached: freezing it leaves the telemetry writable', () => {
    const t = newTelemetry(0)
    countTool(t, 'Bash', 0)
    recordTurn(t, turn('t1', usage(1, 1), 0), 0)
    recordHero(t, { hero: newHero(1, 0), floor: 1, died: false, levels: 0, tally: newTally() })
    recordContext(t, { rateLimits: [{ kind: 'five_hour', percentUsed: 10 }], context: { breakdown: { categories: [{ name: 'Messages', tokens: 10, kind: 'used' }] } } }, 0)
    const deepFreeze = (v: unknown): void => {
      if (typeof v !== 'object' || v === null) return
      Object.freeze(v)
      for (const x of Object.values(v)) deepFreeze(x)
    }
    deepFreeze(dash(t))
    expect(() => {
      countTool(t, 'Bash', 1)
      recordTurn(t, turn('t2', usage(1, 1), 1), 1)
      recordHero(t, { hero: newHero(1, 0), floor: 2, died: false, levels: 0, tally: { ...newTally(), kills: 1 } })
      recordContext(t, { cost: { usd: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: 20 }] }, 2)
    }).not.toThrow()
    expect(t.tools.Bash).toBe(2)
    expect(t.tally.kills).toBe(1)
  })
})

// the board hands its events over in the batches its saves fall into, so the record is counted the
// way the game actually plays: a real run, tallied a tick at a time
describe('the record of a real run', () => {
  test('a run of a few hundred ticks fills the counters the status sheet cannot show', () => {
    const t = newTelemetry(0)
    const s = startRun(7, 1, 0)
    takeEvents(s)
    const boss = { boss: false }
    let pending = newTally()
    for (let tick = 0; tick < 600; tick++) {
      const before = s.hero.lv
      step(s, tick * 500)
      tallyEvents(pending, takeEvents(s), boss)
      if (tick % 20 === 0) {
        recordHero(t, { hero: s.hero, floor: s.floorNum, died: s.phase === 'dead', levels: Math.max(0, s.hero.lv - before), tally: pending })
        pending = newTally()
      }
    }
    expect(t.tally.attacks).toBeGreaterThan(0)
    expect(t.tally.dealt).toBeGreaterThan(t.tally.attacks)
    expect(t.tally.kills).toBeGreaterThan(0)
    expect(t.tally.hitsTaken + t.tally.dodges).toBeGreaterThan(0)
    expect(t.steps).toBeGreaterThan(0)
    expect(t.maxLv).toBeGreaterThanOrEqual(1)
    // gold is earned across the run even when a death empties the purse
    expect(t.tally.gold).toBeGreaterThanOrEqual(0)
  })
})
