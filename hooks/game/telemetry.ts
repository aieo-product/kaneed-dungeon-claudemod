import type { Hero } from './hero.ts'
import type { GameEvent } from './sim.ts'

// What this session looked like, for the dashboard: the events the hooks module caught, what
// Claude's turns spent, and the record of Kaneed's adventure. Pure data, kept in memory by the
// hooks module (it starts over with the session) and handed to the board as props.

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type ApiUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
// one finished turn: what it spent, how long it took, and (main turns only) the prompt it answered
// and the dollars the cost ledger moved by while it ran
export type TurnPoint = Tokens & { at: number; ms: number; agent: boolean; agentId?: string; turnId: string; model: string; reason: string; usd?: number; label?: string }
export type Loop = Tokens & { turns: number }
// what the session knows about a subagent it ran: the type the Agent tool dispatched and the task
export type AgentKind = { type: string; description: string }
export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }
// one row of the context breakdown, as /context lists it
export type ContextSlice = { name: string; tokens: number; kind: string }
export type Breakdown = { slices: ContextSlice[]; total: number; window: number; percent: number; model: string; at: number }
export type Context = { usd: number | null; percent: number | null; tokens: number | null; window: number | null; rateLimits: RateLimit[]; breakdown: Breakdown | null }

// Kaneed's session record: what the status sheet cannot show. Counted from the simulation's own
// events on the board and posted here, so every count is of something that actually happened.
export type Tally = {
  attacks: number
  crits: number
  dealt: number
  hitsTaken: number
  dodges: number
  taken: number
  kills: number
  bossKills: number
  chests: number
  items: number
  downgrades: number
  gold: number
  healTest: number
  healLevel: number
  healed: number
}

export type Telemetry = {
  startedAt: number
  events: Record<string, number>
  tools: Record<string, number>
  // events per minute: perMinute[i] counts minute (minuteBase + i) of the session
  perMinute: number[]
  minuteBase: number
  turns: TurnPoint[]
  // the turns that spent the most, whole-session: these outlive `turns` falling off the front
  heavy: TurnPoint[]
  totals: Tokens
  mainTurns: number
  agentTurns: number
  agents: string[]
  // per model id, and per loop: 'main' and one key per subagent id
  models: Record<string, Loop>
  loops: Record<string, Loop>
  // what each subagent id is, as the roster names it; empty until the roster is read
  kinds: Record<string, AgentKind>
  context: Context
  // the prompt each running main turn started with, by turn id, until its turn ends
  labels: Record<string, string>
  // the cost ledger as it stood when a turn last ended, to price the next one by its rise
  costAt: number | null
  tally: Tally
  // the session's own record: it adds up across runs, a death does not reset it
  steps: number
  deaths: number
  levels: number
  maxFloor: number
  maxLv: number
  lastHero: { run: number; steps: number } | null
}

export const TURNS_KEEP = 200
export const HEAVY_KEEP = 5
export const MINUTES_KEEP = 180
export const LABELS_KEEP = 40
const LABEL_CHARS = 90

export const newTally = (): Tally => ({
  attacks: 0, crits: 0, dealt: 0, hitsTaken: 0, dodges: 0, taken: 0, kills: 0, bossKills: 0,
  chests: 0, items: 0, downgrades: 0, gold: 0, healTest: 0, healLevel: 0, healed: 0,
})

export const newTelemetry = (now: number): Telemetry => ({
  startedAt: now, events: {}, tools: {}, perMinute: [], minuteBase: 0, turns: [], heavy: [],
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, mainTurns: 0, agentTurns: 0, agents: [],
  models: {}, loops: {}, kinds: {}, context: { usd: null, percent: null, tokens: null, window: null, rateLimits: [], breakdown: null },
  labels: {}, costAt: null, tally: newTally(), steps: 0, deaths: 0, levels: 0, maxFloor: 1, maxLv: 1, lastHero: null,
})

export const tokenTotal = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheWrite

// how much of the input came from the cache rather than being sent again, 0 to 1; null before any
// input has been counted
export function cacheHitRate(t: Tokens): number | null {
  const read = t.input + t.cacheRead + t.cacheWrite
  return read > 0 ? t.cacheRead / read : null
}

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

// Some turns are begun by the engine rather than typed: they arrive wrapped in a tag, which reads
// as what it is rather than as markup.
const WRAPPED: Record<string, string> = {
  'task-notification': '仕事の終わりの知らせ',
  'agent-message': 'エージェントからの連絡',
  'system-reminder': 'システムからの注意書き',
  'local-command-stdout': 'コマンドの出力',
  'command-message': 'コマンドの実行',
  'user-prompt-submit-hook': 'フックからの差し込み',
}

