import {readFileSync} from 'node:fs';
import {rootRelativePath, scopeId} from '@multifront/core';

/** The `data-v-<id>` a `.ucf` file's elements carry in an app served from `root`. */
export function scopeAttribute(root: string, file: string, production: boolean): string {
  return `data-v-${scopeId(rootRelativePath(root, file), readFileSync(file, 'utf8'), production)}`;
}
