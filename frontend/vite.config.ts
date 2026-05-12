import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file from the root directory
  const env = loadEnv(mode, '../', '');
  const backendPort = env.BACKEND_PORT || 3010;

  return {
    plugins: [react()],
    build: {
      outDir: '../public',
      emptyOutDir: true, // will delete the contents of ../public before building
    },
    server: {
      proxy: {
        '/upload': `http://localhost:${backendPort}`, // Proxy API requests to Express server during development
        '/api': `http://localhost:${backendPort}`,
        '/uploads': `http://localhost:${backendPort}`,
        '/upload_segments': `http://localhost:${backendPort}`
      }
    }
  }
})