import {describe, expect, it} from 'vitest';
import {TARGETS, getBlockKind, splitBlocks} from '@multifront/core';
import type {BlockTag, Diagnostic} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {listComponents, readComponent} from '../../e2e/fixtures/index.ts';
import {tsxSyntaxErrors} from './tsx.ts';

describe('splitBlocks on valid fixtures', () => {
  it('finds every valid fixture', () => {
    expect(listComponents()).toEqual([
      'Badge.ucf',
      'Button.ucf',
      'Card.ucf',
      'ComposesFrom.ucf',
      'Hello.ucf',
      'Panel.ucf',
      'ReactDefaultSpecifier.ucf',
      'TsxEdges.ucf',
    ]);
  });

  it('reads every attribute form', () => {
    const styleAttrs = (name: string) => splitBlocks(readComponent(name).source, name).styles.map((block) => block.attrs);
    expect(styleAttrs('Card.ucf')).toEqual([{module: true, lang: 'scss'}]);
    expect(styleAttrs('Button.ucf')).toEqual([{scoped: true}, {module: 'classes'}]);
    expect(styleAttrs('Panel.ucf')).toEqual([{scoped: true, lang: 'scss'}, {}]);
  });

  describe.each(listComponents())('%s', (name) => {
    const {filename, source} = readComponent(name);
    const split = splitBlocks(source, filename);

    it('returns blocks whose offsets point at their tags and content', () => {
      expect(split.errors).toEqual([]);
      expect(split.filename).toBe(filename);
      expect(split.source).toBe(source);
      expect(split.blocks.length).toBeGreaterThan(0);
      for (const block of split.blocks) {
        expect(source.slice(block.contentStart, block.contentEnd)).toBe(block.content);
        expect(source.slice(block.start, block.contentStart)).toMatch(new RegExp(`^<${block.type}(\\s[^]*)?>$`));
        expect(source.slice(block.contentEnd, block.end)).toMatch(new RegExp(`^</${block.type}\\s*>$`));
        expect(getBlockKind(block.type).tag).toBe(block.type);
      }
    });

    it('indexes blocks per type and picks the first block of each target', () => {
      expect(split.styles).toEqual(split.blocks.filter((block) => block.type === 'style'));
      split.styles.forEach((block, index) => expect(block.index).toBe(index));
      for (const target of TARGETS) {
        const ofTarget = split.blocks.filter((block) => block.type === target);
        ofTarget.forEach((block, index) => expect(block.index).toBe(index));
        expect(target in split.targets).toBe(ofTarget.length > 0);
        expect(split.targets[target]).toBe(ofTarget[0]);
      }
    });

    it('matches the block table snapshot', async () => {
      await expect(
        `${JSON.stringify(
          split.blocks.map(({content, ...table}) => table),
          null,
          2
        )}\n`
      ).toMatchFileSnapshot(`__snapshots__/split/${name}.json`);
    });

    it('never cuts a <react> block early', () => {
      for (const block of split.blocks.filter((candidate) => candidate.type === 'react')) {
        expect(tsxSyntaxErrors(block.content)).toEqual([]);
      }
    });
  });
});

interface InvalidCase {
  fixture: string;
  errors: Pick<Diagnostic, 'code' | 'line' | 'column'>[];
  blocks: BlockTag[];
}

// Written by hand from the fixture files.
const INVALID_CASES: InvalidCase[] = [
  {
    fixture: 'invalid/BrokenOpeningTags.ucf',
    errors: [
      {code: 'unclosed-block', line: 7, column: 0},
      {code: 'unclosed-block', line: 9, column: 0},
      {code: 'unclosed-block', line: 15, column: 0},
    ],
    blocks: ['react'],
  },
  {
    fixture: 'invalid/BrokenUnknownTags.ucf',
    errors: [
      {code: 'unknown-root-tag', line: 1, column: 0},
      {code: 'unknown-root-tag', line: 9, column: 0},
      {code: 'unknown-root-tag', line: 16, column: 0},
      {code: 'text-outside-block', line: 17, column: 2},
    ],
    blocks: ['react', 'style'],
  },
  {fixture: 'invalid/ComposesBrokenFile.ucf', errors: [], blocks: ['react', 'style']},
  {fixture: 'invalid/ComposesCycle.ucf', errors: [], blocks: ['react', 'style']},
  {fixture: 'invalid/ComposesMissingFile.ucf', errors: [], blocks: ['react', 'style']},
  {fixture: 'invalid/ComposesMissingPackage.ucf', errors: [], blocks: ['react', 'style']},
  {fixture: 'invalid/CssSyntaxError.ucf', errors: [], blocks: ['react', 'style']},
  {
    fixture: 'invalid/DuplicateReact.ucf',
    errors: [
      {code: 'duplicate-target', line: 7, column: 0},
      {code: 'duplicate-target', line: 13, column: 0},
    ],
    blocks: ['react', 'react', 'react', 'style'],
  },
  {fixture: 'invalid/DuplicateStyleModule.ucf', errors: [], blocks: ['react', 'style', 'style', 'style', 'style', 'style']},
  {fixture: 'invalid/MissingPreprocessor.ucf', errors: [], blocks: ['react', 'style']},
  {
    fixture: 'invalid/MixedErrors.ucf',
    errors: [{code: 'duplicate-target', line: 13, column: 0}],
    blocks: ['style', 'react', 'react'],
  },
  {
    fixture: 'invalid/ReactCloseInString.ucf',
    errors: [{code: 'text-outside-block', line: 3, column: 29}],
    blocks: ['react', 'style'],
  },
  {fixture: 'invalid/ReactNoDefault.ucf', errors: [], blocks: ['style', 'react']},
  {fixture: 'invalid/ReactSyntaxError.ucf', errors: [], blocks: ['react', 'style']},
  {fixture: 'invalid/ReactTypeOnlyDefault.ucf', errors: [], blocks: ['react', 'style']},
  {fixture: 'invalid/ReactTypeOnlyDefaultForms.ucf', errors: [], blocks: ['react', 'style']},
  {fixture: 'invalid/ScssPartialError.ucf', errors: [], blocks: ['react', 'style']},
  {fixture: 'invalid/ScssSyntaxError.ucf', errors: [], blocks: ['react', 'style']},
  {
    fixture: 'invalid/StrayClosingTag.ucf',
    errors: [{code: 'text-outside-block', line: 6, column: 0}],
    blocks: ['react', 'style'],
  },
  {fixture: 'invalid/StyleInSvelte.ucf', errors: [], blocks: ['svelte', 'style']},
  {fixture: 'invalid/StyleInVue.ucf', errors: [], blocks: ['vue', 'style']},
  {fixture: 'invalid/StylesOnly.ucf', errors: [{code: 'missing-target', line: 1, column: 0}], blocks: ['style', 'style']},
  {
    fixture: 'invalid/TextOutsideBlock.ucf',
    errors: [{code: 'text-outside-block', line: 7, column: 2}],
    blocks: ['react', 'style'],
  },
  {
    fixture: 'invalid/UnclosedComment.ucf',
    errors: [{code: 'text-outside-block', line: 7, column: 0}],
    blocks: ['react', 'style'],
  },
  {fixture: 'invalid/UnclosedReact.ucf', errors: [{code: 'unclosed-block', line: 1, column: 0}], blocks: ['style']},
  {
    fixture: 'invalid/UnknownRootTag.ucf',
    errors: [
      {code: 'unknown-root-tag', line: 7, column: 0},
      {code: 'unknown-root-tag', line: 11, column: 0},
    ],
    blocks: ['react', 'style'],
  },
  {fixture: 'invalid/UnknownStyleLang.ucf', errors: [], blocks: ['react', 'style', 'style', 'style']},
];

