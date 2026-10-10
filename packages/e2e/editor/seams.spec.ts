// Milestone 2 QA: 2.8's resolver as a public function, the way M7's mf-tsc calls it: no open buffers.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {rewriteImportAttributes, splitBlocks} from '@multifront/core';
import {resolveUcfImport} from '@multifront/language-tools';
import type {UcfImportOptions} from '@multifront/language-tools';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';
import {FIXTURES_DIR, componentPath, readComponent} from '../fixtures/index.ts';

const OPTIONS: UcfImportOptions = {
  compilerOptions: {module: ts.ModuleKind.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler},
  host: ts.sys,
  getSplit: () => undefined,
};

function ucfLiterals(sourceFile: ts.SourceFile): ts.StringLiteralLike[] {
  const literals: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && node.text.endsWith('.ucf')) literals.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return literals;
}

function blockScript(name: string) {
  const {filename, source} = readComponent(name);
  const script = splitBlocks(source, filename).targets.react!.content;
  return {filename, sourceFile: ts.createSourceFile(filename, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)};
}

function appFile(path: string) {
  const filename = join(FIXTURES_DIR, 'apps', path);
  const source = readFileSync(filename, 'utf8');
  return {filename, source, sourceFile: ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)};
}

describe('resolveUcfImport with no open buffer', () => {
  const {filename, sourceFile} = blockScript('editor/ImportErrors.ucf');

  function resolve(specifier: string) {
    const literal = sourceFile.statements
      .filter(ts.isImportDeclaration)
      .map(({moduleSpecifier}) => moduleSpecifier)
      .find((node): node is ts.StringLiteral => ts.isStringLiteral(node) && node.text === specifier)!;
    return resolveUcfImport(ts, literal, filename, OPTIONS, sourceFile);
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
  const {filename, sourceFile} = blockScript('react/errors/AttrInBlock.ucf');

  it('every import with a framework key is framework-in-block, a non-literal value too; the bare one resolves', () => {
    const codes = ucfLiterals(sourceFile).map((literal) => {
      const resolution = resolveUcfImport(ts, literal, filename, OPTIONS, sourceFile);
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
      ["'../../Button.ucf'", 'framework-in-block'],
      ["'../../Card.ucf'", undefined],
      ["'../../Card.ucf'", undefined],
      ["'../../Card.ucf'", undefined],
    ]);
  });

  it("a block that also parses as plain TypeScript is still framework-in-block, never the build's rewrite error", () => {
    const script = blockScript('react/errors/AttrNoJsx.ucf');
    const [literal] = ucfLiterals(script.sourceFile);
    const resolution = resolveUcfImport(ts, literal!, script.filename, OPTIONS, script.sourceFile);
    expect(resolution.error?.code).toBe('framework-in-block');
  });
});

describe('resolveUcfImport on a non-literal framework attribute outside a block', () => {
  it("is the build's rewrite error, at its span, and the import stays unresolved", () => {
    const {filename, source, sourceFile} = appFile('imports/no-default/non-literal.ts');
    const [literal] = ucfLiterals(sourceFile);
    const resolution = resolveUcfImport(ts, literal!, filename, OPTIONS, sourceFile);
    const [error] = rewriteImportAttributes(source, filename).errors;
    expect(error?.code).toBe('framework-attribute-not-literal');
    expect(resolution.resolvedModule).toBeUndefined();
    expect(resolution.error).toEqual(error);
  });

  it("an import() nested in another's options: the error goes to the inner import only", () => {
    const {filename, source, sourceFile} = appFile('rewrite-edges/nested-dynamic.js');
    const [error] = rewriteImportAttributes(source, filename).errors;
    const errors = ucfLiterals(sourceFile).map((literal) => [
      literal.text,
      resolveUcfImport(ts, literal, filename, OPTIONS, sourceFile).error,
    ]);
    expect(errors).toEqual([
      ['../../components/Card.ucf', undefined],
      ['../../components/Badge.ucf', error],
    ]);
  });
});