export function promptLabel(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  const tag = /^<([a-z][a-z-]*)[\s>]/.exec(line)?.[1]
  if (!tag) return line.slice(0, LABEL_CHARS)
  return WRAPPED[tag] ?? tag
}

// the prompt a main turn begins with, kept until that turn ends and takes it as its label
export function recordPrompt(t: Telemetry, turnId: string, text: string) {
  const line = promptLabel(text)
  if (!line) return
  t.labels[turnId] = line
  const keys = Object.keys(t.labels)
  for (const key of keys.slice(0, Math.max(0, keys.length - LABELS_KEEP))) delete t.labels[key]
}

const addTokens = (into: Tokens, p: Tokens) => {
  into.input += p.input
  into.output += p.output
  into.cacheRead += p.cacheRead
  into.cacheWrite += p.cacheWrite
}

const newLoop = (): Loop => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 })

export type TurnEnd = { usage?: (ApiUsage & { model?: string }) | undefined; ms: number; agentId?: string | undefined; turnId: string; reason: string }

// a finished turn: its tokens as the API counted them (absent when no response came back)
export function recordTurn(t: Telemetry, { usage, ms, agentId, turnId, reason }: TurnEnd, now: number) {
  const agent = agentId !== undefined
  if (agent) {
    t.agentTurns++
    if (!t.agents.includes(agentId)) t.agents.push(agentId)
  } else t.mainTurns++
  countEvent(t, agent ? 'サブ完了' : 'ターン完了', now)
  const label = t.labels[turnId]
  delete t.labels[turnId]
  if (!usage) return
  const point: TurnPoint = {
    at: now, ms, agent, turnId, reason, model: usage.model ?? '', ...(agentId ? { agentId } : {}), ...(label ? { label } : {}),
    input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens,
  }
  addTokens(t.totals, point)
  const loop = (t.loops[agentId ?? 'main'] ??= newLoop())
  addTokens(loop, point)
  loop.turns++
  if (point.model) {
    const model = (t.models[point.model] ??= newLoop())
    addTokens(model, point)
    model.turns++
  }
  t.turns.push(point)
  if (t.turns.length > TURNS_KEEP) t.turns.splice(0, t.turns.length - TURNS_KEEP)
  // the same object goes in both lists, so pricing the turn later shows up in either
  t.heavy.push(point)
  t.heavy.sort((a, b) => tokenTotal(b) - tokenTotal(a))
  if (t.heavy.length > HEAVY_KEEP) t.heavy.length = HEAVY_KEEP
}

// What the ledger says the session has cost, read after a main turn ends: the rise since the last
// reading is what that turn cost, subagents and all. The first reading only sets the mark (a
// resumed session starts with a bill already run up).
function priceTurn(t: Telemetry, usd: number) {
  const was = t.costAt
  t.costAt = usd
  if (was === null) return
  const spent = usd - was
  if (spent <= 0) return
  for (let i = t.turns.length - 1; i >= 0; i--) {
    const turn = t.turns[i]
    if (turn.agent) continue
    if (turn.usd === undefined) turn.usd = spent
    return
  }
}

export type UsageReading = {
  context?: { tokens?: number; window?: number; percent?: number; breakdown?: BreakdownReading }
  cost?: { usd: number }
  rateLimits?: RateLimit[]
}
export type BreakdownReading = { categories?: { name: string; tokens: number; kind: string }[]; totalTokens?: number; rawMaxTokens?: number; percentage?: number; model?: string }

// the subagents the session has run, as `$.agent.list()` reports them: reading the roster starts
// nothing and costs nothing, it only names the loops the turns already counted
export function recordAgents(t: Telemetry, agents: readonly { id: string; type?: string; description?: string; name?: string }[]) {
  for (const agent of agents) {
    const type = agent.type || agent.name || ''
    if (!type && !agent.description) continue
    t.kinds[agent.id] = { type, description: agent.description ?? '' }
  }
}

