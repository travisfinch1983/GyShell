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
      // Native universal proxy (AI-Lab's own backend on :17890). Lets the browser make same-origin
      // direct HTTP requests for things the WS RPC bridge can't carry: binary audio (TTS/RVC blobs),
      // <audio> element src (workspace playback), SSE streaming (multi-tts/stream), and large uploads.
      // Additive — the WS cluster bridge still handles JSON RPC for every other panel.
      '/api': {
        target: 'http://127.0.0.1:17890',
        changeOrigin: true,
        ws: true,
        // TTS/RVC synth holds the connection many seconds before the (buffered) audio arrives. Disable the
        // dev-proxy's timeouts and keep the upstream socket alive so slow binary responses aren't reset
        // (which surfaces as a Cloudflare 502 through the tunnel chain).
        timeout: 0,
        proxyTimeout: 0,
      },
      // Proxy all ProxLab API requests through Vite dev server
      // Covers: LLM, embeddings, reranker, vector, TTS, STT, image, services
      // Browser makes same-origin requests — no CORS, no mixed content
      // ProxLab is decommissioned — the discovery/TTS/STT/minion layer (ProxlabDiscovery, MinionRouter,
      // TtsPlayback, SttCapture) routes here. Retargeted from 10.0.0.140 to AI-Lab's OWN native proxy
      // (127.0.0.1:17890), which serves the same /api/proxy/* discovery endpoints (services, *_/v1/models).
      '/proxlab-api': {
        target: 'http://127.0.0.1:17890',
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
      // Dynacat dashboard (Home tab) — runs as a sidecar on :8081 in this container.
      // Dynacat serves at root but is configured with base-url=/dash so it emits /dash-prefixed
      // asset + page URLs; we strip the prefix on the way in so it serves them. Same-origin iframe,
      // so its CSP frame-ancestors 'self' covers the embed (no token, no CORS, no mixed content).
      '/dash': {
        target: 'http://127.0.0.1:8081',
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/dash/, '') || '/',
      },
      // FileBrowser Quantum (File Manager tab) — sidecar on :8082 in this container, browsing the mounted
      // NAS pools (/nas). Configured with baseURL=/files so it SERVES under /files (no rewrite — keep the
      // prefix). Same-origin iframe, so X-Frame-Options:SAMEORIGIN (if any) permits it. ws for live updates.
      '/files': {
        target: 'http://127.0.0.1:8082',
        changeOrigin: true,
        ws: true,
      },
    },
  }
})
