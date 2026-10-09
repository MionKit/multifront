// Renders docs/ and publicdocs/ assets/src/<name>.html to assets/<name>.png; the .canvas element sets the size.
import {existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {REPO_ROOT} from './lib/env.mjs';

const DIRS = ['docs', 'publicdocs'].map((dir) => join(REPO_ROOT, dir, 'assets')).filter((dir) => existsSync(join(dir, 'src')));

export async function renderDocsImages(names = []) {
  const pages = DIRS.flatMap((out) =>
    readdirSync(join(out, 'src'))
      .filter((file) => file.endsWith('.html'))
      .map((file) => ({out, name: file.slice(0, -'.html'.length)})),
  ).filter(({name}) => names.length === 0 || names.includes(name));
  // A pinned Playwright may not match the browser a host ships; MULTIFRONT_CHROMIUM_PATH points at that one.
  const browser = await chromium.launch({executablePath: process.env.MULTIFRONT_CHROMIUM_PATH || undefined});
  try {
    const page = await browser.newPage({deviceScaleFactor: 2, viewport: {width: 1700, height: 1200}});
    for (const {out, name} of pages) {
      await page.goto(pathToFileURL(join(out, 'src', `${name}.html`)).href);
      await page.evaluate(() => document.fonts.ready);
      const path = join(out, `${name}.png`);
      await page.locator('.canvas').screenshot({path, omitBackground: true});
      console.log(path.slice(REPO_ROOT.length + 1));
    }
  } finally {
    await browser.close();
  }
}
