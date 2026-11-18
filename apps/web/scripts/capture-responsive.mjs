import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Spec T4 verify: "visual captures at 320/375/768/1280/1440; no horizontal overflow".
 * Runs Vite dev server with a local, clearly-labelled fake host/session fixture (not included in
 * production build), captures the actual Workbench components at 5 widths, and asserts that the
 * document never scrolls horizontally. These are visual fixtures, not live-host UAT evidence.
 */

const ROOT = resolve(import.meta.dirname, '../../..')
const OUT = resolve(ROOT, 'plans/ui-visual-exploration/lix-web/captures-t4')
const PORT = 5199

const WIDTHS = [320, 375, 768, 1280, 1440]

async function waitForServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`preview server never came up at ${url}`)
}

const preview = spawn('node', [resolve(ROOT, 'node_modules/vite/bin/vite.js'), 'apps/web', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: 'ignore',
})

try {
  mkdirSync(OUT, { recursive: true })
  await waitForServer(`http://127.0.0.1:${PORT}/dev/workbench-preview.html`)

  const browser = await chromium.launch()
  const overflows = []

  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 800 } })
    await page.goto(`http://127.0.0.1:${PORT}/dev/workbench-preview.html`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(300)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    await page.screenshot({ path: resolve(OUT, `workbench-${width}.png`), fullPage: true })
    if (overflow > 0) overflows.push({ width, overflow })
    console.log(`width ${width}: overflow=${overflow}px ${overflow > 0 ? 'FAIL' : 'OK'}`)
    await page.close()
  }

  await browser.close()
  if (overflows.length > 0) {
    console.error('HORIZONTAL OVERFLOW AT:', JSON.stringify(overflows))
    process.exitCode = 1
  } else {
    console.log(`PASS — captures in ${OUT}`)
  }
} finally {
  preview.kill('SIGTERM')
}
