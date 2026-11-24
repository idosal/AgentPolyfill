#!/usr/bin/env node
// Renders og/og.html to public/og.jpg (1200 x 630), the image link previews
// show. Needs Chrome and playwright-core, which the site does not install:
//
//   npm install --no-save playwright-core@1.56.1 && node og/render.mjs
//
// (or PLAYWRIGHT_CORE=<path to a playwright-core folder> node og/render.mjs)
//
// Run it after the headline, the mark or the launch video's poster changes,
// and commit public/og.jpg.

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(join(process.env.PLAYWRIGHT_CORE, 'index.mjs')).href : 'playwright-core')
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
await page.goto(pathToFileURL(join(site, 'og', 'og.html')).href)
await page.evaluate(() => document.fonts.ready)
await page.screenshot({ path: join(site, 'public', 'og.jpg'), type: 'jpeg', quality: 88 })
await browser.close()
console.log('og: public/og.jpg')
