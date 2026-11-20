import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  base: '/dsh-bot/',
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    allowedHosts: ['127.0.0.1', 'localhost'],
  },
})
