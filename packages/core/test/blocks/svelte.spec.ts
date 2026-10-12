import {readFileSync, readdirSync} from 'node:fs';
import {basename, sep} from 'node:path';
import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import type {AST} from 'svelte/compiler';
import {afterAll, describe, expect, it} from 'vitest';
import {checkBlocks, classMapId, locate, renameSvelteStyles, splitBlocks} from '@multifront/core';
import type {BuildContext, Diagnostic} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {FIXTURES_DIR, componentPath, listComponents, readComponent} from '../../../e2e/fixtures/index.ts';
import {loadServerModule, removeRendered, renderBuild, startTags, svelte, svelteBuild} from '../svelte/render.ts';

const ERRORS_DIR = 'svelte/errors';
const SHAPES_DIR = 'svelte/shapes';
const ATTR_IN_SVELTE = 'svelte/imports/AttrInSvelte.ucf';

const NO_STYLE = '<svelte> uses $style, but no <style module> exists; add one';

// Written by hand from the fixture files.
const ERROR_CASES: {fixture: string; errors: (Pick<Diagnostic, 'code' | 'line' | 'column'> & {text: string})[]}[] = [
  // A script that does not parse hides its framework attribute: Svelte's error is the one.
  {fixture: `${ERRORS_DIR}/ImportParseError.ucf`, errors: [{code: 'svelte-parse-error', line: 5, column: 2, text: ''}]},
  // `$:` and `$$props` are Svelte's own.
  {fixture: `${ERRORS_DIR}/Legacy.ucf`, errors: []},
  // `$style` reads `module="style"` as `$name` reads `module="name"`.
  {fixture: `${ERRORS_DIR}/ModuleNamedStyle.ucf`, errors: []},
  // Every kind of top-level store, `$`-named imports and types, property names, a `style` prop.
  {fixture: `${ERRORS_DIR}/NamedModule.ucf`, errors: []},
  {fixture: `${ERRORS_DIR}/Runes.ucf`, errors: []},
  {fixture: `${ERRORS_DIR}/StyleInHead.ucf`, errors: []},
  // `($style as …)` is a use.
  {
    fixture: `${ERRORS_DIR}/StyleWithoutModule.ucf`,
    errors: [
      {code: 'missing-style-module', line: 3, column: 22, text: '$style'},
      {code: 'missing-style-module', line: 4, column: 22, text: '$style'},
      {code: 'missing-style-module', line: 7, column: 14, text: '$style'},
    ],
  },
  {fixture: `${ERRORS_DIR}/TopLevelStyle.ucf`, errors: [{code: 'style-inside-target', line: 9, column: 2, text: '<style>'}]},
  // Svelte reads `title</h2>` as `title < /h2>…`, a regular expression that never ends.
  {fixture: `${ERRORS_DIR}/UnclosedBrace.ucf`, errors: [{code: 'svelte-parse-error', line: 5, column: 28, text: ''}]},
  // A computed key or member is a use.
  {
    fixture: `${ERRORS_DIR}/WrongModuleName.ucf`,
    errors: [
      {code: 'missing-style-module', line: 3, column: 20, text: '$theme'},
      {code: 'missing-style-module', line: 6, column: 14, text: '$style'},
      {code: 'missing-style-module', line: 7, column: 14, text: '$theme'},
      {code: 'missing-style-module', line: 8, column: 23, text: '$theme'},
      // A name on Object.prototype is no module.
      {code: 'missing-style-module', line: 9, column: 8, text: '$constructor'},
    ],
  },
];

