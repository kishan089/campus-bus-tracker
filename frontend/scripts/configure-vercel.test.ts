import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS helper shared with the command-line script
import { applyBackendUrl } from './configure-vercel.mjs'

const original = fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')

describe('configure-vercel', () => {
  it('replaces the placeholder in the rewrite and the content security policy, leaving valid JSON', () => {
    const out = applyBackendUrl(original, 'https://campus-bus-api.onrender.com/')
    expect(out).not.toContain('YOUR-BACKEND')
    const cfg = JSON.parse(out)
    expect(cfg.rewrites[0].destination).toBe('https://campus-bus-api.onrender.com/:path*')
    const csp = cfg.headers[0].headers.find((h: any) => h.key === 'Content-Security-Policy').value
    expect(csp).toContain('connect-src \'self\' https://campus-bus-api.onrender.com wss://campus-bus-api.onrender.com')
  })

  it('can be run again to change the address', () => {
    const once = applyBackendUrl(original, 'https://one.onrender.com')
    const twice = applyBackendUrl(once, 'https://two.onrender.com')
    expect(twice).not.toContain('one.onrender.com')
    expect(JSON.parse(twice).rewrites[0].destination).toBe('https://two.onrender.com/:path*')
  })

  it('refuses things that are not web addresses', () => {
    expect(() => applyBackendUrl(original, 'campus-bus-api')).toThrow(/not a web address/)
  })

  it('keeps the single-page-app fallback away from /api and the map tiles allowed', () => {
    const cfg = JSON.parse(original)
    expect(cfg.rewrites[1].source).toBe('/((?!api/).*)')
    const csp = cfg.headers[0].headers.find((h: any) => h.key === 'Content-Security-Policy').value
    expect(csp).toContain('https://tile.openstreetmap.org')
    expect(csp).toContain("frame-ancestors 'none'")
  })
})
