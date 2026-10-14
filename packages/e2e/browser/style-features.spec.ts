// Spec 3.8: each style feature renders the same in Vue, React and Svelte; props, refs and slots keep each one's own way.
import {join} from 'node:path';
import type {Browser, Page} from 'playwright';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR} from '../fixtures/index.ts';
import {collectConsole, consoleProblems, launchChromium, renderedStyles} from './lib/chromium.ts';
import {styles} from './lib/parity.ts';
import {buildAndPreview, startDev} from './lib/serve.ts';

const ROOT = join(FIXTURES_DIR, 'apps', 'style-features');
const FRAMEWORKS = ['vue', 'react', 'svelte'] as const;
const PROPERTIES = [
  'color',
  'background-color',
  'font-weight',
  'font-style',
  'text-decoration-line',
  'letter-spacing',
  'padding',
  'margin',
];

// Hand-read from the fixtures, so two unstyled elements cannot pass as equal. Keyed by selector inside the case.
const EXPECTED = {
  blocks: {
    '.global-rule': {color: 'rgb(10, 20, 30)'},
    '.scoped-rule': {color: 'rgb(40, 50, 60)'},
    'p:nth-child(3)': {color: 'rgb(70, 80, 90)'},
    'p:nth-child(4)': {color: 'rgb(100, 110, 120)'},
    'p:nth-child(5)': {color: 'rgb(130, 140, 150)'},
  },
  langs: {
    '.scss': {color: 'rgb(11, 12, 13)'},
    '.sass': {color: 'rgb(14, 15, 16)'},
    '.stylus': {color: 'rgb(17, 18, 19)'},
    '.pcss': {color: 'rgb(20, 21, 22)'},
    '.imported': {color: 'rgb(26, 27, 28)'},
  },
  vars: {
    '.vars': {color: 'rgb(200, 0, 0)', padding: '4px'},
    '.inner': {'background-color': 'rgb(200, 0, 0)'},
  },
  fallback: {
    '.vars': {color: 'rgb(1, 2, 3)', padding: '1px'},
    '.inner': {'background-color': 'rgb(4, 5, 6)'},
  },
  frame: {
    // The parent's scoped style on the child's root.
    '.frame': {margin: '5px', padding: '3px'},
    '.own': {color: 'rgb(31, 32, 33)'},
    // The parent's scoped style, the child's :deep() and :global(), never the child's own scoped `.from-parent`.
    'span.from-parent': {
      color: 'rgb(0, 100, 200)',
      'font-weight': '400',
      'text-decoration-line': 'underline',
      'letter-spacing': '3px',
    },
    'b.from-parent': {color: 'rgb(0, 100, 200)', 'font-weight': '700'},
  },
} satisfies Record<string, Record<string, Record<string, string>>>;
const PARENT_REFS = {vue: 'vue-hello DIV', react: 'DIV', svelte: 'svelte-hello'};

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await launchChromium();
});

afterAll(async () => {
  await browser?.close();
});

type Framework = (typeof FRAMEWORKS)[number];

function rendered(page: Page, name: string) {
  return renderedStyles(page, `#app [data-case="${name}"] *`, PROPERTIES);
}

describe.each([
  ['dev server', startDev],
  ['vite build and preview', buildAndPreview],
] as const)('style-features, %s', (_mode, serve) => {
  let app: Awaited<ReturnType<typeof serve>> | undefined;
  // One page per framework: each holds only its own framework's CSS, so a missing style import shows.
  const pages = {} as Record<Framework, Page>;
  const messages = {} as Record<Framework, ReturnType<typeof collectConsole>>;

  beforeAll(async () => {
    app = await serve(ROOT);
    for (const framework of FRAMEWORKS) {
      const page = await browser!.newPage();
      messages[framework] = collectConsole(page);
      await page.goto(`${app.url}?framework=${framework}`);
      await page.locator('#app .parent-ref').waitFor();
      pages[framework] = page;
    }
  });

  afterAll(async () => {
    for (const page of Object.values(pages)) await page.close();
    await app?.close();
  });

  it.each(Object.entries(EXPECTED))(
    'renders the %s case with the same computed styles in every framework',
    async (name, cases) => {
      for (const framework of FRAMEWORKS) {
        for (const [selector, expected] of Object.entries(cases)) {
          const actual = await styles(pages[framework].locator(`#app [data-case="${name}"] ${selector}`), PROPERTIES);
          expect(actual, `${framework} ${selector}`).toMatchObject(expected);
        }
      }
      const vue = await rendered(pages.vue, name);
      expect(vue.length).toBeGreaterThan(1);
      expect(await rendered(pages.react, name)).toEqual(vue);
      expect(await rendered(pages.svelte, name)).toEqual(vue);
    }
  );

  it("styles a Svelte child from Svelte's own --name props, through its display: contents wrapper", async () => {
    const wrapper = pages.svelte.locator('#app [data-case="svelte-props"] > svelte-css-wrapper');
    expect(await wrapper.getAttribute('style')).toContain('display: contents');
    expect((await rendered(pages.svelte, 'svelte-props')).slice(1)).toEqual(await rendered(pages.vue, 'vars'));
  });

  it('sets v-bind() variables and marks :slotted() content in Vue', async () => {
    const features = pages.vue.locator('#app [data-case="vue-features"]');
    expect(await styles(features.locator('.bound'), PROPERTIES)).toMatchObject({color: 'rgb(10, 120, 60)'});
    expect(await styles(features.locator('.slotted-target'), PROPERTIES)).toMatchObject({'font-style': 'italic'});
  });

  it.each(FRAMEWORKS)('passes props, element refs and slot content the %s way', async (framework) => {
    const api = pages[framework].locator('#app [data-case="api"]');
    expect(await api.locator('.label').textContent()).toBe('Label');
    await expect.poll(() => api.locator('.refs').textContent()).toBe('DIV/EM');
    expect(await api.locator('.item').textContent()).toBe('item 7');
    await expect.poll(() => api.locator('.parent-ref').textContent()).toBe(PARENT_REFS[framework]);
  });

  it.each(FRAMEWORKS)('logs no warning or error on the %s page', async (framework) => {
    await pages[framework].waitForLoadState('networkidle');
    expect(consoleProblems(messages[framework])).toEqual([]);
  });
});
