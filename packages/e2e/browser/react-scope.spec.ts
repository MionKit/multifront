import {readFileSync} from 'node:fs';
import {join, relative, sep} from 'node:path';
import type {Browser, Locator, Page} from 'playwright';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {scopeId} from '@multifront/core';
import {FIXTURES_DIR, componentPath} from '../fixtures/index.ts';
import {collectConsole, launchChromium} from './lib/chromium.ts';
import {buildAndPreview, startDev} from './lib/serve.ts';

const ROOT = join(FIXTURES_DIR, 'apps', 'react-scope');
const STAMPED = componentPath('react/scope/Stamped.ucf');
const RELATIVE = relative(ROOT, STAMPED).split(sep).join('/');
const SOURCE = readFileSync(STAMPED, 'utf8');

// Hand-counted from Stamped.ucf: every host element it renders, fragments rendering none.
const ELEMENT_COUNT = 19;

// Selector → the scoped rule's property and value in Stamped.ucf.
const SCOPED_RULES: [string, string, string][] = [
  ['.box', 'color', 'rgb(10, 20, 30)'],
  ['.dot', 'fill', 'rgb(40, 50, 60)'],
  ['my-el', 'color', 'rgb(70, 80, 90)'],
  ['.item', 'color', 'rgb(100, 110, 120)'],
  ['.member', 'color', 'rgb(130, 140, 150)'],
  ['.lookalike', 'color', 'rgb(160, 170, 180)'],
  ['.list', 'color', 'rgb(190, 200, 210)'],
];

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await launchChromium();
});

afterAll(async () => {
  await browser?.close();
});

async function scopeAttributes(page: Page) {
  const read = (locator: Locator) =>
    locator.evaluateAll((elements) =>
      elements.map((element) => ({
        tag: element.tagName,
        scope: element.getAttributeNames().filter((name: string) => name.startsWith('data-v-')),
      }))
    );
  return {app: (await read(page.locator('#app')))[0]!.scope, elements: await read(page.locator('#app *'))};
}

describe.each([
  ['dev', startDev, false],
  ['preview', buildAndPreview, true],
] as const)('react-scope in %s', (_mode, serve, production) => {
  const attribute = `data-v-${scopeId(RELATIVE, SOURCE, production)}`;
  let app: {url: string; close(): Promise<void>} | undefined;

  beforeAll(async () => {
    app = await serve(ROOT);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("stamps every element of the block with the file's scope id, and the scoped rules apply", async () => {
    const page = await browser!.newPage();
    try {
      const messages = collectConsole(page);
      await page.goto(app!.url);
      await page.locator('.box').waitFor();

      const {app: outside, elements} = await scopeAttributes(page);
      expect(outside).toEqual([]);
      expect(elements).toHaveLength(ELEMENT_COUNT);
      for (const element of elements) expect(element).toEqual({tag: element.tag, scope: [attribute]});

      for (const [selector, property, value] of SCOPED_RULES) {
        const found = await page
          .locator(selector)
          .first()
          .evaluate(
            (element, name) => element.ownerDocument.defaultView!.getComputedStyle(element).getPropertyValue(name),
            property
          );
        expect({selector, value: found}).toEqual({selector, value});
      }

      // A stamped Fragment would log React's "Invalid prop supplied to `React.Fragment`" in dev.
      await page.waitForLoadState('networkidle');
      expect(messages.filter(({type}) => type === 'warning' || type === 'error' || type === 'pageerror')).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
