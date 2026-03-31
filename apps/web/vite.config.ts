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
    port: 17889
  }
})
