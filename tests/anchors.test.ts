import { describe, expect, test } from 'bun:test'
import { heroAnchor, layerOffset, type HeroAnchors, type LayerAnchor } from '../hooks/boards/anchors.ts'

const hero: HeroAnchors = {
  slots: { hat: 'hat', eyewear: 'eyes', shield: 'hand_l', sword: 'hand_r', boots: 'feet' },
  default: { hat: [10, 5], eyes: [10, 2], hand_l: [2, 7], hand_r: [22, 7], feet: [10, 12] },
  frames: { idle_1: { hat: [10, 6], eyes: [10, 3] } },
}
const layers: Record<string, LayerAnchor> = {
  equip_hat_1: { anchor: 'hat', at: [10, 5] },
  equip_sword_3: { anchor: 'hand_r', at: [20, 9] },
}

describe('anchors', () => {
  test('a layer meets the hero anchor: zero offset when the layer was drawn in place', () => {
    expect(layerOffset('idle_0', 'hat', 'equip_hat_1', hero, layers, undefined)).toEqual([0, 0])
  })
  test('a frame override moves the layer with the part', () => {
    expect(layerOffset('idle_1', 'hat', 'equip_hat_1', hero, layers, undefined)).toEqual([0, 1])
  })
  test('an anchor without a frame override falls back to the default', () => {
    expect(heroAnchor(hero, 'idle_1', 'sword')).toEqual([22, 7])
    expect(layerOffset('idle_1', 'sword', 'equip_sword_3', hero, layers, undefined)).toEqual([2, -2])
  })
  test('a layer without an anchor entry uses the legacy offset, per slot or shared', () => {
    expect(layerOffset('walk_1', 'boots', 'equip_boots_2', hero, layers, { boots: [0, 1], hat: [0, 0] })).toEqual([0, 1])
    expect(layerOffset('walk_1', 'boots', 'equip_boots_2', hero, layers, [1, 1])).toEqual([1, 1])
    expect(layerOffset('walk_1', 'boots', 'equip_boots_2', hero, layers, undefined)).toEqual([0, 0])
  })
  test('no hero anchors at all: legacy only', () => {
    expect(layerOffset('idle_0', 'hat', 'equip_hat_1', null, layers, { hat: [3, 4] })).toEqual([3, 4])
  })
  test('a hat above the head yields a negative offset, left to the canvas to clip', () => {
    const tall: Record<string, LayerAnchor> = { equip_hat_5: { anchor: 'hat', at: [10, 9] } }
    expect(layerOffset('idle_0', 'hat', 'equip_hat_5', hero, tall, undefined)).toEqual([0, -4])
  })
})
