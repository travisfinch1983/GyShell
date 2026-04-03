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
    allowedHosts: ['gyshell.deeveeyant.com'],
    proxy: {
      // Proxy ProxLab LLM API requests through Vite dev server
      // MinionRouter rewrites http://10.0.0.140:7777/api/proxy/llm/... to /proxlab-api/llm/...
      // so the browser makes same-origin requests (no CORS, no mixed content)
      '/proxlab-api': {
        target: 'http://10.0.0.140:7777',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxlab-api/, '/api/proxy'),
      },
    },
  }
})
