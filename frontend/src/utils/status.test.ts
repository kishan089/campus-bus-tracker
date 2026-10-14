import { describe, expect, it } from 'vitest'
import { DEFAULT_THRESHOLDS as T, deriveStatus } from './status'

describe('deriveStatus', () => {
  it('ages a bus that has a fix', () => {
    expect(deriveStatus('LIVE', 14, T)).toBe('LIVE')
    expect(deriveStatus('LIVE', 15, T)).toBe('DELAYED')
    expect(deriveStatus('LIVE', 119, T)).toBe('DELAYED')
    expect(deriveStatus('LIVE', 120, T)).toBe('POSSIBLY_OFFLINE')
    expect(deriveStatus('DELAYED', 600, T)).toBe('OFFLINE')
  })
  it('can also freshen a status (a new fix arrived)', () => expect(deriveStatus('OFFLINE', 2, T)).toBe('LIVE'))
  it('leaves statuses that have no fix alone', () => {
    for (const s of ['NOT_OPERATING', 'LOCATION_UNAVAILABLE', 'DISABLED'] as const) expect(deriveStatus(s, 9999, T)).toBe(s)
  })
})
