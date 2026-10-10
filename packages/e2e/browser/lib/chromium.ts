import {chromium, type Browser, type ConsoleMessage, type Page} from 'playwright';

type ConsoleEntry = {type: ReturnType<ConsoleMessage['type']> | 'pageerror'; text: string};

/** Playwright's Chromium, or the one `MULTIFRONT_CHROMIUM_PATH` names. */
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

/** Live list of every console message and uncaught page error (`type: 'pageerror'`). */
export function collectConsole(page: Page): ConsoleEntry[] {
  const entries: ConsoleEntry[] = [];
  page.on('console', (message) => void entries.push({type: message.type(), text: message.text()}));
  page.on('pageerror', (err) => void entries.push({type: 'pageerror', text: err.message}));
  return entries;
}
