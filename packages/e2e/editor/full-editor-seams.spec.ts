// Milestone 7 QA: mf-tsc (7.2) and the TypeScript plugin the packed .vsix ships (7.13) see the same errors in every block.
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Finding} from '@multifront/core';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {copyApp, readComponent, removeApp} from '../fixtures/index.ts';
import {runMfTsc} from './lib/commands.ts';
import {addFile, BROKEN, report} from './lib/tsc.ts';
import {open, startTsserver} from './lib/tsserver.ts';
import {packVsix} from './lib/vsix.ts';

const PACK = 'multifront-typescript-plugin-pack';
// Card.ucf with a number passed to a string attribute in its <svelte> markup, as the exit test edits it.
const MARKUP_BREAKS = 'MarkupBreaks.ucf';
const FILES = ['ReactBreaks.ucf', 'VueBreaks.ucf', 'SvelteBreaks.ucf', MARKUP_BREAKS];

type Located = Pick<Finding, 'code' | 'line' | 'column' | 'end'>;

function markupBreaks(): string {
  return readComponent('Card.ucf')
    .source.replace(
      '    let { title }: { title: string } = $props()\n',
      '    let { title }: { title: string } = $props()\n    const count: number = 1\n'
    )
    .replace('<h2>{title}</h2></div>\n</svelte>', '<h2 title={count}>{title}</h2></div>\n</svelte>');
}

let temp: string;
let extension: string;
let root: string;

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'multifront-m7-seams-'));
  extension = await packVsix(temp);
  root = await copyApp(BROKEN);
  addFile(root, MARKUP_BREAKS, markupBreaks());
}, 120_000);

afterAll(async () => {
  if (root) await removeApp(root);
  if (temp) rmSync(temp, {recursive: true, force: true});
});

describe('mf-tsc and the TypeScript plugin of the packed .vsix, on the same broken .ucf files', () => {
  it('give the same codes at the same spans, a <svelte> markup attribute included', async () => {
    const {findings} = report((await runMfTsc(root, [...FILES, '--format', 'json'])).stdout);
    const ours = FILES.map((name) =>
      findings.filter(({file}) => file === name).map(({code, line, column, end}): Located => ({code, line, column, end}))
    );
    expect(ours.map((found) => found.length)).toEqual([1, 1, 1, 1]);
    // As VS Code with its own TypeScript loads the plugin: the pack from the extension folder only.
    const server = startTsserver({cwd: root, plugins: [PACK], probeLocations: [extension], isolated: true});
    try {
      const components = FILES.map((file) => ({filename: join(root, file), source: readFileSync(join(root, file), 'utf8')}));
      await open(server, components);
      const theirs: Located[][] = [];
      for (const {filename} of components) {
        theirs.push(
          (await server.diagnostics(filename)).map(({code, start, end}) => ({
            code: typeof code === 'number' ? `TS${code}` : String(code),
            line: start.line,
            column: start.offset,
            end: {line: end.line, column: end.offset},
          }))
        );
      }
      expect(Object.fromEntries(FILES.map((name, index) => [name, theirs[index]]))).toEqual(
        Object.fromEntries(FILES.map((name, index) => [name, ours[index]]))
      );
    } finally {
      await server.stop();
    }
  });
});
