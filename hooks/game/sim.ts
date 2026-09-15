import { rng, type Rng } from './rng.ts'
import { bfs, chebyshev, generateFloor, idx, isFrontier, manhattan, neighbours, passable, reveal, same, T, tileAt, type Floor, type Pos } from './map.ts'
import { KINDS, spawnEnemies, type Enemy } from './enemies.ts'
import { damage, equip, gainXp, heal, newHero, stats, type Hero } from './hero.ts'
import { isWizardItem, itemName, rarityName, rollItem } from './items.ts'

// The game, one tick at a time. A tick is one thing happening: a step, or one exchange of blows
// with whatever stands next to Kaneed. The board calls `step` on a timer while Claude works; the
// hooks module feeds `testPassed` / `testFailed` from Claude's tool calls and `rebuildFloor` after
// a compaction. Everything here is pure data plus a seeded generator, so the tests can replay it.

export type Phase = 'explore' | 'fight' | 'dead'

export type RunSummary = { run: number; lv: number; floor: number; kills: number; steps: number; killedBy: string; at: number }

// besides the log (text, for people) each tick leaves typed events, for the board's animation
export type GameEvent =
  | { type: 'step' }
  | { type: 'engage'; kind: number; boss: boolean; lv: number; hp: number; maxHp: number }
  | { type: 'hit'; target: 'foe' | 'hero'; dmg: number; crit: boolean; hpLeft: number }
  | { type: 'miss'; target: 'foe' | 'hero' }
  | { type: 'kill'; kind: number; xp: number; gold: number }
  | { type: 'levelup'; lv: number; hp: number }
  | { type: 'item'; name: string; rarity: number; better: boolean; replaced: string | null; wizard: boolean }
  | { type: 'chest'; gold: number }
  | { type: 'descend'; floor: number }
  | { type: 'heal'; amount: number }
  | { type: 'die'; by: string }
  | { type: 'respawn'; run: number }
  | { type: 'rebuild' }

export type State = {
  r: Rng
  seed: number
  floorNum: number
  floor: Floor
  explored: Uint8Array
  hero: Hero
  pos: Pos
  enemies: Enemy[]
  path: Pos[]
  tick: number
  phase: Phase
  // ticks spent dead; a new run starts when it runs out
  deadTicks: number
  log: string[]
  // lines added since the board last posted them to the hooks module
  fresh: string[]
  events: GameEvent[]
  lastRun: RunSummary | null
  now: number
  // the enemy Kaneed is trading blows with, for the status line
  foe: Enemy | null
}

export const LOG_MAX = 120
export const DEAD_TICKS = 8
export const HEAL_ON_TEST = 0.35

const emit = (s: State, e: GameEvent) => s.events.push(e)
const log = (s: State, line: string) => {
  s.log.push(line)
  s.fresh.push(line)
  if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX)
}

export function newFloor(s: State, floorNum: number, why?: string) {
  s.floorNum = floorNum
  s.hero = { ...s.hero, floor: floorNum }
  s.floor = generateFloor(s.r)
  s.explored = new Uint8Array(s.floor.w * s.floor.h)
  s.pos = { ...s.floor.entrance }
  s.enemies = spawnEnemies(s.r, s.floor, s.hero.lv, floorNum)
  s.path = []
  s.foe = null
  s.phase = 'explore'
  reveal(s.floor, s.explored, s.pos)
  log(s, why ?? `B${floorNum}F に到着した。敵が ${s.enemies.length} 体うろついている`)
}

// a fresh state: `saved` carries a hero over from the store, else a new one at level 1
export function startRun(seed: number, run: number, now: number, saved?: Hero | null, floorNum = 1, history: string[] = []): State {
  const hero = saved ?? newHero(run, now)
  const s: State = {
    r: rng(seed ^ (run * 2654435761)),
    seed,
    floorNum,
    floor: generateFloor(rng(1)),
    explored: new Uint8Array(0),
    hero,
    pos: { x: 0, y: 0 },
    enemies: [],
    path: [],
    tick: 0,
    phase: 'explore',
    deadTicks: 0,
    log: history.slice(-LOG_MAX),
    fresh: [],
    events: [],
    lastRun: null,
    now,
    foe: null,
  }
  newFloor(s, floorNum, saved ? `カニード は B${floorNum}F の探索を再開した（Lv ${hero.lv}）` : `カニード の冒険 #${run} が始まった。回復は Lv アップ（半分）とテスト成功（1/3）だけ`)
  return s
}

// after a compaction: the same Kaneed, a floor laid out anew
export function rebuildFloor(s: State, seed: number) {
  s.seed = seed
  s.r = rng(seed ^ (s.hero.run * 2654435761) ^ s.tick)
  if (s.phase === 'dead') return
  newFloor(s, s.floorNum, `コンテキスト圧縮の余波で B${s.floorNum}F の壁が組み替わった`)
  emit(s, { type: 'rebuild' })
}

