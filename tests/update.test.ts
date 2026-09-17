import { describe, expect, test } from 'bun:test'
import { isNewer, parseVersion, versionIn } from '../hooks/game/update.ts'

describe('update notice', () => {
  test('a newer release is newer, an older or equal one is not', () => {
    expect(isNewer('0.3.0', '0.2.0')).toBe(true)
    expect(isNewer('1.0.0', '0.9.9')).toBe(true)
    expect(isNewer('0.2.1', '0.2.0')).toBe(true)
    expect(isNewer('0.2.0', '0.2.0')).toBe(false)
    expect(isNewer('0.1.9', '0.2.0')).toBe(false)
  })

  test('anything that does not parse is no news', () => {
    expect(parseVersion('0.2')).toBeNull()
    expect(parseVersion('v0.2.0')).toBeNull()
    expect(isNewer(undefined, '0.2.0')).toBe(false)
    expect(isNewer('<html>404</html>', '0.2.0')).toBe(false)
    expect(isNewer('0.3.0', 'unknown')).toBe(false)
  })

  test('the version is read out of a manifest, and a broken one answers nothing', () => {
    expect(versionIn('{"name":"kaneed-dungeon","version":"0.4.2"}')).toBe('0.4.2')
    expect(versionIn('{"name":"kaneed-dungeon"}')).toBeNull()
    expect(versionIn('not json')).toBeNull()
  })
})
