import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {rootRelativePath} from '@multifront/core';
import type {Finding} from '@multifront/core';
import ignore from 'ignore';
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

/** The project's own install of `name`, found from `root`. */
export function resolveInProject(root: string, name: string, missing: string): {require: NodeJS.Require; path: string} {
  const require = createRequire(join(root, 'package.json'));
  try {
    return {require, path: require.resolve(name)};
  } catch {
    throw new Error(missing);
  }
}

/** The project's own `typescript`. */
export function projectTypeScript(root: string, missing: string): TypeScript {
  const {require, path} = resolveInProject(root, 'typescript', missing);
  // Found but broken: its own error says why.
  return require(path) as TypeScript;
}

/** A module of the project's own install, found from `root`. */
export async function projectImport<Module>(root: string, name: string, missing: string): Promise<Module> {
  return (await import(pathToFileURL(resolveInProject(root, name, missing).path).href)) as Module;
}

export function nearestFile(dir: string, names: readonly string[]): string | undefined {
  for (let folder = dir; ; folder = dirname(folder)) {
    const found = names.map((name) => join(folder, name)).find((file) => existsSync(file));
    if (found || dirname(folder) === folder) return found;
  }
}

// A JSON string, a comment, or a run of other text.
const JSONC_TOKENS = /"(?:[^"\\]|\\.)*"?|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|[^"/]+|\//g;

/** JSON with comments and trailing commas, as oxfmt and oxlint read it; blanking keeps error positions. */
export function parseJsonc(file: string, root: string): unknown {
  const uncommented = readFileSync(file, 'utf8').replace(JSONC_TOKENS, (token) =>
    token.startsWith('//') || token.startsWith('/*') ? token.replace(/[^\n]/g, ' ') : token
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

/** Spec 8.1 rules; `ignored` returns the config ignoring a file, `otherFiles` names what checks a non-`.ucf` file. */
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

/** `ignorePatterns` are gitignore lines rooted at the config's folder, as oxfmt and oxlint read them. */
export function isIgnored(config: {file?: string; ignorePatterns: string[]}, fileName: string): boolean {
  if (!config.file || config.ignorePatterns.length === 0) return false;
  const path = rootRelativePath(dirname(config.file), fileName);
  return !path.startsWith('../') && ignore().add(config.ignorePatterns).ignores(path);
}

export const counted = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** A summary's `2 errors, 1 warning`; empty when there is neither. */
export function problems(findings: Finding[]): string {
  const errors = findings.filter(({severity}) => severity === 'error').length;
  const warnings = findings.length - errors;
  return [errors && counted(errors, 'error'), warnings && counted(warnings, 'warning')].filter(Boolean).join(', ');
}
