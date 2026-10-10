import {readdirSync, readFileSync} from 'node:fs';
import {join, sep} from 'node:path';
import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import {Visitor, parseSync} from 'oxc-parser';
import type {Expression, ImportAttribute, ObjectExpression} from 'oxc-parser';
import {describe, expect, it} from 'vitest';
import {rewriteImportAttributes} from '@multifront/core';
// Relative paths, not a package dependency: @multifront/e2e depends on core.
import {EXPECTED_IMPORTS} from '../../../e2e/fixtures/apps/imports/expected.ts';
import {FIXTURES_DIR} from '../../../e2e/fixtures/index.ts';
import {lineAt, scriptName, scriptsOf} from './readImports.ts';
import type {Script} from './readImports.ts';

const APPS = join(FIXTURES_DIR, 'apps');
// Every other test parses its input: this one is the rewrite's own input that does not.
const SYNTAX_ERROR = 'syntax-error.mjs';
// The value every unknown-framework row of expected.ts uses.
const UNKNOWN_FRAMEWORK = 'angular';

interface Input {
  key: string; // from fixtures/apps, '/' separators
  filename: string;
  source: string; // the whole file
  script: Script;
}

function filesOf(app: string, pattern: RegExp): string[] {
  return readdirSync(join(APPS, app), {recursive: true, encoding: 'utf8'})
    .map((path) => path.split(sep).join('/'))
    .filter((file) => pattern.test(file) && file !== 'expected.ts')
    .sort();
}

// `.ucf` importers are left out: block imports never go through the rewrite (an attribute there is framework-in-block).
const INPUTS: Input[] = [
  ...filesOf('imports', /\.(ts|tsx|jsx|vue|svelte)$/).map((file) => `imports/${file}`),
  ...filesOf('rewrite-edges', /\.m?js$/)
    .filter((file) => file !== SYNTAX_ERROR)
    .map((file) => `rewrite-edges/${file}`),
].flatMap((key) => {
  const filename = join(APPS, key);
  const source = readFileSync(filename, 'utf8');
  return scriptsOf(filename, source).map((script) => ({key, filename, source, script}));
});

function rewrite({filename, script}: Input) {
  return rewriteImportAttributes(script.code, scriptName(filename, script));
}

function keyName(key: ImportAttribute['key'] | ObjectExpression['properties'][number]): string | undefined {
  const node = 'type' in key && key.type === 'Property' ? (key.computed ? undefined : key.key) : key;
  if (!node || node.type === 'SpreadElement') return undefined;
  if (node.type === 'Identifier') return node.name;
  return node.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
}

// Also with a query: the rewritten specifiers are no `.ucf` imports to the rewrite itself.
function ucfSpecifier(node: Expression | null): string | undefined {
  let value: string | undefined;
  if (node?.type === 'Literal' && typeof node.value === 'string') value = node.value;
  else if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) value = node.quasis[0]!.value.cooked ?? undefined;
  return value?.split('?')[0]!.endsWith('.ucf') ? value : undefined;
}

interface Found {
  specifier: string;
  keys: string[] | null; // its attribute keys; null for options the code does not spell out
}

/** Every `.ucf` import, in source order, read straight from the AST. */
function ucfImports(code: string, lang: Script['lang']): Found[] {
  const {program, errors} = parseSync(`file.${lang}`, code, {lang, sourceType: 'module'});
  expect(errors).toEqual([]);
  const found: Found[] = [];
  const fromStatic = (node: {source: Expression | null; attributes: ImportAttribute[]}) => {
    const specifier = ucfSpecifier(node.source);
    if (specifier) found.push({specifier, keys: node.attributes.map((attribute) => keyName(attribute.key)!)});
  };
  const optionKeys = (options: Expression | null): string[] | null => {
    if (!options) return [];
    if (options.type !== 'ObjectExpression') return null;
    const withProp = options.properties.find((prop) => keyName(prop) === 'with');
    if (!withProp || withProp.type !== 'Property') return [];
    const {value} = withProp;
    return value.type === 'ObjectExpression' ? value.properties.map((prop) => keyName(prop) ?? '<not literal>') : null;
  };
  new Visitor({
    ImportDeclaration: fromStatic,
    ExportNamedDeclaration: fromStatic,
    ExportAllDeclaration: fromStatic,
    ImportExpression: (node) => {
      const specifier = ucfSpecifier(node.source);
      if (specifier) found.push({specifier, keys: optionKeys(node.options)});
    },
  }).visit(program);
  return found;
}

/** What the attribute must turn into, from the rows of expected.ts. */
function expectedFramework(file: string, line: number): string | undefined {
  const row = EXPECTED_IMPORTS.find((entry) => entry.file === file && entry.line === line);
  if (!row) throw new Error(`no expected.ts row for ${file}:${line}`);
  if ('rule' in row) return row.rule === 'attribute' ? row.expect : undefined;
  return row.expect === 'unknown-framework' ? UNKNOWN_FRAMEWORK : undefined;
}

