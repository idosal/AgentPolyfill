// Optional: refresh the real Chrome screenshot used by the benchmark. Uses the
// helper's already-installed playwright-core; no npm install or external page.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { decodePng } from "../../../../mod/helper/png.mjs";
const require = createRequire(new URL("../../../../mod/helper/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const tmp = fileURLToPath(new URL("../target/browser-tmp/", import.meta.url));
mkdirSync(tmp, { recursive: true });
process.env.TMPDIR = tmp;
const html = `<!doctype html><meta charset="utf-8"><title>Pictures benchmark</title>
<style>
*{box-sizing:border-box} body{margin:0;background:#141825;color:#eef0f6;font:24px Arial,sans-serif}
aside{position:absolute;width:320px;inset:0 auto 0 0;background:#202638;padding:48px 32px}
h1{font-size:34px;margin:0 0 44px}h2{font-size:32px;margin:0 0 16px}p{color:#aeb8ce}
nav div{padding:22px;margin:10px 0;border-radius:12px}nav div:first-child{background:#424f75}
main{margin-left:320px;padding:48px 56px}.head{display:flex;justify-content:space-between;align-items:center}
button{border:1px solid #647496;border-radius:10px;color:#fff;background:#334263;padding:16px 28px;font:inherit}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;margin:32px 0}
.card{background:#252d43;padding:28px;border:1px solid #3d4966;border-radius:16px}.value{font-size:52px;margin:22px 0}.green{color:#a7dfb2}
.chart{background:#20283c;border:1px solid #3d4966;border-radius:16px;padding:28px;margin:28px 0;display:flex;align-items:end;gap:28px;height:260px}
.bar{flex:1;background:linear-gradient(#adbbe8,#50669c);border-radius:7px 7px 0 0}
table{width:100%;border-collapse:collapse;background:#20283c}td,th{padding:24px;text-align:left;border-bottom:1px solid #39435a}th{color:#aeb8ce}.pill{padding:8px 18px;border-radius:24px;background:#284a40;color:#b6e3c4}
</style><aside><h1>MCP Apps</h1><nav><div>Overview</div><div>Projects</div><div>Activity</div><div>Reports</div><div>Settings</div></nav></aside>
<main><div class="head"><div><h2>Workspace overview</h2><p>Local picture encoder benchmark · November 2026</p></div><button>New project</button></div>
<div class="cards">${["Active views", "Completed tasks", "Average response", "Team members"].map((title, i) => `<div class="card">${title}<div class="value">${["24", "1,284", "240 ms", "16"][i]}</div><span class="green">+${[12, 18, 9, 4][i]}% this week</span></div>`).join("")}</div>
<h2>Activity this month</h2><div class="chart">${Array.from({ length: 20 }, (_, i) => `<div class="bar" style="height:${30 + ((i * 37) % 67)}%"></div>`).join("")}</div>
<table><thead><tr><th>Project</th><th>Owner</th><th>Status</th><th>Last updated</th></tr></thead><tbody>${["Terminal app host", "Image processing", "Weekly report", "Customer dashboard"].map((title, i) => `<tr><td>${title}</td><td>${["Alex", "Sam", "Jamie", "Robin"][i]}</td><td><span class="pill">Active</span></td><td>${i + 2} minutes ago</td></tr>`).join("")}</tbody></table></main>`;
const browser = await chromium.launch({ headless: true, channel: "chrome", args: ["--disable-background-networking", "--disable-component-update"] });
try {
  const context = await browser.newContext({ viewport: { width: 2192, height: 1152 }, deviceScaleFactor: 1, offline: true });
  await context.route("**/*", (route) => route.abort());
  const page = await context.newPage();
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot({ type: "png", animations: "disabled" });
  const image = decodePng(png);
  if (image.width !== 2192 || image.height !== 1152) throw new Error("wrong viewport");
  writeFileSync(new URL("./fixtures/benchmark.png", import.meta.url), png);
  const metadata = { width: image.width, height: image.height, rows: 48, top: 0, pngBytes: png.length,
    sha256: createHash("sha256").update(png).digest("hex"),
    rgbaSha256: createHash("sha256").update(image.data).digest("hex"),
    browser: browser.version(), deviceScaleFactor: 1,
    description: "Actual headless Chrome screenshot of the offline dashboard in capture-benchmark.mjs: flat cards, antialiased text, gradient bars and a table." };
  writeFileSync(new URL("./fixtures/benchmark.json", import.meta.url), JSON.stringify(metadata, null, 2) + "\n");
  console.log(metadata);
} finally { await browser.close(); }
