import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {rootRelativePath} from '@multifront/core';
import type {TypeScript} from './types.ts';

// TypeScript names program files with `/`.
export const slashed = (fileName: string): string => fileName.replaceAll('\\', '/');

/** `node_modules`, dot folders and `skipped` hold none of the project's files. */
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

/** The project's own `typescript`. */
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

/** A module of the project's own install, found from `root`. */
export async function projectImport<Module>(root: string, name: string, missing: string): Promise<Module> {
  let path: string;
  try {
    path = createRequire(join(root, 'package.json')).resolve(name);
  } catch {
    throw new Error(missing);
  }
  return (await import(pathToFileURL(path).href)) as Module;
}

/** The first of `names` in `dir` or the nearest folder above it. */
export function nearestFile(dir: string, names: readonly string[]): string | undefined {
  for (let folder = dir; ; folder = dirname(folder)) {
    const found = names.map((name) => join(folder, name)).find((file) => existsSync(file));
    if (found || dirname(folder) === folder) return found;
  }
}

// A JSON string, a comment, or a run of other text.
const JSONC_TOKENS = /"(?:[^"\\]|\\.)*"?|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|[^"/]+|\//g;

const isComment = (token: string) => token.startsWith('//') || token.startsWith('/*');

/** JSON with comments and trailing commas, as oxfmt and oxlint read their configs; blanking keeps the error positions. */
export function parseJsonc(file: string, root: string): unknown {
  const uncommented = readFileSync(file, 'utf8').replace(JSONC_TOKENS, (token) =>
    isComment(token) ? token.replace(/[^\n]/g, ' ') : token
  );
  // Comments are blank now, so a trailing comma and its `}` meet in one run.
  const json = uncommented.replace(JSONC_TOKENS, (token) =>
    token.startsWith('"') ? token : token.replace(/,(?=\s*[}\]])/g, ' ')
  );
  try {
    return JSON.parse(json);
  } catch (err) {
    throw new Error(`${rootRelativePath(root, file)}: ${(err as Error).message}`);
  }
}

/**
 * The `.ucf` files of `paths` (none: the cwd), by the command rules of spec 8.1. `ignored` names the config that
 * ignores a file; `otherFiles` says what checks a file that is not `.ucf`.
 */
export function ucfFiles(paths: string[], ignored: (file: string) => string | undefined, otherFiles: string): string[] {
  const cwd = process.cwd();
  const shown = (path: string) => rootRelativePath(cwd, path) || '.';
  const files = new Set<string>();
  for (const path of paths.length > 0 ? paths : [cwd]) {
    if (!statSync(path).isDirectory()) {
      if (!path.endsWith('.ucf')) throw new Error(`${shown(path)} is not a .ucf file; ${otherFiles}`);
      const config = ignored(path);
      if (config !== undefined) throw new Error(`${shown(path)} is ignored by ${config}`);
      files.add(path);
      continue;
    }
    const found = filesUnder(path, '.ucf').filter((file) => ignored(file) === undefined);
    if (found.length === 0) throw new Error(`${shown(path)} holds no .ucf file`);
    for (const file of found) files.add(file);
  }
  return [...files].sort();
}
