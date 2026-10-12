import {createBuildContext, loadVueCompiler, moduleName, splitBlocks} from '@multifront/core';
import {getTypesScript} from '@multifront/language-tools';
import type {EditorFile} from '@multifront/language-tools';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';
import {FIXTURES_DIR, listComponents, readComponent} from '../fixtures/index.ts';

const compiler = loadVueCompiler(FIXTURES_DIR);
const NAMES = [...listComponents(), 'editor/StyleModuleEdges.ucf'];
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// Module name → its keys, from each `declare const <module>: {...}` line.
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

// The mappings of the `declare const` keys; the block content's carry every feature.
function classKeys(script: EditorFile): EditorFile['mappings'] {
  return script.mappings.filter(({data}) => !data.verification);
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

    it('declares every module a block can name with the keys of the build’s class map', () => {
      // A module name that is no identifier (`module="my-theme"`) cannot be named in <react>: no line.
      const expected = Object.entries(build.modules).filter(([module]) => IDENTIFIER.test(module));
      const keys = Object.fromEntries(expected.map(([module, {classes}]) => [module, Object.keys(classes)]));
      expect(sorted(declaredModules(script))).toEqual(sorted(keys));
    });

    it('maps each key it can to its name in a <style> block of that module', () => {
      for (const {sourceOffsets, generatedOffsets} of classKeys(script)) {
        const [offset, generated] = [sourceOffsets[0]!, generatedOffsets[0]!];
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
    expect(classKeys(script).map(({sourceOffsets}) => sourceOffsets[0])).toEqual([source.indexOf('.card {') + 1]);
  });

  it('finds every module key StyleModuleEdges.ucf has, and jumps to where each name is written', () => {
    const {filename, source} = readComponent('editor/StyleModuleEdges.ucf');
    const script = getTypesScript(filename, source, 'react', {compiler})!;
    expect(script.code).not.toContain('my-theme');
    const at = (text: string, skip = 0) => source.indexOf(text) + skip;
    const targets = Object.fromEntries(
      classKeys(script).map(({sourceOffsets: [offset], lengths: [length]}) => [source.slice(offset, offset! + length!), offset])
    );
    // Not here: card__body and row__cell (written as `&__`), dot.ted (written escaped).
    expect(targets).toEqual({
      'card-title': at('.card-title {', 1),
      card: at('.card {', 1),
      inner: at('.inner', 1),
      muted: at('.muted', 1),
      // Past the `.wide` in the comments and in the string.
      wide: source.lastIndexOf('.wide {') + 1,
      // `.dot.ted` is two classes; the escaped `.dot\\.ted` one gets no target, not theirs.
      dot: at('.dot.ted', 1),
      ted: at('.dot.ted', 5),
      accent: at('accent:'),
      gap: at('gap 1rem'),
      x: at('(x,', 1),
      z: at('as z', 3),
      fade: at('fade {'),
      slide: at('slide {'),
      pop: at('pop)'),
      'fade-in': at('.fade-in', 1),
      primary: at('primary: red'),
      row: at('.row\n', 1),
      'row-end': at('.row-end', 1),
    });
  });

  it('types a module the editor cannot read loosely', () => {
    const {filename, source} = readComponent('editor/LessModule.ucf');
    expect(getTypesScript(filename, source, 'react', {compiler})!.code).toContain(
      'declare const $style: {readonly [name: string]: string};'
    );
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

  it('has no script for a target without a block, or for svelte without its compiler', () => {
    const card = readComponent('Card.ucf');
    expect(getTypesScript(card.filename, card.source, 'svelte', {compiler})).toBeUndefined();
    const stylesOnly = readComponent('invalid/StylesOnly.ucf');
    expect(getTypesScript(stylesOnly.filename, stylesOnly.source, 'react', {compiler})).toBeUndefined();
  });
});
