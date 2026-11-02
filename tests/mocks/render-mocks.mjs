#!/usr/bin/env node
/**
 * Render the spec mocks in `mocks/*.html` to PNGs beside the spec that embeds them.
 *
 * WHY THIS EXISTS: a spec that proposes a view has to show it, and an ASCII sketch does not survive
 * contact with the design system - a reviewer cannot tell whether the layout is possible in the
 * console we actually ship. These mocks are drawn with the admin console's OWN stylesheets and class
 * names, so what is rendered here is what those classes do.
 *
 * WHY PLAYWRIGHT AND NOT A SCREENSHOT OF THE LIVE CONSOLE: the views being specified do not exist
 * yet, so there is nothing to photograph. Screenshotting the deployed console would also need an
 * admin sign-in and AWS credentials, which makes a doc asset undeployable-to-regenerate. This needs
 * neither: it is a local file:// render, deterministic, and reuses the Playwright that `tests/`
 * already depends on rather than adding a tool (tenet D8).
 *
 * Each element carrying `data-mock="<name>"` is captured to `<OUT_DIR>/mock-<name>.png` at its own
 * bounding box, so one HTML file yields one image per view and the images stay in step with it.
 *
 *   cd tests && node mocks/render-mocks.mjs
 *
 * The PNGs are TRACKED (the repo's other doc images sit beside their markdown the same way). Commit
 * them with the doc change; a reviewer reading the spec on a phone sees the mock inline.
 */
import { chromium } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/** Each source page, and where its images belong. */
const PAGES = [
  {
    html: path.join(HERE, 'evaluation-views.html'),
    outDir: path.join(REPO, 'docs', 'specs', 'capabilities'),
    prefix: 'mock-evaluation-',
  },
];

/* 1280 is the width the e2e suite already runs at (Desktop Chrome in tests/playwright.config.ts),
   so a mock is composed for the same viewport the console is tested at rather than a wider one that
   flatters the layout. deviceScaleFactor 2 keeps the text legible when the PDF scales it down. */
const VIEWPORT = { width: 1280, height: 900 };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });

let wrote = 0;
for (const { html, outDir, prefix } of PAGES) {
  if (!fs.existsSync(html)) throw new Error(`No such mock page: ${html}`);
  fs.mkdirSync(outDir, { recursive: true });

  const failures = [];
  page.on('requestfailed', (r) => failures.push(r.url()));

  await page.goto('file:///' + html.replace(/\\/g, '/'), { waitUntil: 'load' });

  /* A stylesheet that did not load is the one failure that produces a plausible-looking but
     worthless image - an unstyled page still screenshots. Refuse rather than write it. */
  const cssFailures = failures.filter((u) => u.endsWith('.css'));
  if (cssFailures.length) {
    throw new Error(`Stylesheet(s) failed to load, mock would be unstyled:\n  ${cssFailures.join('\n  ')}`);
  }
  const sheets = await page.evaluate(() => document.styleSheets.length);
  const tokenApplied = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent-500').trim());
  if (!tokenApplied) {
    throw new Error(`Design tokens did not apply (${sheets} stylesheet(s) seen). Check the <link> paths.`);
  }

  const names = await page.$$eval('[data-mock]', (els) => els.map((e) => e.getAttribute('data-mock')));
  if (names.length === 0) throw new Error(`${path.basename(html)} declares no [data-mock] elements`);

  for (const name of names) {
    const out = path.join(outDir, `${prefix}${name}.png`);
    await page.locator(`[data-mock="${name}"]`).screenshot({ path: out });
    const kb = (fs.statSync(out).size / 1024).toFixed(0);
    console.log(`${path.relative(REPO, out).replace(/\\/g, '/')}  ${kb} KB`);
    wrote++;
  }
}

await browser.close();
console.log(`${wrote} mock image(s) rendered at ${VIEWPORT.width}px, 2x.`);
