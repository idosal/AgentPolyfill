// Records a demo-button page while a session runs, and presses its button for real.
// Same output format as the mcp-events polyfill's video/record-page.mjs, so its cut tool can use it.
//
//   node live/record-button.mjs <first url> <out dir> [--width 720] [--height 900] [--port 4021] [--fps 12]
//   PLAYWRIGHT=/path/to/playwright-core/index.mjs   (take.sh passes the polyfill's video/node_modules copy)
//
// Controls for the take script:
//   POST /open?url=<page>             go to a page (the button page, once the session has made one)
//   POST /press?message=<text>        type the message, hover, then click the real button
//   POST /stop                        finish and write <out>/page.json
// page.json lists every photograph with its wall-clock time, and each click with its time and the
// button's place on the page.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pw = process.env.PLAYWRIGHT ?? `${process.env.HOME}/mcp-events-plugin/video/node_modules/playwright-core/index.mjs`;
const { chromium } = await import(pathToFileURL(pw).href);
const [first, out, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => (rest.includes(`--${name}`) ? rest[rest.indexOf(`--${name}`) + 1] : fallback);
const W = Number(flag('width', 720));
const H = Number(flag('height', 900));
const PORT = Number(flag('port', 4021));
const FPS = Number(flag('fps', 12));
mkdirSync(join(out, 'frames'), { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--hide-scrollbars'] });
const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: 'light' })).newPage();
await page.goto(first);

const frames = [];
const clicks = [];
const visits = [];
let running = true;
let last;
const loop = (async () => {
    while (running) {
        const started = Date.now();
        const file = `${started}.jpg`;
        try {
            const shot = await page.screenshot({ type: 'jpeg', quality: 90, timeout: 3000, animations: 'disabled', caret: 'initial' });
            if (!last || !shot.equals(last)) {
                writeFileSync(join(out, 'frames', file), shot);
                frames.push({ t: started / 1000, file });
                last = shot;
            }
        } catch (e) {
            // the page is navigating or closing; say so, so a stalled recording is visible in page.log
            console.log(`no photograph at ${started}: ${String(e).split('\n')[0]}`);
        }
        await new Promise((r) => setTimeout(r, Math.max(5, 1000 / FPS - (Date.now() - started))));
    }
})();

const box = async (selector) => {
    const b = await page.locator(selector).first().boundingBox().catch(() => null);
    return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
};

const control = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
        if (req.method === 'POST' && u.pathname === '/open') {
            const url = u.searchParams.get('url');
            await page.goto(url, { waitUntil: 'load' });
            last = undefined; // the next photograph is kept whatever it shows
            visits.push({ t: Date.now() / 1000, url: new URL(url).pathname.replace(/\/b\/(b.{5}).*/, '/b/$1…') });
            res.end('ok\n');
        } else if (req.method === 'POST' && u.pathname === '/press') {
            const message = u.searchParams.get('message') ?? '';
            if (message) {
                await page.locator('#msg').click();
                await page.keyboard.type(message, { delay: 70 });
                await page.waitForTimeout(400);
            }
            const button = page.locator('#press');
            await button.hover();
            await page.waitForTimeout(450);
            const at = Date.now() / 1000;
            await button.click();
            clicks.push({ t: at, deploy: 'press', button: await box('#press'), services: await box('main'), recent: await box('#status') });
            await page.mouse.move(W - 4, H - 4);
            await page.waitForFunction(() => document.getElementById('status')?.textContent?.length > 0, null, { timeout: 10000 }).catch(() => {});
            res.end((await page.locator('#status').textContent()) + '\n');
        } else if (req.method === 'POST' && u.pathname === '/stop') {
            running = false;
            await loop;
            writeFileSync(join(out, 'page.json'), JSON.stringify({ url: first, width: W, height: H, scale: 2, frames, clicks, visits }, null, 1));
            res.end('stopped\n');
            control.close();
            await browser.close();
        } else {
            res.statusCode = 404;
            res.end();
        }
    } catch (e) {
        res.statusCode = 500;
        res.end(String(e));
    }
});
control.listen(PORT, '127.0.0.1', () => console.log(`recording ${first}; controls on http://127.0.0.1:${PORT}`));
