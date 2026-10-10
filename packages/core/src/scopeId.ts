import {hash} from 'node:crypto';

/** plugin-vue's default component id; `relativePath` is from the Vite root with `/` separators. */
export function scopeId(relativePath: string, source: string, production: boolean): string {
  return hash('sha256', relativePath + (production ? source : ''), 'hex').slice(0, 8);
}
