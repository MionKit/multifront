// Milestone 2 QA: 2.8's resolver as a public function, the way M7's mf-tsc calls it: no open buffers.
import {splitBlocks} from '@multifront/core';
import {resolveUcfImport} from '@multifront/language-tools';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';
import {componentPath, readComponent} from '../fixtures/index.ts';

describe('resolveUcfImport with no open buffer', () => {
  const {filename, source} = readComponent('editor/ImportErrors.ucf');
  // The importer's own script, as TypeScript reads it.
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

describe('resolveUcfImport on the attributes of a <react> block', () => {
  const {filename, source} = readComponent('react/errors/AttrInBlock.ucf');
  const script = splitBlocks(source, filename).targets.react!.content;
  const sourceFile = ts.createSourceFile(filename, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const literals: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && node.text.endsWith('.ucf')) literals.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  it('every import with a framework key is framework-in-block, a non-literal value too; the bare one resolves', () => {
    const codes = literals.map((literal) => {
      const resolution = resolveUcfImport(ts, literal, filename, {
        compilerOptions: {module: ts.ModuleKind.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler},
        host: ts.sys,
        getSplit: () => undefined,
      });
      return [literal.getText(sourceFile), resolution.error?.code];
    });
    expect(codes).toEqual([
      ["'../../Card.ucf'", undefined],
      ["'../../Badge.ucf'", 'framework-in-block'],
      ["'../../Button.ucf'", 'framework-in-block'],
      ["'../../Panel.ucf'", 'framework-in-block'],
      ["'../../Hello.ucf'", 'framework-in-block'],
      ["'../../Card.ucf'", 'framework-in-block'],
      ['`../../Badge.ucf`', 'framework-in-block'],
    ]);
  });
});
