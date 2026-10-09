// Renders every docs/assets/src/<name>.html to docs/assets/<name>.png. The canvas element sets the size.
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {REPO_ROOT} from './lib/env.mjs';

const SRC = join(REPO_ROOT, 'docs', 'assets', 'src');
const OUT = join(REPO_ROOT, 'docs', 'assets');

export async function renderDocsImages(names = []) {
  const pages = readdirSync(SRC)
    .filter((file) => file.endsWith('.html'))
    .map((file) => file.slice(0, -'.html'.length))
    .filter((name) => names.length === 0 || names.includes(name));
  // A pinned Playwright may not match the browser a host ships; MULTIFRONT_CHROMIUM_PATH points at that one.
  const browser = await chromium.launch({executablePath: process.env.MULTIFRONT_CHROMIUM_PATH || undefined});
  try {
    const page = await browser.newPage({deviceScaleFactor: 2, viewport: {width: 1700, height: 1200}});
    for (const name of pages) {
      await page.goto(pathToFileURL(join(SRC, `${name}.html`)).href);
      await page.evaluate(() => document.fonts.ready);
      await page.locator('.canvas').screenshot({path: join(OUT, `${name}.png`), omitBackground: true});
      console.log(`docs/assets/${name}.png`);
    }
  } finally {
    await browser.close();
  }
}
