import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

await fs.mkdir('output/playwright/unified-graph', { recursive: true })
const baseUrl = process.env.XBG_SMOKE_URL ?? `http://127.0.0.1:${process.env.XBG_API_PORT ?? 4177}`
const browser = await chromium.launch({ headless: true })
const errors = []
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 })
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', (error) => errors.push(error.message))

await page.goto(baseUrl, { waitUntil: 'networkidle' })
await page.locator('.graph-canvas canvas').first().waitFor({ state: 'visible' })
await page.locator('.explore-pills .pill').first().waitFor({ state: 'visible' })
assert.equal(await page.locator('.layout-select select').inputValue(), 'unified')
assert.ok(await page.locator('.explore-pills .pill-topic').count() >= 10)

const overlapCount = await page.locator('.explore-pills .pill').evaluateAll((items) => {
  const boxes = items.map((item) => item.getBoundingClientRect())
  let overlaps = 0
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]
    if (!(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)) overlaps++
  }
  return overlaps
})
assert.equal(overlapCount, 0)
await page.screenshot({ path: 'output/playwright/unified-graph/desktop-atlas.png', fullPage: true })

await page.locator('.explore-pills .pill-topic').first().click()
await page.waitForTimeout(500)
assert.ok((await page.locator('.graph-breadcrumbs').textContent())?.includes('Atlas'))
await page.locator('.sort-select select').selectOption('connections')
await page.locator('.layout-select select').selectOption('time')
await page.locator('.dimension-control input').fill('0.9')

const search = page.locator('.search-box input')
await search.fill('graph rendering mathematical algorithms')
await page.waitForTimeout(1200)
assert.ok(await page.locator('.results-list article').count() > 0)
assert.ok((await page.locator('.graph-breadcrumbs').textContent())?.includes('Search'))
await page.screenshot({ path: 'output/playwright/unified-graph/desktop-search-time.png', fullPage: true })

await page.getByRole('button', { name: /Ask library/i }).click()
await page.locator('.ask-panel textarea').fill('How should I render a multi-dimensional knowledge graph?')
assert.ok(await page.getByRole('button', { name: /^Ask$/ }).isEnabled())
await page.locator('.ask-heading > button').click()

await page.locator('.results-list .result-main').first().click()
await page.locator('.item-modal').waitFor({ state: 'visible' })
await page.getByRole('button', { name: /Explore in graph/i }).click()
await page.waitForTimeout(1400)
assert.equal(await page.locator('.explore-pills').count(), 0)
assert.ok(await page.locator('.graph-canvas canvas').count() > 0)
await page.locator('.graph-label-pills button').first().waitFor({ state: 'visible' })
const drilldownLabelOverlaps = await page.locator('.graph-label-pills button').evaluateAll((items) => {
  const boxes = items.map((item) => item.getBoundingClientRect()); let count = 0
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]; if (!(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)) count++
  }
  return count
})
assert.equal(drilldownLabelOverlaps, 0)
await page.screenshot({ path: 'output/playwright/unified-graph/desktop-drilldown.png', fullPage: true })

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })
mobile.on('console', (message) => { if (message.type() === 'error') errors.push(`mobile: ${message.text()}`) })
await mobile.goto(baseUrl, { waitUntil: 'networkidle' })
await mobile.locator('.graph-canvas canvas').first().waitFor({ state: 'visible' })
const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
assert.ok(overflow <= 1, `mobile horizontal overflow: ${overflow}px`)
await mobile.screenshot({ path: 'output/playwright/unified-graph/mobile-atlas.png', fullPage: true })

assert.deepEqual(errors, [])
console.log(JSON.stringify({ drilldownLabels: await page.locator('.graph-label-pills button').count(), overlapCount, drilldownLabelOverlaps, mobileOverflow: overflow, errors }, null, 2))
await browser.close()
