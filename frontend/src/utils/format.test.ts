import { describe, expect, it } from 'vitest'
import { formatAge, formatDistance, formatDuration, formatKm, msToKmh } from './format'

describe('format', () => {
  it('formats ages', () => {
    expect(formatAge(0)).toBe('0 s ago')
    expect(formatAge(5.4)).toBe('5 s ago')
    expect(formatAge(59)).toBe('59 s ago')
    expect(formatAge(60)).toBe('1 min ago')
    expect(formatAge(125)).toBe('2 min ago')
    expect(formatAge(3900)).toBe('1 h 5 min ago')
    expect(formatAge(-3)).toBe('0 s ago')
  })
  it('formats distances and speeds', () => {
    expect(formatDistance(228.4)).toBe('228 m')
    expect(formatDistance(1234)).toBe('1.2 km')
    expect(msToKmh(10)).toBe(36)
  })
  it('formats durations and kilometres', () => {
    expect(formatDuration(45)).toBe('45 s')
    expect(formatDuration(125)).toBe('2 min')
    expect(formatDuration(3900)).toBe('1 h 5 min')
    expect(formatKm(3635.2)).toBe('3.6 km')
  })
})
