import {createBuildContext, loadVueCompiler, moduleName, splitBlocks} from '@multifront/core';
import {getTypesScript} from '@multifront/language-tools';
import type {EditorFile} from '@multifront/language-tools';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';
import {FIXTURES_DIR, listComponents, readComponent} from '../fixtures/index.ts';

const compiler = loadVueCompiler(FIXTURES_DIR);
const NAMES = [...listComponents(), 'editor/StyleModuleEdges.ucf'];

// Each `declare const <module>: {...}` line, read by the real TypeScript parser: module name → its keys.
function declaredModules(script: EditorFile): Record<string, string[]> {
  const file = ts.createSourceFile('types.tsx', script.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const modules: Record<string, string[]> = {};
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!statement.modifiers?.some(({kind}) => kind === ts.SyntaxKind.DeclareKeyword)) continue;
    for (const {name, type} of statement.declarationList.declarations) {
      if (!ts.isIdentifier(name) || !type || !ts.isTypeLiteralNode(type)) continue;
      modules[name.text] = type.members.map((member) => {
        if (!member.name || !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) throw new Error('not a key');
        return member.name.text;
      });
    }
  }
  return modules;
}

function sorted(modules: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(modules).map(([name, keys]) => [name, [...keys].sort()]));
}

describe('getTypesScript types $style with the class names the build finds', () => {
  describe.each(NAMES)('%s', async (name) => {
    const {filename, source} = readComponent(name);
    const split = splitBlocks(source, filename);
    const build = await createBuildContext(split, {root: FIXTURES_DIR, compiler, production: false});
    const script = getTypesScript(filename, source, 'react', {compiler})!;

    it('declares every module with the keys of the build’s class map', () => {
      const expected = Object.fromEntries(
        Object.entries(build.modules).map(([module, {classes}]) => [module, Object.keys(classes)])
      );
      expect(sorted(declaredModules(script))).toEqual(sorted(expected));
    });

    it('keeps the block content first, mapped with every feature', () => {
      expect(script.code.startsWith(split.targets.react!.content)).toBe(true);
      expect(script.mappings[0]!.sourceOffsets).toEqual([split.targets.react!.contentStart]);
    });

    it('maps each key it can to its name in a <style> block of that module, for navigation only', () => {
      for (const {sourceOffsets, generatedOffsets, lengths, data} of script.mappings.slice(1)) {
        const [offset, generated, length] = [sourceOffsets[0]!, generatedOffsets[0]!, lengths[0]!];
        expect(data).toEqual({navigation: true});
        expect(script.code.slice(generated, generated + length)).toBe(source.slice(offset, offset + length));
        const line = script.code.slice(script.code.lastIndexOf('\n', generated) + 1, generated);
        const module = /^declare const ([\w$]+):/.exec(line)![1];
        const block = split.styles.find((style) => style.contentStart <= offset && offset < style.contentEnd);
        expect(block && moduleName(block)).toBe(module);
      }
    });
  });

  it('lands $style.card on the card of .card in Card.ucf', () => {
    const {filename, source} = readComponent('Card.ucf');
    const script = getTypesScript(filename, source, 'react', {compiler})!;
    expect(script.mappings.slice(1).map(({sourceOffsets}) => sourceOffsets[0])).toEqual([source.indexOf('.card {') + 1]);
  });

  it('gives no jump target to a name not written in the block, and none to a commented one', () => {
    const {filename, source} = readComponent('editor/StyleModuleEdges.ucf');
    const script = getTypesScript(filename, source, 'react', {compiler})!;
    const targets = script.mappings
      .slice(1)
      .map(({sourceOffsets, lengths}) => source.slice(sourceOffsets[0], sourceOffsets[0]! + lengths[0]!));
    expect(targets).not.toContain('card__body');
    expect(targets).toEqual(['card-title', 'card', 'inner', 'muted', 'wide', 'accent', 'fade', 'fade-in']);
    expect(declaredModules(script).$style).not.toContain('ghost');
  });

  it.each(['Card.ucf', 'Button.ucf'])('matches the %s.react.tsx snapshot', async (name) => {
    const {filename, source} = readComponent(name);
    await expect(getTypesScript(filename, source, 'react', {compiler})!.code).toMatchFileSnapshot(
      `__snapshots__/${name}.react.tsx`
    );
  });

  it('reads a plain CSS module without a compiler, and types an unreadable one loosely', () => {
    const button = readComponent('Button.ucf');
    expect(declaredModules(getTypesScript(button.filename, button.source, 'react')!)).toEqual({classes: ['primary']});
    const card = readComponent('Card.ucf');
    expect(getTypesScript(card.filename, card.source, 'react')!.code).toContain(
      'declare const $style: {readonly [name: string]: string};'
    );
  });

  it('has no script for a target without a block or without types yet', () => {
    const card = readComponent('Card.ucf');
    expect(getTypesScript(card.filename, card.source, 'vue', {compiler})).toBeUndefined();
    const stylesOnly = readComponent('invalid/StylesOnly.ucf');
    expect(getTypesScript(stylesOnly.filename, stylesOnly.source, 'react', {compiler})).toBeUndefined();
  });
});
