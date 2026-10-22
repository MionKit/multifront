// `.svelte` importers run Svelte's own TypeScript service, which never loads our plugin: they read declarations
// of every `<svelte>` block instead, written to a mirror folder that `rootDirs` merges with the sources.
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {loadSvelteCompiler, splitBlocks} from '@multifront/core';
import type * as ts from 'typescript';
import {svelteTypes} from './blocks/svelte.ts';
import {createEditorContext, editorFiles} from './context.ts';
import {filesUnder, projectTypeScript, slashed} from './files.ts';
import {entryOptions, resolveFrontImport} from './resolve.ts';
import {targetScriptName} from './targetScripts.ts';
import type {EmitSvelteTypesOptions, TypeScript, FrontImportOptions} from './types.ts';

const SCRIPT_EXT = targetScriptName('', 'svelte');
// Only a `.front` file's script: `Foo.svelte.ts`, probed for `./Foo.svelte`, is none.
const frontOf = (script: string): string | undefined =>
  script.endsWith(`.front${SCRIPT_EXT}`) ? script.slice(0, -SCRIPT_EXT.length) : undefined;
const DECLARATION_SUFFIX = '.front.d.ts';

type SvelteScript = NonNullable<ReturnType<typeof svelteTypes>>;
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

/** Writes `<outDir>/<path>/Card.front.d.ts` for every `.front` file under `root` with a `<svelte>` block. */
export function emitSvelteTypes(options: EmitSvelteTypesOptions): string[] {
  const root = resolve(options.root);
  const outDir = resolve(root, options.outDir ?? join('.front', 'svelte'));
  const {svelteTypesRoot} = options;
  const svelteCompiler = loadSvelteCompiler(root);
  const ts = options.ts ?? projectTypeScript(root, 'multifront: could not find typescript. Install typescript in your project.');
  const sources = filesUnder(root, '.front', outDir).filter(hasSvelteBlock);

  // Built when TypeScript asks: an imported `.front` file outside `root` gets its script, but no output.
  const scripts = new Map<string, SvelteScript | undefined>();
  const scriptOf = (fileName: string): SvelteScript | undefined => {
    const front = frontOf(fileName);
    if (!front) return undefined;
    const key = slashed(fileName);
    if (scripts.has(key)) return scripts.get(key);
    let script: SvelteScript | undefined;
    if (existsSync(front)) {
      const ctx = createEditorContext(splitBlocks(readFileSync(front, 'utf8'), front), {ts, svelteCompiler, svelteTypesRoot});
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
  // `.front` imports by the block rule, as tsserver with our plugin resolves them.
  host.resolveModuleNameLiterals = (literals, containingFile, _redirected, resolveOptions, sourceFile) => {
    const frontOptions: FrontImportOptions = {
      ...entryOptions(resolveOptions),
      compilerOptions: resolveOptions,
      host,
      getSplit: () => undefined,
    };
    return literals.map((literal) =>
      literal.text.endsWith('.front')
        ? resolveFrontImport(ts, literal, containingFile, frontOptions, sourceFile)
        : ts.resolveModuleName(literal.text, containingFile, resolveOptions, host)
    );
  };

  // A file whose script cannot be built yet (markup that does not parse) keeps its last declaration.
  const roots = sources.map((front) => targetScriptName(front, 'svelte')).filter((fileName) => scriptOf(fileName));
  const outputs = new Map(roots.map((fileName) => [slashed(fileName.replace(/\.ts$/, '.d.ts')), frontOf(fileName)!]));
  const written: string[] = [];
  const program = ts.createProgram(roots, settings, host);
  program.emit(undefined, (fileName, text) => {
    const front = outputs.get(slashed(fileName));
    if (!front) return;
    const out = join(outDir, `${relative(root, front)}.d.ts`);
    mkdirSync(dirname(out), {recursive: true});
    writeFileSync(out, text);
    written.push(out);
  });

  // A removed block must not keep typing its importers.
  if (existsSync(outDir)) {
    const kept = new Set(sources.map((front) => relative(root, front)));
    for (const declaration of filesUnder(outDir, DECLARATION_SUFFIX)) {
      if (!kept.has(relative(outDir, declaration).slice(0, -'.d.ts'.length))) rmSync(declaration);
    }
  }
  return written.sort();
}
