// Points vercel.json at your backend:   node scripts/configure-vercel.mjs https://campus-bus-api.onrender.com
// (vercel.json cannot read environment variables, so the address is written into the file.)
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const PLACEHOLDER = 'YOUR-BACKEND.onrender.com'

export function applyBackendUrl(text, backendUrl) {
  let host
  try { host = new URL(backendUrl).host } catch { throw new Error(`"${backendUrl}" is not a web address. Use something like https://campus-bus-api.onrender.com`) }
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) throw new Error(`Unexpected host "${host}"`)
  const current = text.match(/https:\/\/([a-z0-9.-]+)\/:path\*/i)?.[1]
  if (!current) throw new Error('vercel.json has no /api rewrite to update')
  return text.split(current).join(host) // placeholder on the first run, the previous address on later ones
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.argv[2]
  if (!url) { console.error('Usage: node scripts/configure-vercel.mjs https://<your-backend>.onrender.com'); process.exit(1) }
  const file = new URL('../vercel.json', import.meta.url)
  try {
    const out = applyBackendUrl(fs.readFileSync(file, 'utf8'), url)
    JSON.parse(out) // refuse to write a broken file
    fs.writeFileSync(file, out)
    console.log(`vercel.json now points at ${new URL(url).host}`)
  } catch (e) { console.error(e.message); process.exit(1) }
}