export function recordContext(t: Telemetry, usage: UsageReading, now = 0) {
  const breakdown = usage.context?.breakdown
  t.context = {
    usd: usage.cost?.usd ?? t.context.usd,
    percent: usage.context?.percent ?? t.context.percent,
    tokens: usage.context?.tokens ?? t.context.tokens,
    window: usage.context?.window ?? t.context.window,
    rateLimits: usage.rateLimits ? usage.rateLimits.map(r => ({ ...r })) : t.context.rateLimits,
    breakdown: breakdown?.categories?.length
      ? {
        slices: breakdown.categories.map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
        total: breakdown.totalTokens ?? 0, window: breakdown.rawMaxTokens ?? 0,
        percent: breakdown.percentage ?? 0, model: breakdown.model ?? '', at: now,
      }
      : t.context.breakdown,
  }
  if (usage.cost) priceTurn(t, usage.cost.usd)
}

// the simulation's events, counted: what the status sheet does not show. The board hands over what
// happened since its last save, so nothing is counted twice.
export function tallyEvents(tally: Tally, events: readonly GameEvent[], state: { boss: boolean } = { boss: false }) {
  for (const e of events) {
    switch (e.type) {
      case 'engage': state.boss = e.boss; break
      case 'hit':
        if (e.target === 'foe') {
          tally.attacks++
          tally.dealt += e.dmg
          if (e.crit) tally.crits++
        } else {
          tally.hitsTaken++
          tally.taken += e.dmg
        }
        break
      case 'miss': if (e.target === 'hero') tally.dodges++; break
      case 'kill':
        tally.kills++
        tally.gold += e.gold
        if (state.boss) tally.bossKills++
        state.boss = false
        break
      case 'chest':
        tally.chests++
        tally.gold += e.gold
        break
      case 'item':
        tally.items++
        if (e.replaced && !e.better) tally.downgrades++
        break
      case 'levelup': tally.healLevel++; break
      case 'heal':
        tally.healTest++
        tally.healed += e.amount
        break
      default: break
    }
  }
  return tally
}

export function addTally(into: Tally, from: Tally) {
  for (const key of Object.keys(into) as (keyof Tally)[]) into[key] += from[key]
  return into
}

export const isTally = (v: unknown): v is Tally =>
  typeof v === 'object' && v !== null && (Object.keys(newTally()) as (keyof Tally)[]).every(k => typeof (v as Tally)[k] === 'number')

export type HeroSave = { hero: Hero; floor: number; died: boolean; levels: number; tally?: Tally }

// a save from the board: Kaneed's sheet now, what the simulation counted since the last save,
// and whether it died or levelled
export function recordHero(t: Telemetry, { hero, floor, died, levels, tally }: HeroSave) {
  const prev = t.lastHero
  if (prev) {
    // a new run starts its counters from zero: what it has is all new
    const sameRun = prev.run === hero.run
    t.steps += Math.max(0, hero.steps - (sameRun ? prev.steps : 0))
  }
  t.lastHero = { run: hero.run, steps: hero.steps }
  if (died) t.deaths++
  t.levels += levels
  t.maxFloor = Math.max(t.maxFloor, floor)
  t.maxLv = Math.max(t.maxLv, hero.lv)
  if (tally) addTally(t.tally, tally)
}

export const eventTotal = (t: Telemetry) => Object.values(t.events).reduce((a, n) => a + n, 0)

// what the board draws from: the session so far, with the bookkeeping left out. A detached copy:
// the engine freezes a Client's props, and the telemetry itself goes on being written to.
export type Dash = Omit<Telemetry, 'agents' | 'lastHero' | 'labels' | 'costAt'> & { agentCount: number }

export const dash = (t: Telemetry): Dash => ({
  startedAt: t.startedAt, events: { ...t.events }, tools: { ...t.tools }, perMinute: [...t.perMinute], minuteBase: t.minuteBase,
  turns: t.turns.slice(-120).map(p => ({ ...p })), heavy: t.heavy.map(p => ({ ...p })), totals: { ...t.totals },
  mainTurns: t.mainTurns, agentTurns: t.agentTurns, agentCount: t.agents.length,
  models: Object.fromEntries(Object.entries(t.models).map(([k, v]) => [k, { ...v }])),
  loops: Object.fromEntries(Object.entries(t.loops).map(([k, v]) => [k, { ...v }])),
  kinds: Object.fromEntries(Object.entries(t.kinds).map(([k, v]) => [k, { ...v }])),
  context: { ...t.context, rateLimits: t.context.rateLimits.map(r => ({ ...r })), breakdown: t.context.breakdown ? { ...t.context.breakdown, slices: t.context.breakdown.slices.map(s => ({ ...s })) } : null },
  tally: { ...t.tally }, steps: t.steps, deaths: t.deaths, levels: t.levels, maxFloor: t.maxFloor, maxLv: t.maxLv,
})
