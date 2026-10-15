import {readdirSync} from 'node:fs';
import {join} from 'node:path';

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
