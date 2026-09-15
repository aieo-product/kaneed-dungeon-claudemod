// Where an equipment layer sits on the hero. Two ways, in this order:
//
// 1. Anchors. The hero declares five named points (hat, eyes, hand_l, hand_r, feet), a default
//    position for each and per-frame overrides; each equipment layer says which anchor it hangs
//    from and which pixel of its own image is that anchor. The layer is drawn so the two meet.
//    Swap the hero and the same 25 layers land in the right places.
// 2. Legacy offsets. `frames.json` gives (dx, dy) per frame, shared or per slot.
//
// Both tables come from tools/sprites/*.json through make_sprites.py (see sprites.ts).

export type Point = [number, number]
export type HeroAnchors = {
  slots: Record<string, string>
  default: Record<string, Point>
  frames?: Record<string, Record<string, Point>>
}
export type LayerAnchor = { anchor: string; at: Point }
export type LegacyOffset = Point | Record<string, Point>

const isPoint = (v: unknown): v is Point => Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number'

// the hero's anchor point for `slot` on `frame`: the frame's override, else the default
export function heroAnchor(hero: HeroAnchors, frame: string, slot: string): Point | null {
  const name = hero.slots[slot]
  if (!name) return null
  const over = hero.frames?.[frame]?.[name]
  if (isPoint(over)) return over
  const base = hero.default[name]
  return isPoint(base) ? base : null
}

export function layerOffset(
  frame: string,
  slot: string,
  layerKey: string,
  hero: HeroAnchors | null | undefined,
  layers: Record<string, LayerAnchor> | null | undefined,
  legacy: LegacyOffset | undefined,
): Point {
  const la = layers?.[layerKey]
  if (hero && la && isPoint(la.at)) {
    const target = heroAnchor(hero, frame, slot)
    if (target) return [target[0] - la.at[0], target[1] - la.at[1]]
  }
  if (!legacy) return [0, 0]
  if (isPoint(legacy)) return legacy
  const perSlot = legacy[slot]
  return isPoint(perSlot) ? perSlot : [0, 0]
}
