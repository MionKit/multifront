import ts from 'typescript';
import {describe, expect, it} from 'vitest';
import {TARGETS, getBlockKind, splitBlocks} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {listComponents, readComponent} from '../../e2e/fixtures/index.ts';

// Syntax errors only, from the real TypeScript parser reading the block as a .tsx file.
function tsxSyntaxErrors(code: string): string[] {
  const file = ts.createSourceFile('Block.tsx', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const host = ts.createCompilerHost({});
  host.getSourceFile = (name) => (name === file.fileName ? file : undefined);
  const program = ts.createProgram([file.fileName], {noLib: true, noResolve: true}, host);
  return program.getSyntacticDiagnostics(file).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

describe('splitBlocks on valid fixtures', () => {
  it('finds every valid fixture', () => {
    expect(listComponents()).toEqual(['Badge.ucf', 'Button.ucf', 'Card.ucf', 'Hello.ucf', 'Panel.ucf', 'TsxEdges.ucf']);
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
