import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig } from 'vitest/config'

// ─── Port assignment ──────────────────────────────────────────────────────────
// This project uses ports that do NOT clash with the "keera" project running
// alongside it on the same machine:
//   Frontend  → 5174   (keera uses 5173)
//   Backend   → 3001   (keera uses 3000)
//   Postgres  → 5433   (keera uses 5432)
//   Redis     → 6379   (shared; first-come, first-served)
// strictPort: true makes Vite fail immediately instead of silently drifting to
// yet another port and breaking the CORS allow-list.
// ─────────────────────────────────────────────────────────────────────────────

// /api is proxied to the backend to avoid CORS + mixed-content issues.
// Override the target with API_PROXY_TARGET if your backend runs elsewhere.
const BACKEND = process.env.API_PROXY_TARGET ?? 'http://localhost:3001'

const proxy = {
  '/api': {
    target: BACKEND,
    changeOrigin: true,
    ws: true, // without this the Socket.IO upgrade is dropped and clients stay on long-polling
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
}

// `npm run dev`        -> http://localhost:5174  (geolocation works on localhost)
// `npm run dev:phone`  -> https://<your-LAN-IP>:5174 with a self-signed cert (geolocation needs https off localhost)
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'https' ? [basicSsl()] : [])],
  server: {
    host: true,
    port: 5174,
    strictPort: true, // fail loudly instead of silently drifting to 5175+
    proxy,
    // allowedHosts lets a Cloudflare/ngrok tunnel URL reach the dev server
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.app'],
  },
  preview: { host: true, port: 5174, proxy },
}))
