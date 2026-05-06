import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true, // will delete the contents of ../public before building
  },
  server: {
    proxy: {
      '/upload': 'http://localhost:3000', // Proxy API requests to Express server during development
      '/api': 'http://localhost:3000',
      '/uploads': 'http://localhost:3000',
      '/upload_segments': 'http://localhost:3000'
    }
  }
})