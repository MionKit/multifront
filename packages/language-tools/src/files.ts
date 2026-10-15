import {readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import type {TypeScript} from './types.ts';

// TypeScript names program files with `/`.
export const slashed = (fileName: string): string => fileName.replaceAll('\\', '/');

/** Files ending in `suffix` below `dir`, sorted; `node_modules`, dot folders and `skipped` hold none of the project's files. */
export function filesUnder(dir: string, suffix: string, skipped?: string): string[] {
  const files: string[] = [];
  const visit = (folder: string): void => {
    for (const entry of readdirSync(folder, {withFileTypes: true})) {
      const path = join(folder, entry.name);
      const kept = entry.name !== 'node_modules' && !entry.name.startsWith('.') && path !== skipped;
      if (entry.isDirectory() && kept) visit(path);
      else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path);
    }
  };
  visit(dir);
  return files.sort();
}

/** The project's own `typescript`, resolved from `root`; `missing` is the error when it has none. */
export function projectTypeScript(root: string, missing: string): TypeScript {
  const require = createRequire(join(root, 'package.json'));
  let path: string;
  try {
    path = require.resolve('typescript');
  } catch {
    throw new Error(missing);
  }
  // Found but broken: its own error says why.
  return require(path) as TypeScript;
}
