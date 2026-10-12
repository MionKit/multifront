import type {Locator} from 'playwright';
import {expect} from 'vitest';
import {computed} from './chromium.ts';

export async function styles(locator: Locator, properties: string[]): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const property of properties) values[property] = await computed(locator, property);
  return values;
}

/** A failure names each property that differs. */
export async function expectSameComputedStyles(first: Locator, second: Locator, properties: string[]): Promise<void> {
  expect(await styles(second, properties)).toEqual(await styles(first, properties));
}
