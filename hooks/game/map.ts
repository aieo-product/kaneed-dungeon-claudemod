import type { Rng } from './rng.ts'

// One floor of the dungeon: rooms joined by L-shaped corridors on a grid large enough that a
// session lasting hours does not run out of it, and stairs down for when it does.

export const T = { WALL: 0, FLOOR: 1, STAIRS: 2, CHEST: 3 } as const
export type Tile = (typeof T)[keyof typeof T]
export type Pos = { x: number; y: number }
export type Room = { x: number; y: number; w: number; h: number }
export type Floor = { w: number; h: number; tiles: Uint8Array; rooms: Room[]; entrance: Pos; stairs: Pos }

export const idx = (f: Floor, x: number, y: number) => y * f.w + x
export const inside = (f: Floor, x: number, y: number) => x >= 0 && y >= 0 && x < f.w && y < f.h
export const tileAt = (f: Floor, x: number, y: number): Tile => (inside(f, x, y) ? (f.tiles[idx(f, x, y)] as Tile) : T.WALL)
export const passable = (f: Floor, x: number, y: number) => inside(f, x, y) && f.tiles[idx(f, x, y)] !== T.WALL
export const center = (r: Room): Pos => ({ x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) })
export const same = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y
export const manhattan = (a: Pos, b: Pos) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
export const chebyshev = (a: Pos, b: Pos) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))

const DIRS: readonly Pos[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]

const overlaps = (a: Room, b: Room) => a.x - 1 < b.x + b.w && a.x + a.w + 1 > b.x && a.y - 1 < b.y + b.h && a.y + a.h + 1 > b.y

export type FloorOptions = { w?: number; h?: number; rooms?: number; chests?: number }

export function generateFloor(r: Rng, options: FloorOptions = {}): Floor {
  const w = options.w ?? 90
  const h = options.h ?? 46
  const want = options.rooms ?? 14
  const tiles = new Uint8Array(w * h)
  const rooms: Room[] = []
  for (let tries = 0; tries < 400 && rooms.length < want; tries++) {
    const room: Room = { w: r.range(5, 12), h: r.range(4, 8), x: 0, y: 0 }
    room.x = r.range(1, w - room.w - 2)
    room.y = r.range(1, h - room.h - 2)
    if (rooms.some(other => overlaps(room, other))) continue
    rooms.push(room)
  }
  const f: Floor = { w, h, tiles, rooms, entrance: { x: 0, y: 0 }, stairs: { x: 0, y: 0 } }
  const carve = (x: number, y: number) => {
    if (inside(f, x, y)) tiles[idx(f, x, y)] = T.FLOOR
  }
  for (const room of rooms) for (let y = room.y; y < room.y + room.h; y++) for (let x = room.x; x < room.x + room.w; x++) carve(x, y)
  // each room joins the one before it, so the floor is one connected piece
  for (let i = 1; i < rooms.length; i++) {
    const a = center(rooms[i - 1])
    const b = center(rooms[i])
    const horizontalFirst = r.chance(0.5)
    const corner = horizontalFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y }
    for (const [from, to] of [[a, corner], [corner, b]] as const) {
      const dx = Math.sign(to.x - from.x)
      const dy = Math.sign(to.y - from.y)
      let { x, y } = from
      carve(x, y)
      while (x !== to.x) { x += dx; carve(x, y) }
      while (y !== to.y) { y += dy; carve(x, y) }
    }
  }
  f.entrance = center(rooms[0])
  f.stairs = center(rooms[rooms.length - 1])
  tiles[idx(f, f.stairs.x, f.stairs.y)] = T.STAIRS
  const chests = options.chests ?? 5
  let placed = 0
  for (let tries = 0; tries < 200 && placed < chests && rooms.length > 1; tries++) {
    const room = rooms[r.range(1, rooms.length - 1)]
    const p = { x: r.range(room.x, room.x + room.w - 1), y: r.range(room.y, room.y + room.h - 1) }
    if (tiles[idx(f, p.x, p.y)] !== T.FLOOR || same(p, f.entrance)) continue
    tiles[idx(f, p.x, p.y)] = T.CHEST
    placed++
  }
  return f
}

// breadth-first from `from` to the nearest cell `goal` accepts, around `blocked` cells; the path
// returned starts with the first step and ends on the goal, or is null when nothing is reachable
export function bfs(f: Floor, from: Pos, goal: (x: number, y: number) => boolean, blocked?: (x: number, y: number) => boolean): Pos[] | null {
  const parent = new Int32Array(f.w * f.h).fill(-1)
  const start = idx(f, from.x, from.y)
  parent[start] = start
  const queue = [start]
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]
    const cx = cur % f.w
    const cy = Math.floor(cur / f.w)
    if (cur !== start && goal(cx, cy)) {
      const path: Pos[] = []
      for (let at = cur; at !== start; at = parent[at]) path.push({ x: at % f.w, y: Math.floor(at / f.w) })
      return path.reverse()
    }
    for (const d of DIRS) {
      const nx = cx + d.x
      const ny = cy + d.y
      if (!passable(f, nx, ny)) continue
      const n = idx(f, nx, ny)
      if (parent[n] !== -1) continue
      if (blocked?.(nx, ny) && !goal(nx, ny)) continue
      parent[n] = cur
      queue.push(n)
    }
  }
  return null
}

// what Kaneed can see: a square around it, stopped by nothing (walls show as walls)
export function reveal(f: Floor, explored: Uint8Array, at: Pos, radius = 4) {
  for (let y = at.y - radius; y <= at.y + radius; y++)
    for (let x = at.x - radius; x <= at.x + radius; x++)
      if (inside(f, x, y)) explored[idx(f, x, y)] = 1
}

// a frontier cell is a passable, explored cell with a passable neighbour not yet explored
export function isFrontier(f: Floor, explored: Uint8Array, x: number, y: number) {
  if (!passable(f, x, y) || !explored[idx(f, x, y)]) return false
  return DIRS.some(d => passable(f, x + d.x, y + d.y) && !explored[idx(f, x + d.x, y + d.y)])
}

export const neighbours = (p: Pos): Pos[] => DIRS.map(d => ({ x: p.x + d.x, y: p.y + d.y }))
