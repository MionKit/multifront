// Milestone 2 QA: 2.8's resolver as a public function, the way M7's mf-tsc calls it: no open buffers.
import {splitBlocks} from '@multifront/core';
import {resolveUcfImport} from '@multifront/language-tools';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';
import {componentPath, readComponent} from '../fixtures/index.ts';

describe('resolveUcfImport with no open buffer', () => {
  const {filename, source} = readComponent('editor/ImportErrors.ucf');
  // The <react> block, as TypeScript reads it: the importer's own script.
  const script = splitBlocks(source, filename).targets.react!.content;
  const sourceFile = ts.createSourceFile(filename, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  function resolve(specifier: string) {
    const literal = sourceFile.statements
      .filter(ts.isImportDeclaration)
      .map(({moduleSpecifier}) => moduleSpecifier)
      .find((node): node is ts.StringLiteral => ts.isStringLiteral(node) && node.text === specifier)!;
    return resolveUcfImport(ts, literal, filename, {
      compilerOptions: {module: ts.ModuleKind.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler},
      host: ts.sys,
      getSplit: () => undefined,
    });
  }

  it('splits the imported file itself: a file without the block is missing-target-block', () => {
    const resolution = resolve('../imports/VueOnly.ucf');
    expect(resolution.resolvedModule?.resolvedFileName).toBe(componentPath('imports/VueOnly.ucf'));
    expect(resolution.error).toEqual({
      code: 'missing-target-block',
      message: '../imports/VueOnly.ucf has no <react> block; ImportErrors.ucf imports it as react',
    });
  });

  it('a file with the block resolves with no error', () => {
    const resolution = resolve('../Card.ucf');
    expect(resolution.resolvedModule?.resolvedFileName).toBe(componentPath('Card.ucf'));
    expect(resolution.error).toBeUndefined();
  });
});
