import {isAbsolute, relative, sep} from 'node:path';
import type {URI} from 'vscode-uri';

/** The deepest folder holding the file: its own project in a multi-root workspace. */
export function workspaceRoot(fileName: string, folders: readonly URI[]): string | undefined {
  const roots = folders.filter(({scheme}) => scheme === 'file').map(({fsPath}) => fsPath);
  const holding = roots.filter((root) => {
    const path = relative(root, fileName);
    return !!path && !isAbsolute(path) && !path.startsWith(`..${sep}`) && path !== '..';
  });
  return holding.sort((first, second) => second.length - first.length)[0];
}
