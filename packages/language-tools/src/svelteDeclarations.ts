// `.svelte` importers run Svelte's own TypeScript service, which never loads our plugin: they read declarations
// of every `<svelte>` block instead, written to a mirror folder that `rootDirs` merges with the sources.
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, relative, resolve} from 'node:path';
import {loadSvelteCompiler, splitBlocks} from '@multifront/core';
import type * as ts from 'typescript';
import {svelteTypes} from './blocks/svelte.ts';
import {createEditorContext, editorFiles} from './context.ts';
import {filesUnder} from './files.ts';
import {entryOptions, resolveUcfImport} from './resolve.ts';
import {targetScriptName} from './targetScripts.ts';
import type {EmitSvelteTypesOptions, TypeScript, UcfImportOptions} from './types.ts';

const SCRIPT_EXT = targetScriptName('', 'svelte');
// Only a `.ucf` file's script: `Foo.svelte.ts`, probed for `./Foo.svelte`, is none.
const ucfOf = (script: string): string | undefined =>
  script.endsWith(`.ucf${SCRIPT_EXT}`) ? script.slice(0, -SCRIPT_EXT.length) : undefined;
const DECLARATION_SUFFIX = '.ucf.d.ts';

type SvelteScript = NonNullable<ReturnType<typeof svelteTypes>>;
// TypeScript names program files with `/`.
const slashed = (fileName: string): string => fileName.replaceAll('\\', '/');

function projectTypeScript(root: string): TypeScript {
  const require = createRequire(join(root, 'package.json'));
  let path: string;
  try {
    path = require.resolve('typescript');
  } catch {
    throw new Error('multifront: could not find typescript. Install typescript in your project.');
  }
  // Found but broken: its own error says why.
  return require(path) as TypeScript;
}

function hasSvelteBlock(fileName: string): boolean {
  try {
    return !!splitBlocks(readFileSync(fileName, 'utf8'), fileName).targets.svelte;
  } catch {
    return false;
  }
}

function compilerOptions(ts: TypeScript, root: string): ts.CompilerOptions {
  // Errors ignored: a missing or broken tsconfig still leaves the defaults below.
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(root, 'tsconfig.json'),
    {},
    {...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {}}
  );
  return {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    ...parsed?.options,
    // A JS block's JSDoc props are read only as JavaScript.
    allowJs: true,
    declaration: true,
    emitDeclarationOnly: true,
    noEmit: false,
    noEmitOnError: false,
    declarationMap: false,
    outDir: undefined,
    declarationDir: undefined,
  };
}

/** Writes `<outDir>/<path>/Card.ucf.d.ts` for every `.ucf` file under `root` with a `<svelte>` block. */
export function emitSvelteTypes(options: EmitSvelteTypesOptions): string[] {
  const root = resolve(options.root);
  const outDir = resolve(root, options.outDir ?? join('.ucf', 'svelte'));
  const {svelteTypesRoot} = options;
  const svelteCompiler = loadSvelteCompiler(root);
  const ts = options.ts ?? projectTypeScript(root);
  const sources = filesUnder(root, '.ucf', outDir).filter(hasSvelteBlock);

  // Built when TypeScript asks: an imported `.ucf` file outside `root` gets its script, but no output.
  const scripts = new Map<string, SvelteScript | undefined>();
  const scriptOf = (fileName: string): SvelteScript | undefined => {
    const ucf = ucfOf(fileName);
    if (!ucf) return undefined;
    const key = slashed(fileName);
    if (scripts.has(key)) return scripts.get(key);
    let script: SvelteScript | undefined;
    if (existsSync(ucf)) {
      const ctx = createEditorContext(splitBlocks(readFileSync(ucf, 'utf8'), ucf), {ts, svelteCompiler, svelteTypesRoot});
      // Only for the modules `svelteTypes` reads.
      editorFiles(ctx, true);
      const block = ctx.split.targets.svelte;
      script = block && svelteTypes(block, ctx);
    }
    scripts.set(key, script);
    return script;
  };

  const settings = compilerOptions(ts, root);
  const host = ts.createCompilerHost(settings);
  const {getSourceFile, fileExists, readFile} = host;
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const script = scriptOf(fileName);
    if (!script) return getSourceFile(fileName, languageVersion, ...rest);
    const kind = script.lang === 'ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    return ts.createSourceFile(fileName, script.code, languageVersion, false, kind);
  };
  host.fileExists = (fileName) => !!scriptOf(fileName) || fileExists(fileName);
  host.readFile = (fileName) => scriptOf(fileName)?.code ?? readFile(fileName);
  // `.ucf` imports by the block rule, as tsserver with our plugin resolves them.
  host.resolveModuleNameLiterals = (literals, containingFile, _redirected, resolveOptions, sourceFile) => {
    const ucfOptions: UcfImportOptions = {
      ...entryOptions(resolveOptions),
      compilerOptions: resolveOptions,
      host,
      getSplit: () => undefined,
    };
    return literals.map((literal) =>
      literal.text.endsWith('.ucf')
        ? resolveUcfImport(ts, literal, containingFile, ucfOptions, sourceFile)
        : ts.resolveModuleName(literal.text, containingFile, resolveOptions, host)
    );
  };

  // A file whose script cannot be built yet (markup that does not parse) keeps its last declaration.
  const roots = sources.map((ucf) => targetScriptName(ucf, 'svelte')).filter((fileName) => scriptOf(fileName));
  const outputs = new Map(roots.map((fileName) => [slashed(fileName.replace(/\.ts$/, '.d.ts')), ucfOf(fileName)!]));
  const written: string[] = [];
  const program = ts.createProgram(roots, settings, host);
  program.emit(undefined, (fileName, text) => {
    const ucf = outputs.get(slashed(fileName));
    if (!ucf) return;
    const out = join(outDir, `${relative(root, ucf)}.d.ts`);
    mkdirSync(dirname(out), {recursive: true});
    writeFileSync(out, text);
    written.push(out);
  });

  // A removed block must not keep typing its importers.
  if (existsSync(outDir)) {
    const kept = new Set(sources.map((ucf) => relative(root, ucf)));
    for (const declaration of filesUnder(outDir, DECLARATION_SUFFIX)) {
      if (!kept.has(relative(outDir, declaration).slice(0, -'.d.ts'.length))) rmSync(declaration);
    }
  }
  return written.sort();
}
