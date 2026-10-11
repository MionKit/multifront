import {chromium, type Browser, type ConsoleMessage, type Locator, type Page} from 'playwright';

type ConsoleEntry = {type: ReturnType<ConsoleMessage['type']> | 'pageerror'; text: string};

export async function launchChromium(): Promise<Browser> {
  const executablePath = process.env.MULTIFRONT_CHROMIUM_PATH || undefined;
  try {
    return await chromium.launch({executablePath});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Chromium did not start: run \`pnpm exec playwright install chromium\` or set MULTIFRONT_CHROMIUM_PATH (see .env.sample).\n${message}`,
      {cause: err}
    );
  }
}

/** Live list: keeps filling after it returns. */
export function collectConsole(page: Page): ConsoleEntry[] {
  const entries: ConsoleEntry[] = [];
  page.on('console', (message) => void entries.push({type: message.type(), text: message.text()}));
  page.on('pageerror', (err) => void entries.push({type: 'pageerror', text: err.message}));
  return entries;
}

export function computed(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (element, name) => element.ownerDocument.defaultView!.getComputedStyle(element).getPropertyValue(name),
    property
  );
}

const RENDERED_PROPERTIES = ['color', 'padding', 'text-decoration-line', 'font-size'];

/** Every `#app` descendant: tag, text of a leaf, and `RENDERED_PROPERTIES` as computed. */
export function renderedStyles(page: Page) {
  return page.locator('#app *').evaluateAll(
    (elements, names) =>
      elements.map((element) => {
        const style = element.ownerDocument.defaultView!.getComputedStyle(element);
        return {
          tag: element.tagName,
          text: element.children.length === 0 ? element.textContent : null,
          styles: names.map((name) => style.getPropertyValue(name)),
        };
      }),
    RENDERED_PROPERTIES
  );
}
