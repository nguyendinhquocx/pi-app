import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Local-only visual QA for the real React Workbench composition. Vite serves the synthetic
 * fixture from src/dev; captures are evidence for layout only, never live-host UAT evidence.
 * The fixture banner and fake hosts/sessions stay out of the production build.
 */

const ROOT = resolve(import.meta.dirname, '../../..')
const OUT = resolve(import.meta.dirname, '../dev/captures-workbench-demo-integration')
const PORT = 5199
const WIDTHS = [320, 375, 414, 768, 769, 999, 1000, 1024, 1025, 1280, 1440]
const INSPECTOR_WIDTHS = [320, 375, 414, 768, 769, 999, 1000, 1024, 1025, 1280]

async function waitForServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* Vite is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`preview server never came up at ${url}`)
}

async function openWorkbenchSession(page, width) {
  await page.goto(`http://127.0.0.1:${PORT}/dev/workbench-preview.html`, { waitUntil: 'networkidle' })
  if (width <= 768) await page.getByRole('button', { name: 'Mở danh sách phiên' }).click()
  const selectedSession = page.locator('.session-row[aria-current="true"]')
  await selectedSession.waitFor({ state: 'visible' })
  await selectedSession.click()
  await page.locator('.model-trigger').waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelector('.model-trigger')?.textContent?.includes('GLM 5.3 Flash'), undefined, { timeout: 10_000 })
}

async function openInspector(page) {
  await page.getByRole('button', { name: 'Mở Inspector' }).click()
  await page.locator('#workbench-inspector').waitFor({ state: 'visible' })
  await page.locator('.terminal-host[data-status="open"]').waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelector('.terminal-host .xterm-rows')?.textContent?.includes('Local fixture'), undefined, { timeout: 5000 })
}

async function capture(page, name, overflows) {
  const measurements = await page.evaluate(() => {
    const selectors = ['html', 'body', '#root', '.li-web-root', '.workbench-main', '.session-rail.mobile-visible', '.workbench-center', '.timeline', '.composer', '#workbench-inspector', '.host-menu', '.host-dialog']
    return selectors.flatMap((selector) => {
      const element = document.querySelector(selector)
      if (!element || element.clientWidth === 0) return []
      const overflow = Math.max(0, element.scrollWidth - element.clientWidth)
      return overflow > 0 ? [{ selector, overflow }] : []
    })
  })
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true })
  for (const item of measurements) overflows.push({ name, ...item })
  const maxOverflow = Math.max(0, ...measurements.map((item) => item.overflow))
  console.log(`${name}: internal horizontal overflow=${maxOverflow}px ${maxOverflow > 0 ? `FAIL ${JSON.stringify(measurements)}` : 'OK'}`)
}

const preview = spawn('node', [resolve(ROOT, 'node_modules/vite/bin/vite.js'), 'apps/web', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: 'ignore',
})
let browser

