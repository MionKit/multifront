// Spec 3.6, root props: a Svelte parent styles a `.ucf` child with `class` and `style` as React and Vue parents do.
import {join} from 'node:path';
import type {Browser, Locator, Page} from 'playwright';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR} from '../fixtures/index.ts';
import {collectConsole, computed, consoleProblems, launchChromium} from './lib/chromium.ts';
import {expectSameComputedStyles} from './lib/parity.ts';
import {buildAndPreview, startDev} from './lib/serve.ts';

const FIXTURE = join(FIXTURES_DIR, 'apps', 'root-props');
const FRAMEWORKS = ['vue', 'react', 'svelte'] as const;
// Each set by the child's own style, the parent's or both: the parent's keys win.
const PROPERTIES = ['color', 'font-weight', 'font-style', 'padding', 'margin', 'background-color', 'text-decoration-line'];

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await launchChromium();
});

afterAll(async () => {
  await browser?.close();
});

async function root(page: Page, framework: string, name: string): Promise<Locator> {
  const wrapper = page.locator(`#${framework} [data-case="${name}"]`);
  await wrapper.locator(':scope > *').first().waitFor();
  expect(await wrapper.locator(':scope > *').count()).toBe(1);
  return wrapper.locator(':scope > *');
}

async function attributesOf(locator: Locator): Promise<{classes: string[]; scope: string[]}> {
  return locator.evaluate((element) => ({
    classes: [...element.classList].sort(),
    scope: element.getAttributeNames().filter((name: string) => name.startsWith('data-v-')),
  }));
}

async function expectParity(url: string): Promise<void> {
  const page = await browser!.newPage();
  try {
    const messages = collectConsole(page);
    await page.goto(url);
    for (const name of ['button', 'note', 'item']) {
      const [vue, ...others] = await Promise.all(FRAMEWORKS.map((framework) => root(page, framework, name)));
      // The parent's class and its scoped `.extra` rule reach the root, and its color beats the child's own.
      expect((await attributesOf(vue!)).classes).toContain('extra');
      expect(await computed(vue!, 'text-decoration-line')).toBe('underline');
      for (const other of others) {
        await expectSameComputedStyles(vue!, other, PROPERTIES);
        expect(await attributesOf(other)).toEqual(await attributesOf(vue!));
      }
    }
    expect(await computed(await root(page, 'svelte', 'button'), 'font-weight')).toBe('700');
    expect(await computed(await root(page, 'svelte', 'note'), 'padding')).toBe('6px');
    expect(await computed(await root(page, 'svelte', 'item'), 'padding')).toBe('6px');
    expect(consoleProblems(messages)).toEqual([]);
  } finally {
    await page.close();
  }
}

describe('vite build and preview', () => {
  let preview: Awaited<ReturnType<typeof buildAndPreview>> | undefined;

  beforeAll(async () => {
    preview = await buildAndPreview(FIXTURE);
  });

  afterAll(async () => {
    await preview?.close();
  });

  it("gives each Svelte root the parent's class and style, as the React and Vue roots get them", async () => {
    await expectParity(preview!.url);
  });
});

describe('dev server', () => {
  let app: Awaited<ReturnType<typeof startDev>> | undefined;

  beforeAll(async () => {
    app = await startDev(FIXTURE);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("gives each Svelte root the parent's class and style, as the React and Vue roots get them", async () => {
    await expectParity(app!.url);
  });
});
