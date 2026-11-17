import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Node 25+ ships a global localStorage that shadows jsdom's; switch it off for test workers.
const flags = process.allowedNodeEnvironmentFlags
const webstorageOff = flags.has('--no-webstorage') ? ['--no-webstorage'] : flags.has('--no-experimental-webstorage') ? ['--no-experimental-webstorage'] : []

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    execArgv: webstorageOff,
    setupFiles: ['src/renderer/src/test/setup.ts'],
    include: [
      'src/renderer/src/**/*.test.{ts,tsx}',
      'src/main/**/*.test.ts',
      'src/worker/**/*.test.ts',
      'packages/shared/**/*.test.ts',
      'src/browser-runtime/**/*.test.ts',
      'src/extension-compat/**/*.test.ts',
    ],
    exclude: ['node_modules/**', 'out/**', 'dist/**', 'e2e/**'],
    // The SDK fork's workspace packages (@earendil-works/pi-ai and siblings) live behind
    // node_modules symlinks pointing outside the project (scripts/link-local-sdk.mjs). The
    // default externalize path refuses native imports outside the root, so timeline/preview
    // tests that load the real SDK dist must inline them instead.
    server: {
      deps: {
        inline: [/node_modules[\\/]@earendil-works[\\/]pi-(ai|agent-core|tui|mcp|codemode|telemetry)/],
      },
    },
  },
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('packages/shared'),
      '@extension-compat': resolve('src/extension-compat'),
    },
  },
})