describe('the <svelte> rules', () => {
  it('has a row for every fixture', () => {
    expect(listComponents(ERRORS_DIR)).toEqual(ERROR_CASES.map((row) => row.fixture));
  });

  describe.each(ERROR_CASES)('$fixture', async ({fixture, errors}) => {
    const {split, source, file, thrown: rules} = await svelteBuild(fixture);
    const block = split.targets.svelte!;

    it('reports each rule at its hand-written line, column and span, in source order', () => {
      expect(split.errors).toEqual([]);
      expect(rules.map(({code, line, column, start, end}) => ({code, line, column, text: source.slice(start, end)}))).toEqual(
        errors
      );
    });

    it('builds a .svelte file Svelte compiles when no rule fails', () => {
      expect(file?.ext).toBe(errors.length > 0 ? undefined : '.svelte');
      if (file) expect(() => svelte.compile(file.code, {generate: 'server', filename: `${fixture}.svelte.svelte`})).not.toThrow();
    });

    it('leaves the compiler rules out of checkBlocks', () => {
      expect(checkBlocks(split)).toEqual(rules.filter(({code}) => code === 'style-inside-target'));
    });

    it('gives the line and column of its start offset, inside the block, with a one-line message', () => {
      for (const diagnostic of rules) {
        expect(diagnostic.filename).toBe(split.filename);
        const before = source.slice(0, diagnostic.start).split('\n');
        expect({line: diagnostic.line, column: diagnostic.column}).toEqual({line: before.length, column: before.at(-1)!.length});
        expect(diagnostic.start).toBeGreaterThanOrEqual(block.contentStart);
        expect(diagnostic.end).toBeLessThanOrEqual(block.contentEnd);
        expect(diagnostic.message).toMatch(/^<(svelte|style)> [^\n]+$/);
        expect(diagnostic.message).not.toContain('https://');
      }
    });

    it('matches the diagnostics snapshot', async () => {
      const table = rules.map((diagnostic) => ({...diagnostic, filename: fixture}));
      await expect(`${JSON.stringify(table, null, 2)}\n`).toMatchFileSnapshot(`../__snapshots__/${fixture}.json`);
    });
  });

  it('names the module, or the store, a $name lacks', async () => {
    const noTheme = '<svelte> uses $theme, but no <style module="theme"> or store named theme exists';
    expect((await svelteBuild(`${ERRORS_DIR}/WrongModuleName.ucf`)).thrown.map(({message}) => message)).toEqual([
      noTheme,
      NO_STYLE,
      noTheme,
      noTheme,
      '<svelte> uses $constructor, but no <style module="constructor"> or store named constructor exists',
    ]);
    expect((await svelteBuild(`${ERRORS_DIR}/StyleWithoutModule.ucf`)).thrown.map(({message}) => message)).toEqual([
      NO_STYLE,
      NO_STYLE,
      NO_STYLE,
    ]);
  });

  it("passes on Svelte's own parse error text", async () => {
    const [error] = (await svelteBuild(`${ERRORS_DIR}/UnclosedBrace.ucf`)).thrown;
    expect(error!.message).toBe('<svelte> does not parse: Unterminated regular expression');
  });

  const OTHERS = readdirSync(componentPath(''), {recursive: true, encoding: 'utf8'})
    .map((name) => name.split(sep).join('/'))
    .filter((name) => name.endsWith('.ucf') && !/^(svelte\/errors|svelte\/shapes|svelte\/roots|invalid)\//.test(name))
    .filter((name) => name !== ATTR_IN_SVELTE)
    .filter((name) => readComponent(name).source.includes('<svelte>'))
    .sort();

  it('covers the other fixtures with a <svelte> block', () => {
    expect(OTHERS).toEqual(expect.arrayContaining(['Card.ucf', 'react/AllBlocks.ucf', 'editor/GrammarEdges.ucf']));
  });

  it.each(OTHERS)('builds %s, and Svelte compiles it', async (name) => {
    const {file, thrown} = await svelteBuild(name);
    expect(thrown).toEqual([]);
    expect(() => svelte.compile(file!.code, {generate: 'server', filename: `${name}.svelte.svelte`})).not.toThrow();
  });

  // Written by hand from the fixture: the module script has no `lang`, and holds TypeScript as Svelte reads it.
  it(`reports framework-in-block on each framework attribute of a top-level script in ${ATTR_IN_SVELTE}`, async () => {
    const {split, source, thrown} = await svelteBuild(ATTR_IN_SVELTE);
    expect(split.errors).toEqual([]);
    expect(thrown.map(({code, line, column, start, end}) => ({code, line, column, text: source.slice(start, end)}))).toEqual([
      {code: 'framework-in-block', line: 3, column: 71, text: "framework: 'svelte'"},
      {code: 'framework-in-block', line: 8, column: 51, text: "framework: 'react'"},
      {code: 'framework-in-block', line: 10, column: 58, text: "framework: 'svelte'"},
    ]);
    expect(thrown.every(({message}) => message.includes('<svelte> block; imports there always get svelte'))).toBe(true);
    expect(checkBlocks(split)).toEqual(thrown);
  });

  // The one in markup is left to the post rewrite of the compiled module.
  it.each(['svelte/imports/AttrInSvelteMarkup.ucf', 'svelte/imports/UsesReactOnly.ucf', 'Panel.ucf', 'imports/UsesIcon.ucf'])(
    'reports no framework-in-block for %s',
    (name) => {
      const {filename, source} = readComponent(name);
      expect(checkBlocks(splitBlocks(source, filename))).toEqual([]);
    }
  );
});

type Node = AST.BaseNode & Record<string, unknown>;

function namedNodes(root: AST.Root): {node: Node; inHead: boolean}[] {
  const found: {node: Node; inHead: boolean}[] = [];
  const visit = (value: unknown, inHead: boolean): void => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, inHead));
    if (typeof value !== 'object' || value === null) return;
    const node = value as Node;
    if (typeof node.type === 'string' && typeof node.name === 'string' && 'fragment' in node) found.push({node, inHead});
    const head = inHead || node.type === 'SvelteHead';
    for (const child of Object.values(node)) if (typeof child === 'object' && child !== null) visit(child, head);
  };
  visit(root.fragment, false);
  return found.sort((first, second) => first.node.start - second.node.start);
}

