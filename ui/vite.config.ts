import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import { pwaShellPlugin } from './pwa/build-shell.mjs'

const repo = fileURLToPath(new URL('../../..', import.meta.url))

export default defineConfig({
  plugins: [react(), pwaShellPlugin()],
  base: '/dsh-bot/',
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
