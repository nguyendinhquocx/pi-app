import { resolve } from 'path'
import { readdirSync, existsSync } from 'node:fs'
import { build as esbuildBuild } from 'esbuild'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Li Web PWA build (spec T3). Standalone static bundle under apps/web/dist:
 * - aliases `@shared` to the shared remote protocol package (typed contract, Pi Android-owned);
 * - dev server widens connect-src for HMR (localhost only) — the production CSP stays exact;
 * - after the bundle build, compiles src/sw.ts to dist/sw.js with the precache manifest inlined
 *   as `__PRECACHE__` (esbuild comes with Vite). The SW is precache-only (spec T3) and its
 *   fetch handler bypasses every `.ts.net` URL and non-GET request.
 */

const PROD_CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self' wss://*.ts.net; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'"

const DEV_CSP = PROD_CSP.replace(
  "connect-src 'self' wss://*.ts.net",
  "connect-src 'self' wss://*.ts.net ws://localhost:* ws://127.0.0.1:*",
)

function serviceWorkerPlugin(): Plugin {
  return {
    name: 'lix-web-sw',
    apply: 'build',
    closeBundle() {
      const root = import.meta.dirname
      if (!root) throw new Error('lix-web-sw: import.meta.dirname unavailable')
      const distDir = resolve(root, 'dist')
      const files: string[] = []
      const walk = (dir: string, prefix = ''): void => {
        if (!existsSync(dir)) return
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name
          if (entry.isDirectory()) walk(resolve(dir, entry.name), rel)
          else files.push(`/${rel}`)
        }
      }
      walk(distDir)
      const precache = files.filter((f) => !f.startsWith('/sw.js') && !f.endsWith('_headers'))
      void esbuildBuild({
        entryPoints: [resolve(root, 'src/sw.ts')],
        outfile: resolve(distDir, 'sw.js'),
        bundle: true,
        format: 'esm',
        target: 'es2022',
        define: { __PRECACHE__: JSON.stringify(precache) },
        logLevel: 'silent',
      })
      console.log(`[lix-web-sw] precache manifest: ${precache.length} files`)
    },
  }
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    react(),
    {
      name: 'lix-web-dev-csp',
      apply: 'serve',
      transformIndexHtml(html) {
        return html.replace(PROD_CSP, DEV_CSP)
      },
    },
    serviceWorkerPlugin(),
  ],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../../packages/shared'),
      '@web': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5183,
    strictPort: true,
  },
})
