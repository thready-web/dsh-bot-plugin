import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const presenceIndex = fileURLToPath(new URL('../../../packages/bot-presence/src/index.ts', import.meta.url))
const presenceEngine = fileURLToPath(new URL('../../../packages/bot-presence/src/engine.ts', import.meta.url))

export default defineConfig({
  plugins: [react()],
  base: '/dsh-bot/',
  resolve: {
    alias: [
      { find: /^@tobs\/bot-presence\/engine$/, replacement: presenceEngine },
      { find: /^@tobs\/bot-presence$/, replacement: presenceIndex },
    ],
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    allowedHosts: ['127.0.0.1', 'localhost'],
    fs: {
      allow: [repo],
    },
  },
})