describe('splitBlocks on invalid fixtures', () => {
  const splitFixture = (name: string) => {
    const {filename, source} = readComponent(name);
    return splitBlocks(source, filename);
  };

  it('finds every invalid fixture', () => {
    expect(listComponents('invalid')).toEqual(INVALID_CASES.map((row) => row.fixture));
  });

  describe.each(INVALID_CASES)('$fixture', ({fixture, errors, blocks}) => {
    const split = splitFixture(fixture);
    const {source} = split;

    it('reports each mistake at its hand-written line and column', () => {
      expect(split.errors.map(({code, line, column}) => ({code, line, column}))).toEqual(errors);
    });

    it('keeps every readable block', () => {
      expect(split.blocks.map((block) => block.type)).toEqual(blocks);
      for (const block of split.blocks) {
        expect(source.slice(block.contentStart, block.contentEnd)).toBe(block.content);
        expect(source.slice(block.start, block.contentStart)).toMatch(new RegExp(`^<${block.type}(\\s[^]*)?>$`));
        expect(source.slice(block.contentEnd, block.end)).toMatch(new RegExp(`^</${block.type}\\s*>$`));
      }
    });

    it('gives every error a range in the file and the real position of its start', () => {
      for (const error of split.errors) {
        expect(error.severity).toBe('error');
        expect(error.filename).toBe(split.filename);
        expect(error.message).not.toMatch(/\n/);
        expect(0 <= error.start && error.start <= error.end && error.end <= source.length).toBe(true);
        const before = source.slice(0, error.start).split('\n');
        expect({line: error.line, column: error.column}).toEqual({line: before.length, column: before.at(-1)!.length});
      }
    });

    it('matches the errors snapshot', async () => {
      const table = split.errors.map((error) => ({...error, filename: fixture}));
      await expect(`${JSON.stringify(table, null, 2)}\n`).toMatchFileSnapshot(`__snapshots__/split/${fixture}.errors.json`);
    });
  });

  it('points at <react_old as one unknown tag, not a <react> block', () => {
    const split = splitFixture('invalid/UnknownRootTag.ucf');
    const oldTag = split.errors[1]!;
    expect(split.source.slice(oldTag.start, oldTag.end)).toBe('<react_old');
    expect(split.blocks.filter((block) => block.type === 'react')).toHaveLength(1);
  });

  it('keeps the first of three <react> blocks as the target and flags the others', () => {
    const split = splitFixture('invalid/DuplicateReact.ucf');
    expect(split.targets.react).toBe(split.blocks[0]);
    expect(split.errors.map((error) => error.start)).toEqual([split.blocks[1]!.start, split.blocks[2]!.start]);
  });

  it('keeps a <react> block that holds the closing tag of an unknown tag left open before it', () => {
    const split = splitFixture('invalid/BrokenUnknownTags.ucf');
    expect(split.targets.react?.content).toContain('</div>');
  });

  it('gives a doubled closing tag the generic advice, not the escape advice', () => {
    const [error] = splitFixture('invalid/StrayClosingTag.ucf').errors;
    expect(error!.message).not.toContain('<\\/');
  });

  it("tells the author to write '<\\/react>' when a string closes the block", () => {
    const [error] = splitFixture('invalid/ReactCloseInString.ucf').errors;
    expect(error!.message).toContain("'<\\/react>'");
  });

  it('points a missing target at the start of the file', () => {
    const [error] = splitFixture('invalid/StylesOnly.ucf').errors;
    expect(error).toMatchObject({start: 0, end: 0});
  });
});
