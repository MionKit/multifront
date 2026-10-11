import {hash} from 'node:crypto';
import {relative, sep} from 'node:path';

/** plugin-vue's default component id; `relativePath` is from the Vite root with `/` separators. */
export function scopeId(relativePath: string, source: string, production: boolean): string {
  return hash('sha256', relativePath + (production ? source : ''), 'hex').slice(0, 8);
}

/** The path `scopeId` hashes, as plugin-vue's `normalizePath(relative(root, filename))`. */
export function rootRelativePath(root: string, filename: string): string {
  return relative(root, filename).split(sep).join('/');
}