export function testPassed(s: State) {
  if (s.phase === 'dead') return
  const { hero, healed } = heal(s.hero, HEAL_ON_TEST)
  s.hero = hero
  log(s, healed > 0 ? `テスト成功！カニード は ${healed} 回復した（HP ${hero.hp}/${stats(hero).maxHp}）` : 'テスト成功！カニード は元気いっぱいだ')
  emit(s, { type: 'heal', amount: healed })
}

export function testFailed(s: State) {
  if (s.phase === 'dead') return
  log(s, 'テスト失敗… カニード は不安そうにあたりを見回した')
}

const enemyAt = (s: State, p: Pos) => s.enemies.find(e => e.x === p.x && e.y === p.y)
const adjacentEnemies = (s: State) => s.enemies.filter(e => manhattan(e, s.pos) === 1)

function die(s: State, by: Enemy) {
  s.phase = 'dead'
  s.deadTicks = 0
  s.foe = null
  s.hero = { ...s.hero, hp: 0 }
  s.lastRun = { run: s.hero.run, lv: s.hero.lv, floor: s.floorNum, kills: s.hero.kills, steps: s.hero.steps, killedBy: KINDS[by.kind].name, at: s.now }
  log(s, `カニード は ${KINDS[by.kind].name} に倒された… Lv ${s.hero.lv}、B${s.floorNum}F、${s.hero.kills} 体討伐。冒険 #${s.hero.run} 終了`)
  emit(s, { type: 'die', by: KINDS[by.kind].name })
}

// whatever Kaneed finds, it wears at once: a worse copy replaces a better one just the same
function pickUp(s: State, power: number, from: string) {
  const item = rollItem(s.r, power)
  const { hero, replaced, better } = equip(s.hero, item)
  s.hero = hero
  const name = `${itemName(item)}［${rarityName(item)}］${isWizardItem(item) ? '✦' : ''}`
  if (!replaced) log(s, `${from}${name} を手に入れて身につけた`)
  else if (better) log(s, `${from}${name} を手に入れ、${itemName(replaced)} から持ち替えた（強化）`)
  else log(s, `${from}${name} を手に入れ、${itemName(replaced)} から持ち替えてしまった（弱体化！）`)
  emit(s, { type: 'item', name: itemName(item), rarity: item.rarity, better, replaced: replaced ? itemName(replaced) : null, wizard: isWizardItem(item) })
}

function fight(s: State, foes: Enemy[]) {
  s.phase = 'fight'
  const st = stats(s.hero)
  const target = s.foe && foes.includes(s.foe) ? s.foe : foes[0]
  if (target !== s.foe) {
    log(s, `${KINDS[target.kind].name}${target.boss ? '（ボス）' : ''} Lv ${target.lv} と戦闘開始！`)
    emit(s, { type: 'engage', kind: target.kind, boss: target.boss, lv: target.lv, hp: target.hp, maxHp: target.maxHp })
  }
  s.foe = target
  // Kaneed strikes
  const crit = s.r.chance(st.crit / 100)
  const dmg = Math.max(1, Math.round((st.atk - target.def + s.r.range(-1, 2)) * (crit ? 2 : 1)))
  target.hp -= dmg
  emit(s, { type: 'hit', target: 'foe', dmg, crit, hpLeft: Math.max(0, target.hp) })
  if (crit) log(s, `会心の一撃！${KINDS[target.kind].name} に ${dmg} ダメージ`)
  if (target.hp <= 0) {
    s.enemies = s.enemies.filter(e => e !== target)
    s.foe = null
    const { hero, levels } = gainXp({ ...s.hero, kills: s.hero.kills + 1, gold: s.hero.gold + target.gold }, target.xp)
    s.hero = hero
    log(s, `${KINDS[target.kind].name} を倒した（+${target.xp} XP、+${target.gold} G）`)
    emit(s, { type: 'kill', kind: target.kind, xp: target.xp, gold: target.gold })
    if (levels > 0) {
      log(s, `レベルアップ！カニード は Lv ${hero.lv} になり、HP が半分回復した（${hero.hp}/${stats(hero).maxHp}）`)
      emit(s, { type: 'levelup', lv: hero.lv, hp: hero.hp })
    }
    if (s.r.chance(target.boss ? 1 : 0.25)) pickUp(s, s.hero.lv + s.floorNum, `${KINDS[target.kind].name} が落とした `)
  }
  // every neighbour strikes back
  for (const e of foes) {
    if (e.hp <= 0) continue
    if (s.r.chance(st.evade / 100)) {
      emit(s, { type: 'miss', target: 'hero' })
      continue
    }
    const hit = Math.max(1, Math.round(e.atk - st.def + s.r.range(-1, 2)))
    s.hero = damage(s.hero, hit)
    emit(s, { type: 'hit', target: 'hero', dmg: hit, crit: false, hpLeft: s.hero.hp })
    if (s.hero.hp <= 0) {
      die(s, e)
      return
    }
  }
  if (s.hero.hp <= stats(s.hero).maxHp * 0.25 && s.tick % 6 === 0) log(s, `HP が危ない（${s.hero.hp}/${stats(s.hero).maxHp}）。テストを通せば回復できる`)
}

