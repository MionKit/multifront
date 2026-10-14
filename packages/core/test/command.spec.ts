import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {checkBlocks, findingOf, splitBlocks} from '@multifront/core';
// Relative path, not a dependency: @multifront/e2e depends on core.
import {listComponents, readComponent} from '../../e2e/fixtures/index.ts';
// tsserver's 1-based lines and offsets, worked out from the text alone.
import {offsetAt} from '../../e2e/editor/lib/tsserver.ts';

describe('findingOf', () => {
  const fixtures = listComponents('invalid').map((name) => {
    const {filename, source} = readComponent(name);
    const split = splitBlocks(source, filename);
    return {name, split, diagnostics: [...split.errors, ...checkBlocks(split)]};
  });

  it('has invalid fixtures with diagnostics to check', () => {
    expect(fixtures.flatMap(({diagnostics}) => diagnostics).length).toBeGreaterThan(fixtures.length);
  });

  it.each(fixtures)(
    'points every diagnostic of $name at its own text, 1-based, in the block holding it',
    ({split, diagnostics}) => {
      for (const diagnostic of diagnostics) {
        const finding = findingOf(diagnostic, split);
        const {line, column, end} = finding;
        expect(offsetAt(split.source, {line: line!, offset: column!}), diagnostic.message).toBe(diagnostic.start);
        expect(offsetAt(split.source, {line: end!.line, offset: end!.column}), diagnostic.message).toBe(diagnostic.end);
        const holder = split.blocks.find((block) => block.start <= diagnostic.start && diagnostic.start < block.end);
        expect(finding).toEqual({
          file: diagnostic.filename,
          line: diagnostic.line,
          column: diagnostic.column + 1,
          end,
          code: diagnostic.code,
          severity: diagnostic.severity,
          message: diagnostic.message,
          ...(holder && {block: holder.type}),
        });
      }
    }
  );
});

describe('runCommand', () => {
  // The child types its options with core's exported `CommandOption`.
  const script = fileURLToPath(new URL('command.child.ts', import.meta.url));
  const run = (...args: string[]) => {
    const {status, stdout, stderr} = spawnSync(process.execPath, [script, ...args], {encoding: 'utf8', timeout: 30_000});
    return {status, stdout, stderr};
  };

  it("lists the spec's own option beside --format and --help", () => {
    const {status, stdout, stderr} = run('--help');
    expect({status, stderr}).toEqual({status: 0, stderr: ''});
    expect(stdout).toContain('\n  --name <name>       who to greet\n  --format <format>   text or json (default: text)\n');
  });

  it('names every option on an unknown one, exit 2 and nothing on stdout', () => {
    expect(run('--nope')).toEqual({
      status: 2,
      stdout: '',
      stderr: "greet: unknown option '--nope'; use --name, --format or --help\n",
    });
  });
});
