import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import type {Statement} from 'oxc-parser';
import {SourceMapConsumer} from 'source-map-js';
import type {RawSourceMap} from 'source-map-js';
import {createLogger} from 'vite';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {LIBRARY_DIR} from '../fixtures/index.ts';
import {
  LIBRARY_CLIENT,
  buildFixtureLibrary,
  parseOutput,
  readOutput,
  resultOf,
  specifiersOf,
  withEditedLibrary,
} from './lib/library.ts';
import type {BuiltLibrary} from './lib/library.ts';

let library: BuiltLibrary;
const warnings: string[] = [];

beforeAll(async () => {
  const logger = createLogger('silent');
  logger.warn = (message) => void warnings.push(message);
  logger.warnOnce = logger.warn;
  library = await buildFixtureLibrary(LIBRARY_DIR, {vite: {customLogger: logger}});
});

afterAll(async () => {
  await library?.remove();
});

function statementsOf(file: string, code: string): Statement[] {
  return parseOutput(file, code).program.body;
}

// Directive or not, so a second one below an import counts too.
function useClientCount(statements: Statement[]): number {
  return statements.filter(
    (statement) =>
      statement.type === 'ExpressionStatement' &&
      statement.expression.type === 'Literal' &&
      statement.expression.value === 'use client'
  ).length;
}

function startsWithUseClient(statements: Statement[]): boolean {
  const [first] = statements;
  return first?.type === 'ExpressionStatement' && first.directive === 'use client';
}

describe('buildLibrary(): "use client" per output file', () => {
  it('starts each client component with the directive, once, then its CSS import', () => {
    const result = resultOf(library.results, 'react');
    for (const name of LIBRARY_CLIENT) {
      const file = `${name}.js`;
      const statements = statementsOf(file, readOutput(result, file));
      expect(startsWithUseClient(statements), file).toBe(true);
      expect(useClientCount(statements), file).toBe(1);
      const second = statements[1];
      expect(second?.type === 'ImportDeclaration' && second.source.value, file).toBe(`./${name}.css`);
    }
  });

  it('leaves every other output file without it, in React and Vue', () => {
    const result = resultOf(library.results, 'react');
    const others = result.files
      .filter((file) => file.endsWith('.js'))
      .filter((file) => !LIBRARY_CLIENT.includes(file.slice(0, -'.js'.length)));
    for (const expected of ['Card.js', 'Panel.js', 'hooks/useToggle.js', 'index.js', 'utils/cx.js'])
      expect(others).toContain(expected);
    expect(others.some((file) => file.startsWith('_virtual/'))).toBe(true);
    for (const file of others) expect(useClientCount(statementsOf(file, readOutput(result, file))), `react/${file}`).toBe(0);
    const vue = resultOf(library.results, 'vue');
    for (const file of vue.files.filter((name) => name.endsWith('.js')))
      expect(useClientCount(statementsOf(file, readOutput(vue, file))), `vue/${file}`).toBe(0);
  });

  it('maps the code of react/Counter.js to its lines in Counter.front after the shift', () => {
    const result = resultOf(library.results, 'react');
    const code = readOutput(result, 'Counter.js');
    const consumer = new SourceMapConsumer(JSON.parse(readOutput(result, 'Counter.js.map')) as RawSourceMap);
    const before = code.slice(0, code.indexOf('useState(0)')).split('\n');
    const original = consumer.originalPositionFor({line: before.length, column: before.at(-1)!.length});
    const frontFile = join(LIBRARY_DIR, 'src', 'Counter.front');
    expect(resolve(dirname(join(result.outDir, 'Counter.js.map')), original.source)).toBe(frontFile);
    const front = readFileSync(frontFile, 'utf8');
    expect(original.line).toBe(
      front.slice(0, front.indexOf('useState(0)', front.indexOf('<react lang="tsx">'))).split('\n').length
    );
  });

  it('logs no warning', () => {
    expect(warnings).toEqual([]);
  });

  it("keeps a plain module's own directive first, and adds it to a client component without CSS", async () => {
    const toggle = readFileSync(join(LIBRARY_DIR, 'src', 'hooks', 'useToggle.ts'), 'utf8');
    const clicker =
      '<vue lang="vue">\n  <template><button>click</button></template>\n</vue>\n\n' +
      '<react lang="tsx">\n  export default function Clicker() {\n    return <button onClick={() => alert(1)}>click</button>\n  }\n</react>\n';
    const edits = [
      {file: 'src/hooks/useToggle.ts', content: `'use client';\n${toggle}`},
      {file: 'src/Clicker.front', content: clicker},
    ];
    await withEditedLibrary(edits, async (root) => {
      const built = await buildFixtureLibrary(root, {frameworks: ['react']});
      try {
        const result = resultOf(built.results, 'react');
        for (const file of ['hooks/useToggle.js', 'Clicker.js']) {
          const statements = statementsOf(file, readOutput(result, file));
          expect(startsWithUseClient(statements), file).toBe(true);
          expect(useClientCount(statements), file).toBe(1);
        }
        expect(result.files).not.toContain('Clicker.css');
        expect(
          specifiersOf('Clicker.js', readOutput(result, 'Clicker.js')).filter((specifier) => specifier.endsWith('.css'))
        ).toEqual([]);
      } finally {
        await built.remove();
      }
    });
  });
});
