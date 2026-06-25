import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: {
      // Same alias as the Electron renderer uses
      '@': resolve(__dirname, '../../packages/ui/src/renderer_v2')
    }
  },
  css: {
    preprocessorOptions: {
      scss: {
        silenceDeprecations: ['legacy-js-api', 'import'],
        logger: {
          warn(message: string, options: any) {
            if (options?.deprecation) return
            console.warn(message)
          },
          debug() {}
        } as any
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    host: '0.0.0.0',
    port: 17889,
    allowedHosts: ['ai-lab.deeveeyant.com', 'gyshell.deeveeyant.com'],
    proxy: {
      // Proxy all ProxLab API requests through Vite dev server
      // Covers: LLM, embeddings, reranker, vector, TTS, STT, image, services
      // Browser makes same-origin requests — no CORS, no mixed content
      '/proxlab-api': {
        target: 'http://10.0.0.140:7777',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxlab-api/, '/api/proxy'),
        ws: true, // Support WebSocket for streaming
      },
      // Grafana panel embedding (Cluster tab metrics, and any future tab).
      // Grafana serves under /grafana (serve_from_sub_path=true), so we keep the
      // prefix (no rewrite) and inject the service-account token server-side.
      // Rule #1: the token never reaches the browser, and the iframe is same-origin
      // so there are no CORS / X-Frame / mixed-content issues over either the LAN IP
      // or the Cloudflare tunnel. Token + URL come from the ai-lab-web systemd env
      // (GRAFANA_SA_TOKEN / GRAFANA_URL) — never committed to the repo.
      '/grafana': {
        target: process.env.GRAFANA_URL || 'http://10.0.0.105:3000',
        changeOrigin: true,
        headers: process.env.GRAFANA_SA_TOKEN
          ? { Authorization: `Bearer ${process.env.GRAFANA_SA_TOKEN}` }
          : {},
      },
    },
  }
})
