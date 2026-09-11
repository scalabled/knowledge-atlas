import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiTarget = `http://127.0.0.1:${process.env.XBG_API_PORT ?? 4177}`

// Ask / related research can run Grok for several minutes; default proxy timeouts surface as HTML
// error pages which the UI then fails to parse as JSON ("Unexpected token '<'").
const longApiProxy = {
  target: apiTarget,
  changeOrigin: true,
  timeout: 600_000,
  proxyTimeout: 600_000,
}

export default defineConfig({
  plugins: [react()],
  root: 'src/web',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': longApiProxy,
      '/thumbnails': { target: apiTarget, changeOrigin: true },
    },
  },
})
