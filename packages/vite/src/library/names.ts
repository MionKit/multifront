import {readdir} from 'node:fs/promises';
import {join, posix, relative} from 'node:path';
import {normalizePath} from 'vite';
import {splitId, virtualTarget} from '../ids.ts';

const VIRTUAL_DIR = '_virtual';
const SCRIPT_EXT = /\.[cm]?[jt]sx?$/;
const UNSAFE = /[^\w./-]/g;

// `/abs/Card.ucf.react.tsx` or a style id → `/abs/Card.ucf`.
export function fileOf(id: string): string {
  const {path} = splitId(id);
  return virtualTarget(path)?.file ?? path;
}

export function shownFile(root: string, file: string): string {
  return normalizePath(relative(root, file));
}

/** `child` relative to `dir`, or undefined unless below it; both are Vite's posix ids. */
export function insideDir(dir: string, child: string): string | undefined {
  const relative = posix.relative(dir, child);
  return relative === '' || relative.startsWith('../') || posix.isAbsolute(relative) ? undefined : relative;
}

// A `.ucf` sub-module by its query: `script`, `module-0` (a class map), `style-0` (CSS only, so never written).
function subModuleName(query: URLSearchParams): string {
  const type = query.get('type');
  if (!type) return query.toString().replace(UNSAFE, '_');
  // Ours flags a class map with `module`, plugin-vue with `lang.module.css`.
  const module = type === 'style' && [...query.keys()].some((key) => key === 'module' || key.includes('.module.'));
  const index = query.get('index');
  const kind = module ? 'module' : type;
  return index === null ? kind : `${kind}-${index}`;
}

/** Output path without `.js`: `Card`, `forms/Field`, `_virtual/Card.module-0`. */
export function outputName(id: string, src: string): string {
  if (id.startsWith('\0')) {
    const name = id
      .slice(1)
      .replace(/^virtual:/, '')
      .replace(/:/g, '/')
      .replace(UNSAFE, '_');
    return `${VIRTUAL_DIR}/${name.replace(SCRIPT_EXT, '')}`;
  }
  const {path, query} = splitId(id);
  const file = virtualTarget(path)?.file ?? path;
  const relative = insideDir(src, file);
  if (relative === undefined) throw new Error(`${file} is outside the library's src folder ${src}`);
  const base = relative.endsWith('.ucf') ? relative.slice(0, -'.ucf'.length) : relative.replace(SCRIPT_EXT, '');
  return query.size === 0 ? base : `${VIRTUAL_DIR}/${base}.${subModuleName(query)}`;
}

export async function filesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, {recursive: true, withFileTypes: true});
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => normalizePath(relative(dir, join(entry.parentPath, entry.name))))
    .sort();
}