const STAMPED = new Set(['RegularElement', 'SvelteElement', 'Component', 'SvelteComponent', 'SvelteSelf']);

function offsetOf(text: string, line: number, column: number): number {
  return text.split('\n', line - 1).join('\n').length + (line > 1 ? 1 : 0) + column;
}

// Matches both our CSS imports and our class map imports.
const IMPORT = String.raw`import (?:(__ucf\w+) from )?"([^"\n]*\?ucf&type=style&[^"\n]*)";`;

// The forwarding edits: the helper import, the spread, the added rest, the dev warning.
const HELPER_IMPORT = String.raw`import \{__ucf\w+(?:, __ucf\w+)*\} from "virtual:multifront/scope-attrs";`;
const FORWARD_LINE = String.raw`(?:let __ucfRest\d* = \$props\(\);|const __ucfProps\d* = \$derived\(\w+\);|;\(?(?:\(\) => )?__ucfWarnFragment\(.*\);)`;

function undoBuild(code: string, ctx: BuildContext): string {
  const names = new Map<string, string>();
  for (const [, local, id] of code.matchAll(new RegExp(IMPORT, 'g'))) {
    const module = Object.values(ctx.modules).find((candidate) => candidate.id === id);
    if (local && module) names.set(local, module.name === '$style' ? '$style' : `$${module.name}`);
  }
  const line = `(?:${IMPORT}|${HELPER_IMPORT}|${FORWARD_LINE})`;
  return code
    .replaceAll(` data-v-${ctx.scopeId}=""`, '')
    .replaceAll(/ \{\.\.\.__ucfScopeAttrs\(\w+\)\}/g, '')
    .replaceAll(/(?:, | |)\.\.\.__ucfRest\d*(?=\s*\})/g, '')
    .replace(new RegExp(String.raw`^<script>\n(?:${line}\n)*${line}\n</script>`), '')
    .replaceAll(new RegExp(String.raw`\n${line}`, 'g'), '')
    .replaceAll(/(\$\w+)=\{__ucf\w+\}/g, '{$1}')
    .replaceAll(/(\$\w+): __ucf\w+/g, '$1')
    .replaceAll(/__ucf\w+/g, (local) => names.get(local) ?? local);
}

afterAll(removeRendered);

async function childComponent(): Promise<unknown> {
  const filename = componentPath(`${SHAPES_DIR}/Child.svelte`);
  const {js} = svelte.compile(readFileSync(filename, 'utf8'), {generate: 'server', filename});
  return loadServerModule('Child', js.code);
}

// Hand-read from the fixtures; `script`: where the imports land.
type Shape = {fixture: string; script: 'module' | 'instance' | 'added'; child?: true};