try {
  mkdirSync(OUT, { recursive: true })
  await waitForServer(`http://127.0.0.1:${PORT}/dev/workbench-preview.html`)
  browser = await chromium.launch()
  const overflows = []

  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: width <= 768, isMobile: width <= 768 })
    await openWorkbenchSession(page, width)
    await capture(page, `workbench-${width}`, overflows)

    if (width <= 768) {
      await page.getByRole('button', { name: 'Mở danh sách phiên' }).click()
      await page.locator('.session-rail.mobile-visible').waitFor({ state: 'visible' })
      await capture(page, `session-drawer-${width}`, overflows)
      await page.keyboard.press('Escape')
    }

    if ([375, 1280].includes(width)) {
      if (width === 375) await page.getByRole('button', { name: 'Mở danh sách phiên' }).click()
      await page.locator('.host-trigger').click()
      await page.getByRole('menu', { name: 'Hosts đã ghép' }).waitFor({ state: 'visible' })
      await capture(page, `host-picker-${width}`, overflows)
      await page.locator('.host-trigger').click()
      if (width === 375) await page.keyboard.press('Escape')
    }

    if (width === 1024) {
      await page.getByRole('button', { name: 'Thu gọn danh sách phiên' }).click()
      await capture(page, 'layout-1024-rail-closed', overflows)
      await openInspector(page)
      await capture(page, 'layout-1024-rail-closed-inspector', overflows)
      await page.getByRole('button', { name: 'Đóng Inspector' }).click()
      await page.getByRole('button', { name: 'Mở danh sách phiên' }).click()
    }

    if (INSPECTOR_WIDTHS.includes(width)) {
      await openInspector(page)
      await capture(page, `inspector-${width}`, overflows)
      if (width === 1280) {
        await page.getByRole('button', { name: 'Xuất phiên' }).click()
        await page.getByRole('menu', { name: 'Xuất phiên' }).waitFor({ state: 'visible' })
        await capture(page, 'inspector-export-menu-1280', overflows)
        await page.keyboard.press('Escape')
        const userMessage = page.locator('.turn-user').last()
        await userMessage.hover()
        await page.waitForTimeout(200)
        const userCopyState = await page.locator('.turn-user-actions').last().evaluate((el) => getComputedStyle(el).opacity)
        if (userCopyState !== '1') throw new Error('user copy action did not reveal on hover')
        await capture(page, 'copy-user-hover-1280', overflows)
        const assistantAnswer = page.locator('.turn-answer').last()
        await assistantAnswer.hover()
        await page.waitForTimeout(200)
        const answerCopyState = await assistantAnswer.locator('.turn-answer-actions').evaluate((el) => getComputedStyle(el).opacity)
        if (answerCopyState !== '1') throw new Error('assistant copy action did not reveal on hover')
        await capture(page, 'copy-answer-hover-1280', overflows)
        const toolRow = page.locator('.tool-head').last()
        await toolRow.hover()
        const toolBackground = await toolRow.evaluate((el) => getComputedStyle(el).backgroundColor)
        if (toolBackground !== 'rgba(0, 0, 0, 0)') throw new Error(`tool row hover surface was not suppressed: ${toolBackground}`)
        await capture(page, 'tool-row-hover-1280', overflows)
        const failedToolRow = page.locator('.tool-head').filter({ hasText: 'run fixture-check-93' }).first()
        await failedToolRow.scrollIntoViewIfNeeded()
        await capture(page, 'tool-failure-collapsed-1280', overflows)
      }
    }
    await page.close()
  }

  const pickerPage = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await openWorkbenchSession(pickerPage, 1280)
  await pickerPage.locator('.model-trigger').click()
  const modelSearch = pickerPage.getByLabel('Tìm model')
  await modelSearch.press('ArrowDown')
  const modelSearchBorder = await modelSearch.evaluate((el) => getComputedStyle(el).borderTopWidth)
  if (modelSearchBorder !== '0px') throw new Error(`model search still has a border: ${modelSearchBorder}`)
  await pickerPage.getByRole('listbox', { name: 'Models' }).waitFor({ state: 'visible' })
  await capture(pickerPage, 'model-picker-keyboard', overflows)
  await pickerPage.keyboard.press('Escape')
  await pickerPage.locator('.thinking-trigger').click()
  await pickerPage.getByRole('menu', { name: 'Mức thinking' }).waitFor({ state: 'visible' })
  await capture(pickerPage, 'thinking-picker', overflows)
  await pickerPage.close()

  for (const width of [1280, 375]) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: width === 375, isMobile: width === 375 })
    await page.goto(`http://127.0.0.1:${PORT}/dev/host-manager-preview.html`, { waitUntil: 'networkidle' })
    await page.getByRole('tab', { name: 'Đã ghép nối' }).waitFor({ state: 'visible' })
    await capture(page, `host-dialog-${width}`, overflows)
    await page.getByRole('tab', { name: 'Ghép nối mới' }).click()
    await capture(page, `host-pair-${width}`, overflows)
    await page.close()
  }

  if (overflows.length > 0) {
    console.error('HORIZONTAL OVERFLOW AT:', JSON.stringify(overflows))
    process.exitCode = 1
  } else {
    console.log(`PASS — local captures in ${OUT}`)
  }
} finally {
  await browser?.close()
  preview.kill('SIGTERM')
}