describe('rewriteImportAttributes over the importer fixtures', () => {
  describe.each(INPUTS.map((input) => [input.key, input] as const))('%s', (key, input) => {
    const result = rewrite(input);
    const {lang} = input.script;

    it('matches the snapshot', async () => {
      const errors = result.errors.map((error) => ({...error, filename: key}));
      const snapshot = `${JSON.stringify({code: result.code, imports: result.imports, errors}, null, 2)}\n`;
      await expect(snapshot).toMatchFileSnapshot(`../__snapshots__/rewrite/${key}.json`);
    });

    it('moves exactly the framework attribute into the specifier', () => {
      const before = ucfImports(input.script.code, lang);
      const after = ucfImports(result.code, lang);
      expect(before.map(({specifier}) => specifier)).toEqual(result.imports.map(({specifier}) => specifier));
      expect(after).toHaveLength(before.length);
      result.imports.forEach((entry, index) => {
        const {framework, specifier} = entry;
        const [path, query] = after[index]!.specifier.split('?');
        expect(path).toBe(specifier);
        if (framework === undefined) expect(query).toBeUndefined();
        // A lone surrogate cannot be URI-encoded: it becomes U+FFFD, as String#toWellFormed does.
        else expect(new URLSearchParams(query).get('framework')).toBe(framework.replace(/[\uD800-\uDFFF]/gu, '\uFFFD'));
        const {keys} = before[index]!;
        expect(after[index]!.keys).toEqual(keys && framework !== undefined ? keys.filter((name) => name !== 'framework') : keys);
        if (input.key.startsWith('imports/')) {
          expect(framework).toBe(
            expectedFramework(input.key.slice('imports/'.length), lineAt(input.source, input.script.offset + entry.start))
          );
        }
      });
    });

    it('a second run changes nothing', () => {
      const second = rewriteImportAttributes(result.code, scriptName(input.filename, input.script));
      expect(second.code).toBe(result.code);
      expect(second.map).toBeNull();
      expect(second.errors.map(({code, message}) => ({code, message}))).toEqual(
        result.errors.map(({code, message}) => ({code, message}))
      );
    });

    it('maps every statement and identifier back to the same text', () => {
      if (!result.map) return expect(result.code).toBe(input.script.code);
      const map = new TraceMap(result.map);
      const sourceLines = input.script.code.split('\n');
      const {program} = parseSync(`file.${lang}`, result.code, {lang, sourceType: 'module'});
      // A statement by its first keyword: export-all.ts has no identifier at all.
      const tokens = program.body.map(({start}) => ({start, text: /^\w+/.exec(result.code.slice(start))![0]}));
      new Visitor({Identifier: ({start, name}) => void tokens.push({start, text: name})}).visit(program);
      for (const {start, text} of tokens) {
        const before = result.code.slice(0, start).split('\n');
        const original = originalPositionFor(map, {line: before.length, column: before.at(-1)!.length});
        expect(original.line, text).not.toBeNull();
        expect(sourceLines[original.line! - 1]!.slice(original.column!, original.column! + text.length)).toBe(text);
      }
    });
  });
});

describe('rewriteImportAttributes, hand-written cases', () => {
  const input = (key: string) => INPUTS.find((entry) => entry.key === key)!;

  it('no-default/non-literal.ts: framework-attribute-not-literal on the shorthand value, code unchanged', () => {
    const result = rewrite(input('imports/no-default/non-literal.ts'));
    expect(result.code).toBe(input('imports/no-default/non-literal.ts').script.code);
    expect(result.map).toBeNull();
    expect(result.errors).toMatchObject([
      {
        code: 'framework-attribute-not-literal',
        severity: 'error',
        message: "the framework attribute must be a string literal: with {framework: 'react'} (or vue, svelte)",
        line: 2,
        column: 73,
      },
    ]);
  });

  it('rewrite-edges/not-literal-options.js: options it cannot read are errors', () => {
    const result = rewrite(input('rewrite-edges/not-literal-options.js'));
    const message = 'import() options of a .ucf import must be an object literal, so multifront can read its framework attribute';
    expect(result.errors.map(({code, line, column, message: text}) => ({code, line, column, text}))).toEqual(
      [
        [4, 70],
        [5, 77],
        [6, 71],
        [7, 73],
      ].map(([line, column]) => ({code: 'framework-attribute-not-literal', line, column, text: message}))
    );
    expect(result.imports.map(({framework}) => framework)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it(`rewrite-edges/${SYNTAX_ERROR}: a file that does not parse comes back untouched`, () => {
    const source = readFileSync(join(APPS, 'rewrite-edges', SYNTAX_ERROR), 'utf8');
    expect(rewriteImportAttributes(source, SYNTAX_ERROR)).toEqual({code: source, map: null, imports: [], errors: []});
  });

  it('no-default/strings-and-comments.ts: .ucf in strings and comments is left alone', () => {
    const {script} = input('imports/no-default/strings-and-comments.ts');
    expect(rewrite(input('imports/no-default/strings-and-comments.ts'))).toEqual({
      code: script.code,
      map: null,
      imports: [],
      errors: [],
    });
  });
});
