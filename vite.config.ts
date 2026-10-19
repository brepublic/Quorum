import {existsSync, readFileSync} from 'node:fs'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react-swc'

// Dev-server API proxy target. Defaults to the Compose deployment's Caddy
// (https://localhost) so pnpm start can hot-reload the frontend against the
// running Docker backend without rebuilding the image. The server rejects
// mutating requests whose Origin is not in QUORUM_ALLOWED_ORIGINS, so the
// proxy rewrites Origin to the target origin.
const devApiOrigin = process.env.QUORUM_DEV_API_ORIGIN ?? 'https://localhost'

// Release artifacts are generated before building; local source builds have no installers.
const agentManifestPath = new URL('./public/downloads/chair-agent/manifest.json', import.meta.url)
const agentRelease = existsSync(agentManifestPath) ? JSON.parse(readFileSync(agentManifestPath, 'utf8')) : null
if (process.env.RELEASE_TAG && (!agentRelease || agentRelease.serverVersion !== process.env.RELEASE_TAG
  || agentRelease.commit !== process.env.GITHUB_SHA)) throw new Error('Chair Agent release does not match this build')

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {__CHAIR_AGENT_RELEASE__: JSON.stringify(agentRelease)},
  build: {
    outDir: 'build',
  },
  server: {
    host: '127.0.0.1',
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
