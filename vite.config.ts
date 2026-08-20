import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react-swc'

// Dev-server API proxy target. Defaults to the Compose deployment's Caddy
// (https://localhost) so pnpm start can hot-reload the frontend against the
// running Docker backend without rebuilding the image. The server rejects
// mutating requests whose Origin is not in QUORUM_ALLOWED_ORIGINS, so the
// proxy rewrites Origin to the target origin.
const devApiOrigin = process.env.QUORUM_DEV_API_ORIGIN ?? 'https://localhost'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'build',
  },
  server: {
    proxy: {
      '/api/v1': {
        target: devApiOrigin,
        secure: false,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('origin', devApiOrigin)
          })
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    css: true,
    reporters: ['verbose'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*'],
      exclude: [],
    }
  },
})
