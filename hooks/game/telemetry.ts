import type { Hero } from './hero.ts'

// What this session looked like, for the dashboard: the events the hooks module caught, the tokens
// Claude's turns spent, and how Kaneed's adventure moved along. Pure data, kept in memory by the
// hooks module (it starts over with the session) and handed to the board as props.

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type ApiUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
export type TurnPoint = Tokens & { at: number; ms: number; agent: boolean }
// kills in a sample are the session's running total, so the line only climbs across deaths
export type Sample = { at: number; lv: number; hp: number; maxHp: number; floor: number; run: number; gold: number; kills: number }
export type Context = { usd: number | null; percent: number | null; tokens: number | null; window: number | null }

export type Telemetry = {
  startedAt: number
  events: Record<string, number>
  tools: Record<string, number>
  // events per minute: perMinute[i] counts minute (minuteBase + i) of the session
  perMinute: number[]
  minuteBase: number
  turns: TurnPoint[]
  totals: Tokens
  mainTurns: number
  agentTurns: number
  agents: string[]
  context: Context
  samples: Sample[]
  sampleEvery: number
  // the session's own tallies: kills and steps add up across runs, a death does not reset them
  kills: number
  steps: number
  deaths: number
  items: number
  levels: number
  lastHero: { run: number; kills: number; steps: number } | null
}

export const TURNS_KEEP = 200
export const SAMPLES_KEEP = 240
export const MINUTES_KEEP = 180
const SAMPLE_MS = 5000

export const newTelemetry = (now: number): Telemetry => ({
  startedAt: now, events: {}, tools: {}, perMinute: [], minuteBase: 0, turns: [],
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, mainTurns: 0, agentTurns: 0, agents: [],
  context: { usd: null, percent: null, tokens: null, window: null },
  samples: [], sampleEvery: SAMPLE_MS, kills: 0, steps: 0, deaths: 0, items: 0, levels: 0, lastHero: null,
})

// one caught event in its minute's bucket; minutes older than MINUTES_KEEP fall off the front
function perMinute(t: Telemetry, now: number) {
  const minute = Math.max(0, Math.floor((now - t.startedAt) / 60000))
  while (t.minuteBase + t.perMinute.length <= minute) t.perMinute.push(0)
  const drop = t.perMinute.length - MINUTES_KEEP
  if (drop > 0) {
    t.perMinute.splice(0, drop)
    t.minuteBase += drop
  }
  t.perMinute[minute - t.minuteBase]++
}

export function countEvent(t: Telemetry, label: string, now: number) {
  t.events[label] = (t.events[label] ?? 0) + 1
  perMinute(t, now)
}

// mcp__server__tool reads as server:tool
export const toolLabel = (tool: string) => {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  return m ? `${m[1].replace(/^plugin_[^_]+_/, '')}:${m[2]}` : tool
}

export function countTool(t: Telemetry, tool: string, now: number) {
  const label = toolLabel(tool)
  t.tools[label] = (t.tools[label] ?? 0) + 1
  countEvent(t, 'ツール', now)
}

// a finished turn: its tokens as the API counted them (absent when no response came back)
export function recordTurn(t: Telemetry, usage: ApiUsage | undefined, ms: number, agentId: string | undefined, now: number) {
  const agent = agentId !== undefined
  if (agent) {
    t.agentTurns++
    if (!t.agents.includes(agentId)) t.agents.push(agentId)
  } else t.mainTurns++
  countEvent(t, agent ? 'サブ完了' : 'ターン完了', now)
  if (!usage) return
  const point: TurnPoint = {
    at: now, ms, agent,
    input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens,
  }
  t.totals.input += point.input
  t.totals.output += point.output
  t.totals.cacheRead += point.cacheRead
  t.totals.cacheWrite += point.cacheWrite
  t.turns.push(point)
  if (t.turns.length > TURNS_KEEP) t.turns.splice(0, t.turns.length - TURNS_KEEP)
}

export function recordContext(t: Telemetry, usage: { context?: { tokens?: number; window?: number; percent?: number }; cost?: { usd: number } }) {
  t.context = {
    usd: usage.cost?.usd ?? t.context.usd,
    percent: usage.context?.percent ?? t.context.percent,
    tokens: usage.context?.tokens ?? t.context.tokens,
    window: usage.context?.window ?? t.context.window,
  }
}

export type HeroSave = { hero: Hero; floor: number; maxHp: number; log: readonly string[]; died: boolean; levels: number }

// a save from the board: Kaneed's sheet now, the log lines it wrote, whether it died or levelled
export function recordHero(t: Telemetry, { hero, floor, maxHp, log, died, levels }: HeroSave, now: number) {
  const prev = t.lastHero
  if (prev) {
    // a new run starts its counters from zero: what it has is all new
    const sameRun = prev.run === hero.run
    t.kills += Math.max(0, hero.kills - (sameRun ? prev.kills : 0))
    t.steps += Math.max(0, hero.steps - (sameRun ? prev.steps : 0))
  }
  t.lastHero = { run: hero.run, kills: hero.kills, steps: hero.steps }
  if (died) t.deaths++
  t.levels += levels
  t.items += log.filter(line => /手に入れ/.test(line)).length

  const sample: Sample = { at: now, lv: hero.lv, hp: hero.hp, maxHp, floor, run: hero.run, gold: hero.gold, kills: t.kills }
  const last = t.samples[t.samples.length - 1]
  // within one sampling interval the latest reading replaces the last, unless the run changed
  if (last && now - last.at < t.sampleEvery && last.run === sample.run && t.samples.length > 1) {
    t.samples[t.samples.length - 1] = { ...sample, at: last.at }
    return
  }
  t.samples.push(sample)
  // a full series keeps every other point and samples half as often from then on
  if (t.samples.length > SAMPLES_KEEP) {
    t.samples = t.samples.filter((_, i) => i % 2 === 0 || i === t.samples.length - 1)
    t.sampleEvery *= 2
  }
}

export const eventTotal = (t: Telemetry) => Object.values(t.events).reduce((a, n) => a + n, 0)

// what the board draws from: the session so far, with the bookkeeping left out. A detached copy:
// the engine freezes a Client's props, and the telemetry itself goes on being written to.
export type Dash = Omit<Telemetry, 'agents' | 'lastHero' | 'sampleEvery'> & { agentCount: number }

export const dash = (t: Telemetry): Dash => ({
  startedAt: t.startedAt, events: { ...t.events }, tools: { ...t.tools }, perMinute: [...t.perMinute], minuteBase: t.minuteBase,
  turns: t.turns.slice(-120).map(p => ({ ...p })), totals: { ...t.totals }, mainTurns: t.mainTurns, agentTurns: t.agentTurns,
  context: { ...t.context }, samples: t.samples.map(p => ({ ...p })), kills: t.kills, steps: t.steps, deaths: t.deaths,
  items: t.items, levels: t.levels, agentCount: t.agents.length,
})