const SHAPES: Shape[] = (
  [
    {fixture: 'AttributeGt.ucf', script: 'added'},
    {fixture: 'AwaitBlock.ucf', script: 'instance'},
    // Both scripts, `$style` in the module one: only there do the imports reach it.
    {fixture: 'BothScripts.ucf', script: 'module'},
    {fixture: 'Boundary.ucf', script: 'added'},
    {fixture: 'CommentedTag.ucf', script: 'added'},
    {fixture: 'Components.ucf', script: 'instance', child: true},
    {fixture: 'EachBlock.ucf', script: 'instance'},
    {fixture: 'Elements.ucf', script: 'instance'},
    {fixture: 'IfBlock.ucf', script: 'instance'},
    {fixture: 'KeyBlock.ucf', script: 'instance'},
    {fixture: 'LessThan.ucf', script: 'instance'},
    // An import in the instance script would not reach `$style` in `<script module>`.
    {fixture: 'ModuleScriptOnly.ucf', script: 'module'},
    {fixture: 'NoScript.ucf', script: 'added'},
    {fixture: 'ScriptString.ucf', script: 'instance'},
    {fixture: 'Slots.ucf', script: 'instance', child: true},
    {fixture: 'Snippets.ucf', script: 'instance'},
    {fixture: 'SpecialElements.ucf', script: 'instance'},
    {fixture: 'SvelteComponent.ucf', script: 'instance', child: true},
    {fixture: 'SvelteElement.ucf', script: 'instance'},
  ] satisfies Shape[]
).map((row) => ({...row, fixture: `${SHAPES_DIR}/${row.fixture}`}));

it('has a row for every svelte/shapes/ fixture', () => {
  expect(listComponents(SHAPES_DIR)).toEqual(SHAPES.map(({fixture}) => fixture));
});

