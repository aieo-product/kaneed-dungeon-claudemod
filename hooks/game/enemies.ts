import type { Rng } from './rng.ts'
import { center, same, T, tileAt, type Floor, type Pos } from './map.ts'

// The things that live on a floor. Their level follows Kaneed's at generation, so a stronger Kaneed
// meets stronger monsters and the fights stay close; deeper floors and later kinds tilt it further.

// the glyph is one full-width character: two cells, one map tile
export type EnemyKind = { name: string; glyph: string; color: string; hpMul: number; atkMul: number; speed: number }

export const KINDS: readonly EnemyKind[] = [
  { name: 'スライム', glyph: '泡', color: 'green', hpMul: 1.0, atkMul: 0.8, speed: 0.4 },
  { name: 'コウモリ', glyph: '蝠', color: 'gray', hpMul: 0.6, atkMul: 0.9, speed: 0.9 },
  { name: 'ゴブリン', glyph: '鬼', color: 'yellow', hpMul: 1.0, atkMul: 1.0, speed: 0.6 },
  { name: 'スケルトン', glyph: '骨', color: 'white', hpMul: 1.2, atkMul: 1.1, speed: 0.5 },
  { name: 'オーク', glyph: '牙', color: 'red', hpMul: 1.5, atkMul: 1.2, speed: 0.5 },
  { name: 'ゴースト', glyph: '霊', color: 'cyan', hpMul: 0.8, atkMul: 1.4, speed: 0.7 },
  { name: 'ミノタウロス', glyph: '牛', color: 'magenta', hpMul: 1.9, atkMul: 1.4, speed: 0.6 },
  { name: 'ドラゴン', glyph: '龍', color: 'redBright', hpMul: 2.6, atkMul: 1.8, speed: 0.5 },
]

export type Enemy = {
  id: number
  kind: number
  x: number
  y: number
  lv: number
  hp: number
  maxHp: number
  atk: number
  def: number
  xp: number
  gold: number
  boss: boolean
}

// the kinds a floor may hold: two at the start, one more every four points of power
export const kindsAvailable = (power: number) => Math.min(KINDS.length, 2 + Math.floor(power / 4))

export function makeEnemy(r: Rng, id: number, kind: number, lv: number, at: Pos, boss = false): Enemy {
  const k = KINDS[kind]
  // twice the hit points and half the bite of a one-exchange monster: a fight lasts a few seconds
  const hp = Math.round((20 + 10 * lv) * k.hpMul * (boss ? 1.6 : 1))
  return {
    id,
    kind,
    x: at.x,
    y: at.y,
    lv,
    hp,
    maxHp: hp,
    atk: Math.round((4 + 1.05 * lv) * k.atkMul * (boss ? 1.2 : 1) * 10) / 10,
    def: Math.round((1 + 0.6 * lv) * 10) / 10,
    xp: Math.round((8 + 5 * lv) * (boss ? 3 : 1)),
    gold: r.range(2, 4 + lv) * (boss ? 4 : 1),
    boss,
  }
}

// the enemy level sits around the hero's, from one under to one over, and climbs one for every
// two floors; the boss (one more) is the fight that costs the most
export function spawnEnemies(r: Rng, floor: Floor, heroLv: number, floorNum: number): Enemy[] {
  const power = heroLv + floorNum
  const available = kindsAvailable(power)
  const enemies: Enemy[] = []
  const taken = new Set<string>()
  const free = (p: Pos) => tileAt(floor, p.x, p.y) === T.FLOOR && !taken.has(`${p.x},${p.y}`) && !same(p, floor.entrance)
  const level = () => Math.max(1, heroLv - 1 + Math.floor((floorNum - 1) / 2) + r.range(0, 2))
  let id = 1
  for (let i = 1; i < floor.rooms.length; i++) {
    const room = floor.rooms[i]
    const count = r.range(1, 2)
    for (let n = 0; n < count; n++) {
      for (let tries = 0; tries < 20; tries++) {
        const p = { x: r.range(room.x, room.x + room.w - 1), y: r.range(room.y, room.y + room.h - 1) }
        if (!free(p)) continue
        taken.add(`${p.x},${p.y}`)
        // later kinds are rarer: pick twice, keep the lower index most of the time
        const a = r.int(available)
        const b = r.int(available)
        const kind = r.chance(0.7) ? Math.min(a, b) : Math.max(a, b)
        enemies.push(makeEnemy(r, id++, kind, level(), p))
        break
      }
    }
  }
  // the stairs room keeps a boss: the strongest kind the floor knows, twice the hit points
  const last = floor.rooms[floor.rooms.length - 1]
  if (floor.rooms.length > 1) {
    const c = center(last)
    const spots = [{ x: c.x + 1, y: c.y }, { x: c.x - 1, y: c.y }, { x: c.x, y: c.y + 1 }, { x: c.x, y: c.y - 1 }].filter(free)
    if (spots.length) enemies.push(makeEnemy(r, id++, available - 1, level() + 1, r.pick(spots), true))
  }
  return enemies
}
