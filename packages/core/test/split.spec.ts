import {describe, expect, it} from 'vitest';
import {TARGETS, getBlockKind, splitBlocks} from '@multifront/core';
import type {BlockTag, Diagnostic} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {listComponents, readComponent} from '../../e2e/fixtures/index.ts';
import {tsxSyntaxErrors} from './tsx.ts';

describe('splitBlocks on valid fixtures', () => {
  it('finds every valid fixture', () => {
    expect(listComponents()).toEqual([
      'Badge.front',
      'Button.front',
      'Card.front',
      'ComposesFrom.front',
      'ComposesScoped.front',
      'Counter.front',
      'Hello.front',
      'Note.front',
      'Panel.front',
      'PanelItem.front',
      'ReactDefaultSpecifier.front',
      'ScopedModuleScss.front',
      'TsxEdges.front',
    ]);
  });

  it('reads every attribute form', () => {
    const styleAttrs = (name: string) => splitBlocks(readComponent(name).source, name).styles.map((block) => block.attrs);
    expect(styleAttrs('Card.front')).toEqual([{module: true, lang: 'scss'}]);
    expect(styleAttrs('Button.front')).toEqual([{scoped: true}, {module: 'classes'}]);
    expect(styleAttrs('Panel.front')).toEqual([{scoped: true, lang: 'scss'}, {}, {module: true, lang: 'scss'}]);
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
  {fixture: 'invalid/BlockLang.front', errors: [], blocks: ['vue', 'svelte', 'react']},
  {
    fixture: 'invalid/BrokenOpeningTags.front',
    errors: [
      {code: 'unclosed-block', line: 7, column: 0},
      {code: 'unclosed-block', line: 9, column: 0},
      {code: 'unclosed-block', line: 15, column: 0},
    ],
    blocks: ['react'],
  },
  {
    fixture: 'invalid/BrokenUnknownTags.front',
    errors: [
      {code: 'unknown-root-tag', line: 1, column: 0},
      {code: 'unknown-root-tag', line: 9, column: 0},
      {code: 'unknown-root-tag', line: 16, column: 0},
      {code: 'text-outside-block', line: 17, column: 2},
    ],
    blocks: ['svelte', 'style'],
  },
  {fixture: 'invalid/ComposesBrokenFile.front', errors: [], blocks: ['style', 'react']},
  {fixture: 'invalid/ComposesCycle.front', errors: [], blocks: ['style', 'react']},
  {fixture: 'invalid/ComposesMissingFile.front', errors: [], blocks: ['style', 'react']},
  {fixture: 'invalid/ComposesMissingPackage.front', errors: [], blocks: ['style', 'react']},
  {fixture: 'invalid/CssSyntaxError.front', errors: [], blocks: ['style', 'react']},
  {
    fixture: 'invalid/DuplicateReact.front',
    errors: [
      {code: 'duplicate-target', line: 13, column: 0},
      {code: 'duplicate-target', line: 19, column: 0},
    ],
    blocks: ['style', 'react', 'react', 'react'],
  },
  {fixture: 'invalid/DuplicateStyleModule.front', errors: [], blocks: ['style', 'style', 'style', 'style', 'style', 'react']},
  {fixture: 'invalid/MissingPreprocessor.front', errors: [], blocks: ['style', 'react']},
  {
    fixture: 'invalid/MixedErrors.front',
    errors: [{code: 'duplicate-target', line: 13, column: 0}],
    blocks: ['style', 'react', 'react'],
  },
  {
    fixture: 'invalid/ReactCloseInString.front',
    errors: [{code: 'text-outside-block', line: 9, column: 29}],
    blocks: ['style', 'react'],
  },
  {fixture: 'invalid/ReactNoDefault.front', errors: [], blocks: ['style', 'react']},
  {fixture: 'invalid/ReactNotLast.front', errors: [], blocks: ['react', 'style']},
  {fixture: 'invalid/ReactSyntaxError.front', errors: [], blocks: ['style', 'react']},
  {fixture: 'invalid/ReactTypeOnlyDefault.front', errors: [], blocks: ['style', 'react']},
  {fixture: 'invalid/ReactTypeOnlyDefaultForms.front', errors: [], blocks: ['style', 'react']},
  {fixture: 'invalid/ScssPartialError.front', errors: [], blocks: ['style', 'react']},
  {fixture: 'invalid/ScssSyntaxError.front', errors: [], blocks: ['style', 'react']},
  {
    fixture: 'invalid/StrayClosingTag.front',
    errors: [{code: 'text-outside-block', line: 12, column: 0}],
    blocks: ['style', 'react'],
  },
  {fixture: 'invalid/StyleInSvelte.front', errors: [], blocks: ['svelte', 'style']},
  {fixture: 'invalid/StyleInVue.front', errors: [], blocks: ['vue', 'style']},
  {fixture: 'invalid/StylesOnly.front', errors: [{code: 'missing-target', line: 1, column: 0}], blocks: ['style', 'style']},
  {
    fixture: 'invalid/TextOutsideBlock.front',
    errors: [{code: 'text-outside-block', line: 13, column: 2}],
    blocks: ['style', 'react'],
  },
  {
    fixture: 'invalid/UnclosedComment.front',
    errors: [{code: 'text-outside-block', line: 13, column: 0}],
    blocks: ['style', 'react'],
  },
  {fixture: 'invalid/UnclosedReact.front', errors: [{code: 'unclosed-block', line: 1, column: 0}], blocks: ['style']},
  {
    fixture: 'invalid/UnknownRootTag.front',
    errors: [
      {code: 'unknown-root-tag', line: 13, column: 0},
      {code: 'unknown-root-tag', line: 17, column: 0},
    ],
    blocks: ['style', 'react'],
  },
  {fixture: 'invalid/UnknownStyleLang.front', errors: [], blocks: ['style', 'style', 'style', 'react']},
  {fixture: 'invalid/VueOnlyStyle.front', errors: [], blocks: ['vue', 'svelte', 'style', 'style', 'style', 'react']},
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
    const split = splitFixture('invalid/UnknownRootTag.front');
    const oldTag = split.errors[1]!;
    expect(split.source.slice(oldTag.start, oldTag.end)).toBe('<react_old');
    expect(split.blocks.filter((block) => block.type === 'react')).toHaveLength(1);
  });

  it('keeps the first of three <react> blocks as the target and flags the others', () => {
    const split = splitFixture('invalid/DuplicateReact.front');
    const [first, second, third] = split.blocks.filter((block) => block.type === 'react');
    expect(split.targets.react).toBe(first);
    expect(split.errors.map((error) => error.start)).toEqual([second!.start, third!.start]);
  });

  it('keeps a target block that holds the closing tag of an unknown tag left open before it', () => {
    const split = splitFixture('invalid/BrokenUnknownTags.front');
    expect(split.targets.svelte?.content).toContain('</div>');
  });

  it('gives a doubled closing tag the generic advice, not the escape advice', () => {
    const [error] = splitFixture('invalid/StrayClosingTag.front').errors;
    expect(error!.message).not.toContain('<\\/');
  });

  it("tells the author to write '<\\/react>' when a string closes the block", () => {
    const [error] = splitFixture('invalid/ReactCloseInString.front').errors;
    expect(error!.message).toContain("'<\\/react>'");
  });

  it('points a missing target at the start of the file', () => {
    const [error] = splitFixture('invalid/StylesOnly.front').errors;
    expect(error).toMatchObject({start: 0, end: 0});
  });
});