describe.each(SHAPES)('svelte.build of $fixture', async ({fixture, script, child}) => {
  const {split, source, ctx, file} = await svelteBuild(fixture);
  const block = split.targets.svelte!;
  const stamp = `data-v-${ctx.scopeId}`;
  const output = svelte.parse(file!.code, {modern: true});
  const input = svelte.parse(block.content, {modern: true});
  const stampsOf = (node: Node) => (node.attributes as Node[]).filter(({type, name}) => type === 'Attribute' && name === stamp);

  it('is a scoped, valid fixture that builds a .svelte file', () => {
    expect(checkBlocks(split)).toEqual([]);
    expect(ctx.hasScoped).toBe(true);
    expect(file!.ext).toBe('.svelte');
  });

  it('compiles with no warning and no Svelte CSS, on the server and the client', () => {
    for (const generate of ['server', 'client'] as const) {
      const result = svelte.compile(file!.code, {generate, filename: `${ctx.filename}.svelte.svelte`});
      expect(result.warnings.map(({code, message}) => `${code}: ${message}`)).toEqual([]);
      expect(result.css).toBeNull();
    }
    expect(output.css).toBeNull();
  });

  it('matches the code snapshot', async () => {
    const code = file!.code.replaceAll(FIXTURES_DIR, '<fixtures>');
    await expect(code).toMatchFileSnapshot(`../__snapshots__/${fixture}.svelte.snap`);
  });

  it('only inserts: without the stamps and imports, and with the renames undone, the code is the block content', () => {
    expect(undoBuild(file!.code, ctx)).toBe(block.content);
  });

  it('stamps every element and component once, nothing else, nothing in <svelte:head>', () => {
    const before = namedNodes(input);
    const after = namedNodes(output);
    expect(after.map(({node}) => node.name)).toEqual(before.map(({node}) => node.name));
    for (const {node, inHead} of after) {
      expect(stampsOf(node).length, `${node.type} ${node.name}`).toBe(STAMPED.has(node.type) && !inHead ? 1 : 0);
    }
    expect(after.some(({node}) => STAMPED.has(node.type))).toBe(true);
  });

  it(`imports the CSS and the used class map in the ${script} script`, () => {
    const scripts = {module: output.module, instance: output.instance};
    const target = script === 'module' ? output.module : output.instance;
    const imports = target!.content.body.flatMap((node) => (node.type === 'ImportDeclaration' ? [node.source.value] : []));
    expect(imports).toEqual(expect.arrayContaining([...ctx.styles.map(({id}) => id), classMapId(ctx.filename, 0)]));
    if (script === 'added') {
      const {start, end} = target!.content as unknown as AST.BaseNode;
      const lines = file!.code.slice(start, end).split('\n').filter(Boolean);
      const own = lines.filter((line) => new RegExp(`^${IMPORT}$`).test(line));
      expect(own).toHaveLength(ctx.styles.length + 1);
      // Any other line of the added script is a forwarding one.
      const forwarding = new RegExp(`^(?:${HELPER_IMPORT}|${FORWARD_LINE})$`);
      for (const line of lines.filter((candidate) => !own.includes(candidate))) expect(line).toMatch(forwarding);
    }
    const other = script === 'module' ? scripts.instance : scripts.module;
    expect(other ? file!.code.slice(other.start, other.end) : '').not.toMatch(/\?ucf&type=style&/);
  });

  it('maps the text after each stamp, and its forwarding spread, to the end of the element name, and each local to its $name', () => {
    const map = new TraceMap(file!.map!);
    const before = namedNodes(input);
    namedNodes(output).forEach(({node}, index) => {
      const [attribute] = stampsOf(node);
      if (!attribute) return;
      const spread = /^ \{\.\.\.__ucfScopeAttrs\(\w+\)\}/.exec(file!.code.slice(attribute.end))?.[0] ?? '';
      const original = originalPositionFor(map, locate(file!.code, attribute.end + spread.length));
      const {node: from} = before[index]!;
      const nameEnd = block.contentStart + from.start + 1 + (from.name as string).length;
      expect({line: original.line, column: original.column}).toEqual(locate(source, nameEnd));
    });
    const imported = [...file!.code.matchAll(/^import (__ucf\w+) from /gm)].map(([, local]) => local);
    const locals = [...file!.code.matchAll(/(?<![\w"])__ucf\w+\b(?! from)/g)].filter(([local]) => imported.includes(local));
    expect(locals.length).toBeGreaterThan(0);
    for (const local of locals) {
      const original = originalPositionFor(map, locate(file!.code, local.index));
      const at = source.slice(offsetOf(source, original.line!, original.column!));
      expect(at).toMatch(/^\$style\b/);
    }
  });

  it('renders every element from the block with the scope once and only module class names', async () => {
    const props = child ? {Child: await childComponent()} : {};
    const {body, head} = await renderBuild(file!, ctx, basename(fixture, '.ucf'), props);
    const tags = startTags(body, stamp);
    expect(tags.length).toBeGreaterThan(0);
    for (const {name, stamps} of tags) expect(stamps, name).toBe(1);
    expect(head).not.toContain('data-v-');
    const generated = new Set(Object.values(ctx.modules).flatMap(({classes}) => Object.values(classes)));
    const classes = tags.flatMap((tag) => tag.classes);
    expect(classes.length).toBeGreaterThan(0);
    for (const name of classes) expect(generated, name).toContain(name);
    expect(body).not.toMatch(/svelte-/);
    await expect(`${head}\n${body}\n`).toMatchFileSnapshot(`../__snapshots__/${fixture}.html`);
  });
});

describe('svelte.build of the other fixtures', () => {
  it('renames only the class maps: stores, runes, property, import, export and type names stay', async () => {
    const {file} = await svelteBuild(`${ERRORS_DIR}/NamedModule.ucf`);
    const dollars = [...new Set(file!.code.match(/\$\w+/g))].sort();
    expect(dollars).toEqual(
      [
        '$Props',
        '$Row',
        '$Store',
        '$count',
        '$derived',
        '$exported',
        '$extra',
        '$fetch',
        '$first',
        '$makeStore',
        '$others',
        '$props',
        '$second',
        '$shared',
        '$state',
        '$theme',
        '$user',
      ].sort()
    );
    expect(file!.code.match(/__ucfClasses\b/g)).toHaveLength(3);
    expect(file!.code.match(/__ucfStyle\b/g)).toHaveLength(2);
    // No `<style scoped>`: no stamp.
    expect(file!.code).not.toContain('data-v-');
  });

  it('gives the local a number suffix when the block already uses its name', async () => {
    const {file} = await svelteBuild(`${SHAPES_DIR}/Elements.ucf`);
    expect(file!.code).toMatch(/^import __ucfStyle1 from /m);
    expect(file!.code).toContain("const __ucfStyle = 'own'");
    expect(file!.code).toContain('class={__ucfStyle1.card}');
  });

  it('leaves a block with nothing to import or stamp, and no rune or legacy syntax, as written', async () => {
    for (const production of [false, true]) {
      const {split, ctx, file} = await svelteBuild('svelte/NoStyle.ucf', production);
      expect(ctx.styles).toEqual([]);
      expect(file!.code).toBe(split.targets.svelte!.content);
    }
  });

  it('gives $style the module="style" class map when there is no bare <style module>', async () => {
    const {ctx, file} = await svelteBuild(`${ERRORS_DIR}/ModuleNamedStyle.ucf`);
    expect(file!.code).toContain(`import __ucfStyle from ${JSON.stringify(classMapId(ctx.filename, 0))};`);
  });
});

// The rename the editor's script (M5 5.9) and the library build share with build(): same locals, same `.ucf` offsets.
describe('renameSvelteStyles matches the rename of build()', () => {
  const FIXTURES = readdirSync(componentPath(''), {recursive: true, encoding: 'utf8'})
    .map((name) => name.split(sep).join('/'))
    .filter((name) => name.endsWith('.ucf') && !name.startsWith('invalid/'))
    .filter((name) => readComponent(name).source.includes('<svelte>'))
    .sort();
  // build() rejects these, so they have no rename to ship.
  const REJECTED = [
    `${ERRORS_DIR}/ImportParseError.ucf`,
    `${ERRORS_DIR}/StyleWithoutModule.ucf`,
    `${ERRORS_DIR}/TopLevelStyle.ucf`,
    `${ERRORS_DIR}/UnclosedBrace.ucf`,
    `${ERRORS_DIR}/WrongModuleName.ucf`,
    ATTR_IN_SVELTE,
  ];

  // `<.ucf offset> <local>` for each use of a class map local in `code`, read back through its map.
  function uses(code: string, map: TraceMap, locals: string[], source: string): string[] {
    const found: string[] = [];
    for (const local of locals) {
      for (const match of code.matchAll(new RegExp(String.raw`(?<![\w$"])${local}\b(?! from )`, 'g'))) {
        const {line, column} = originalPositionFor(map, locate(code, match.index));
        found.push(`${line === null ? 'unmapped' : offsetOf(source, line, column!)} ${local}`);
      }
    }
    return found.sort();
  }

  it('covers the shared fixtures and the svelte/ ones', () => {
    expect(FIXTURES).toEqual(expect.arrayContaining(['Panel.ucf', 'PanelItem.ucf', 'Counter.ucf', `${SHAPES_DIR}/Elements.ucf`]));
  });

  it.each(FIXTURES)('%s', async (name) => {
    const {split, source, ctx, file: built} = await svelteBuild(name);
    if (!built) return expect(REJECTED).toContain(name);
    const renamed = renameSvelteStyles(split.targets.svelte!, split, svelte, ctx.modules);

    const ids = new Set(Object.values(ctx.modules).map(({id}) => id));
    const imported = [...built.code.matchAll(/^import (__ucf\w+) from "([^"]+)";$/gm)].filter(([, , id]) => ids.has(id!));
    const builtLocals = Object.fromEntries(imported.map(([, local, id]) => [id!, local!]));
    const renamedLocals = Object.fromEntries([...renamed.locals].map(([module, local]) => [module.id, local]));
    expect(renamedLocals).toEqual(builtLocals);

    const locals = Object.values(builtLocals);
    const builtUses = uses(built.code, new TraceMap(built.map!), locals, source);
    const renameMap = new TraceMap({version: 3, sources: [ctx.filename], names: [], mappings: renamed.mappings});
    expect(uses(renamed.code, renameMap, locals, source)).toEqual(builtUses);
    for (const use of builtUses) expect(source.slice(Number(use.split(' ')[0])), use).toMatch(/^\$\w/);
  });
});
