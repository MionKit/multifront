// Spec 3.6, root props: the editor types the `class` and `style` the build hands a Svelte root, as the library does.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR} from '../fixtures/index.ts';
import {codesOnLine, edit, PLUGIN} from './lib/cases.ts';
import {locate, open, startTsserver} from './lib/tsserver.ts';
import type {Component, Tsserver} from './lib/tsserver.ts';

const APP_DIR = join(FIXTURES_DIR, 'apps', 'root-props');
const PARENT_FILE = join(APP_DIR, 'Parent.ucf');
const PARENT: Component = {filename: PARENT_FILE, source: readFileSync(PARENT_FILE, 'utf8')};
// The `<svelte>` block's last import, then its markup to the block's end.
const SVELTE_IMPORT = "    import Note from '../../components/Note.ucf'\n";
const SVELTE_END = '  </section>\n</svelte>';

// Each probe renders `Probe`, one fixture's default export, in Parent.ucf's `<svelte>` block, unsaved.
// `errors`: the codes on its line.
const PROBES: {fixture: string; markup: string; errors: number[]}[] = [
  {fixture: 'library/src/Button.ucf', markup: `<Probe label="x" class={['a', {b: true}]} style="color: red" />`, errors: []},
  {fixture: 'library/src/Button.ucf', markup: '<Probe label="x" style={1} />', errors: [2322]},
  {fixture: 'components/Note.ucf', markup: '<Probe class="a" style="color: red" />', errors: []},
  // Typed in a JSDoc comment, unannotated, a `$props()` line the build adds, a component root.
  {fixture: 'components/svelte/root-props/JsDoc.ucf', markup: '<Probe class="a" style="color: red" />', errors: []},
  {fixture: 'components/svelte/root-props/Untyped.ucf', markup: '<Probe class="a" style="color: red" />', errors: []},
  {fixture: 'components/svelte/roots/NoPropsRoot.ucf', markup: '<Probe class="a" style="color: red" />', errors: []},
  {fixture: 'components/svelte/roots/OptionsRoot.ucf', markup: '<Probe class="a" style="color: red" />', errors: []},
  {fixture: 'components/svelte/root-props/ComponentRoot.ucf', markup: '<Probe class="a" style="color: red" />', errors: []},
  // The author's own types for what the author handles.
  {fixture: 'components/svelte/root-props/ReadsProps.ucf', markup: '<Probe class="a" style="color: red" />', errors: []},
  {fixture: 'components/svelte/root-props/ReadsProps.ucf', markup: `<Probe class={['a']} />`, errors: [2322]},
  {fixture: 'components/svelte/root-props/Destructures.ucf', markup: '<Probe style={1} />', errors: [2322]},
  // No forwarding: the props type is the author's alone.
  {fixture: 'components/svelte/roots/MultiRoot.ucf', markup: '<Probe class="a" />', errors: [2353]},
  {fixture: 'components/svelte/roots/LegacyRoot.ucf', markup: '<Probe class="a" />', errors: [2353]},
];

describe('the root props in the Svelte types, in tsserver with our plugin', () => {
  let server: Tsserver;

  beforeAll(async () => {
    server = startTsserver({cwd: APP_DIR, plugins: [PLUGIN]});
    await open(server, [PARENT]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it("Parent.ucf type checks: Button and Note take the parent's class and style in every block", async () => {
    expect(await server.diagnostics(PARENT.filename)).toEqual([]);
  });

  it.each(PROBES)('$fixture: $markup', async ({fixture, markup, errors}) => {
    const needle = PARENT.source.slice(PARENT.source.indexOf(SVELTE_IMPORT), PARENT.source.indexOf(SVELTE_END));
    const probe = `${SVELTE_IMPORT}    import Probe from '../../${fixture}'\n${needle.slice(SVELTE_IMPORT.length)}    ${markup}\n`;
    const edited = PARENT.source.replace(needle, probe);
    const revert = await edit(server, PARENT, needle, probe);
    try {
      const diagnostics = await server.diagnostics(PARENT.filename);
      expect(codesOnLine(diagnostics, locate(edited, markup).line)).toEqual(errors);
      expect(diagnostics).toHaveLength(errors.length);
    } finally {
      await revert();
    }
  });
});
