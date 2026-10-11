import {readFileSync} from 'node:fs';
import {relative, sep} from 'node:path';
import {scopeId} from '@multifront/core';

/** The `data-v-<id>` a `.ucf` file's elements carry in an app served from `root`. */
export function scopeAttribute(root: string, file: string, production: boolean): string {
  return `data-v-${scopeId(relative(root, file).split(sep).join('/'), readFileSync(file, 'utf8'), production)}`;
}