function chooseTarget(s: State): Pos[] | null {
  const blocked = (x: number, y: number) => !!enemyAt(s, { x, y })
  // the nearest frontier, most of the time; sometimes a farther one, so the route wanders
  const path = bfs(s.floor, s.pos, (x, y) => isFrontier(s.floor, s.explored, x, y) && !(x === s.pos.x && y === s.pos.y), blocked)
  if (path) {
    if (path.length > 1 && s.r.chance(0.3)) return path.slice(0, Math.max(1, s.r.range(1, path.length)))
    return path
  }
  // nothing left to see: the stairs
  return bfs(s.floor, s.pos, (x, y) => tileAt(s.floor, x, y) === T.STAIRS, blocked)
}

function move(s: State) {
  s.phase = 'explore'
  s.foe = null
  if (s.path.length === 0) {
    const path = chooseTarget(s)
    if (!path) {
      // boxed in: shuffle to any free neighbour
      const free = neighbours(s.pos).filter(p => passable(s.floor, p.x, p.y) && !enemyAt(s, p))
      if (free.length) s.path = [s.r.pick(free)]
      else return
    } else s.path = path
  }
  const next = s.path[0]
  if (enemyAt(s, next)) {
    // someone stepped into the way: fight it next tick, plan again after
    s.path = []
    return
  }
  s.path.shift()
  s.pos = next
  s.hero = { ...s.hero, steps: s.hero.steps + 1 }
  emit(s, { type: 'step' })
  reveal(s.floor, s.explored, s.pos)
  const tile = tileAt(s.floor, s.pos.x, s.pos.y)
  if (tile === T.CHEST) {
    s.floor.tiles[idx(s.floor, s.pos.x, s.pos.y)] = T.FLOOR
    const gold = s.r.range(5, 10 + 5 * s.floorNum)
    s.hero = { ...s.hero, gold: s.hero.gold + gold }
    log(s, `宝箱を開けた！${gold} G`)
    emit(s, { type: 'chest', gold })
    pickUp(s, s.hero.lv + s.floorNum + 1, '宝箱から ')
    s.path = []
  } else if (tile === T.STAIRS && !hasFrontier(s)) {
    emit(s, { type: 'descend', floor: s.floorNum + 1 })
    newFloor(s, s.floorNum + 1)
  }
}

function hasFrontier(s: State) {
  for (let y = 0; y < s.floor.h; y++) for (let x = 0; x < s.floor.w; x++) if (isFrontier(s.floor, s.explored, x, y)) return true
  return false
}

function moveEnemies(s: State) {
  const occupied = new Set(s.enemies.map(e => `${e.x},${e.y}`))
  for (const e of s.enemies) {
    if (manhattan(e, s.pos) <= 1) continue
    const k = KINDS[e.kind]
    if (!s.r.chance(k.speed)) continue
    const near = chebyshev(e, s.pos) <= 5 && s.explored[idx(s.floor, e.x, e.y)]
    let options = neighbours(e).filter(p => passable(s.floor, p.x, p.y) && !occupied.has(`${p.x},${p.y}`) && !same(p, s.pos))
    if (!options.length) continue
    if (near) {
      const best = Math.min(...options.map(p => manhattan(p, s.pos)))
      options = options.filter(p => manhattan(p, s.pos) === best)
    } else if (!s.r.chance(0.35)) continue
    const to = s.r.pick(options)
    occupied.delete(`${e.x},${e.y}`)
    e.x = to.x
    e.y = to.y
    occupied.add(`${e.x},${e.y}`)
  }
}

export function step(s: State, now = s.now + 500): State {
  s.now = now
  s.tick++
  if (s.phase === 'dead') {
    s.deadTicks++
    if (s.deadTicks >= DEAD_TICKS) {
      const run = s.hero.run + 1
      s.hero = newHero(run, now)
      s.r = rng(s.seed ^ (run * 2654435761))
      s.deadTicks = 0
      log(s, `カニード は目を覚ました。冒険 #${run}、Lv 1 からやり直しだ`)
      emit(s, { type: 'respawn', run })
      newFloor(s, 1)
    }
    return s
  }
  const foes = adjacentEnemies(s)
  if (foes.length) fight(s, foes)
  else move(s)
  // fight() may have set the phase; the narrowing above does not see that
  if ((s.phase as Phase) !== 'dead') moveEnemies(s)
  return s
}

// the lines the board has not yet handed to the hooks module; calling this empties the tray
export function takeFresh(s: State): string[] {
  const out = s.fresh
  s.fresh = []
  return out
}

// the events since the last call, for the board's animation; calling this empties the tray
export function takeEvents(s: State): GameEvent[] {
  const out = s.events
  s.events = []
  return out
}
