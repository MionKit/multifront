/** One tsconfig's program for `mf-tsc`: every `.ucf` file with each target's script, diagnostics in the `.ucf` text. */
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {loadSvelteCompiler, loadVueCompiler, svelteParseError} from '@multifront/core';
import type {SplitResult, SvelteCompiler, Target} from '@multifront/core';
import type {Language} from '@volar/language-core';
import {createVueLanguagePlugin} from '@vue/language-core';
import type {VueCompilerOptions} from '@vue/language-core';
import {proxyCreateProgram} from '@volar/typescript';
import {transformDiagnostic, transformTextSpan} from '@volar/typescript/lib/node/transform.js';
import {getServiceScript} from '@volar/typescript/lib/node/utils.js';
import type * as ts from 'typescript';
import {withImportErrors} from '../importErrors.ts';
import {MAIN_SCRIPT_TARGET, createUcfLanguagePlugin} from '../languagePlugin.ts';
import {entryOptions, withUcfResolution} from '../resolve.ts';
import {programTargetScripts, targetScriptName} from '../targetScripts.ts';
import type {Checked, CheckedFile, TypeScript, UcfImportOptions, UcfVirtualCode} from '../types.ts';

type Scripts = ReturnType<typeof programTargetScripts>;

function optional<Compiler>(load: (root: string) => Compiler, root: string): Compiler | undefined {
  try {
    return load(root);
  } catch {
    return undefined;
  }
}

// Not installed, or found but broken: then its own error says why.
function svelteError(root: string, loadError: unknown): unknown {
  try {
    createRequire(join(root, 'package.json')).resolve('svelte/compiler');
  } catch {
    return new Error(`svelte is not installed in ${root}; add it to devDependencies`);
  }
  return loadError;
}

// Each file parsed once: a pass that adds roots asks for every file again.
function createHost(ts: TypeScript, options: ts.CompilerOptions, scripts: () => Scripts | undefined): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  const fileExists = host.fileExists;
  const parsed = new Map<string, ts.SourceFile | undefined>();
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (parsed.has(fileName)) return parsed.get(fileName);
    const script = scripts()?.scriptOf(fileName);
    const {snapshot} = script?.code ?? {};
    const sourceFile = snapshot
      ? ts.createSourceFile(fileName, snapshot.getText(0, snapshot.getLength()), languageVersion, false, script!.scriptKind)
      : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    parsed.set(fileName, sourceFile);
    return sourceFile;
  };
  host.fileExists = (fileName) => (scripts()?.ucfOf(fileName) ? !!scripts()!.scriptOf(fileName) : fileExists(fileName));
  return host;
}

// A mapping covers it, whatever its flags: a tool hid it on purpose (Vue's `verification: false`).
function mapsAnywhere(language: Language<string>, {file, start, length = 0}: ts.Diagnostic): boolean {
  const [serviceScript] = getServiceScript(language, file!.fileName);
  return !!serviceScript && !!transformTextSpan(undefined, language, serviceScript, {start: start!, length}, true, () => true);
}

// TypeScript's "can only be used in TypeScript files": a generator's syntax where it maps nowhere, never the user's.
const TS_ONLY_SYNTAX = new Set([8002, 8003, 8004, 8005, 8006, 8008, 8009, 8010, 8011, 8012, 8013, 8016, 8017, 8037]);

const inNodeModules = (fileName: string): boolean => fileName.split('/').includes('node_modules');

export function createChecked(
  ts: TypeScript,
  configFile: string,
  parsed: ts.ParsedCommandLine,
  vueOptions: VueCompilerOptions
): Checked {
  let main: Language<string> | undefined;
  let scripts: Scripts | undefined;
  let raw: Record<'syntactic' | 'semantic', ts.Program['getSemanticDiagnostics']> | undefined;
  const getSplit = (fileName: string): SplitResult | undefined =>
    (main?.scripts.get(fileName)?.generated?.root as UcfVirtualCode | undefined)?.split;
  // Never emits: the tsconfig's emit options would only add errors about files it never writes.
  const options: ts.CompilerOptions = {...parsed.options, noEmit: true, allowNonTsExtensions: true};
  const root = dirname(configFile);
  let svelteLoadError: unknown;
  let svelteCompiler: SvelteCompiler | undefined;
  try {
    svelteCompiler = loadSvelteCompiler(root);
  } catch (err) {
    svelteLoadError = err;
  }
  // Runs inside Volar's proxy, after `setup` and after Volar put its own resolver on the host.
  const inner = ((createOptions: ts.CreateProgramOptions) => {
    const host = createOptions.host!;
    const importOptions = (compilerOptions: ts.CompilerOptions): UcfImportOptions => ({
      ...entryOptions(compilerOptions),
      compilerOptions,
      host,
      getSplit,
    });
    host.resolveModuleNameLiterals = withUcfResolution(ts, host.resolveModuleNameLiterals!.bind(host), importOptions);
    // Every `.ucf` file the program holds brings each target's script, imported or not.
    const roots = new Set(createOptions.rootNames);
    const addUcf = (ucf: string): void => {
      roots.add(ucf);
      for (const name of scripts!.namesOf(ucf)) roots.add(name);
    };
    for (const name of createOptions.rootNames) if (name.endsWith('.ucf')) addUcf(name);
    let program = ts.createProgram({...createOptions, rootNames: [...roots]});
    for (let size = 0; size !== roots.size;) {
      size = roots.size;
      for (const {fileName} of program.getSourceFiles()) {
        const ucf = fileName.endsWith('.ucf') ? fileName : scripts!.ucfOf(fileName);
        if (ucf && !roots.has(ucf) && !inNodeModules(ucf)) addUcf(ucf);
      }
      if (size !== roots.size) program = ts.createProgram({...createOptions, rootNames: [...roots], oldProgram: program});
    }
    // Before Volar decorates the program, so it maps our import errors into the `.ucf` file too.
    const semantic = program.getSemanticDiagnostics;
    program.getSemanticDiagnostics = (sourceFile, token) => {
      const diagnostics = semantic(sourceFile, token);
      return sourceFile
        ? withImportErrors(ts, sourceFile, diagnostics, importOptions(program.getCompilerOptions()))
        : diagnostics;
    };
    // Volar drops diagnostics that map nowhere; `intoUcf` puts them on the block's opening tag.
    raw = {syntactic: program.getSyntacticDiagnostics, semantic: program.getSemanticDiagnostics};
    return program;
  }) as typeof ts.createProgram;
  const editorOptions = {ts, compilerOptions: options, compiler: optional(loadVueCompiler, root), svelteCompiler};
  const createProgram = proxyCreateProgram(ts as Parameters<typeof proxyCreateProgram>[0], inner, () => ({
    // `.vue` files, as `vue-tsc` builds them; a `.ucf` `<vue>` block keeps our own options.
    languagePlugins: [
      createUcfLanguagePlugin(editorOptions),
      createVueLanguagePlugin(ts as Parameters<typeof createVueLanguagePlugin>[0], options, vueOptions, (id: string) => id),
    ],
    setup(language) {
      main = language;
      scripts = programTargetScripts(ts, language);
    },
  }));
  const host = createHost(ts, options, () => scripts);
  const program = createProgram({rootNames: parsed.fileNames, options, host});

  const intoUcf = (
    language: Language<string>,
    diagnostics: readonly ts.Diagnostic[],
    ucf: ts.SourceFile,
    split: SplitResult,
    target: Target
  ): CheckedFile['diagnostics'] =>
    diagnostics.flatMap((diagnostic) => {
      const mapped = transformDiagnostic(language, diagnostic, program, true);
      if (mapped) return [{diagnostic: mapped, target}];
      // An unused generated helper (`noUnusedLocals`) is the generator's business, never the user's.
      if (diagnostic.start === undefined || diagnostic.reportsUnnecessary || TS_ONLY_SYNTAX.has(diagnostic.code)) return [];
      if (mapsAnywhere(language, diagnostic)) return [];
      const {start, contentStart} = split.targets[target]!;
      return [{diagnostic: {...diagnostic, file: ucf, start, length: contentStart - start}, target}];
    });
  const scriptDiagnostics = (sourceFile: ts.SourceFile) => [...raw!.syntactic(sourceFile), ...raw!.semantic(sourceFile)];

  return {
    program,
    getSplit,
    files: () =>
      program
        .getSourceFiles()
        .filter((sourceFile) => !program.isSourceFileDefaultLibrary(sourceFile))
        .map(({fileName}) => fileName)
        .filter((fileName) => !inNodeModules(fileName) && !scripts!.ucfOf(fileName)),
    check(fileName, targets) {
      const sourceFile = program.getSourceFile(fileName)!;
      const split = getSplit(fileName);
      if (!split) {
        const diagnostics = [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)];
        return {diagnostics: diagnostics.map((diagnostic) => ({diagnostic})), errors: []};
      }
      const checked: CheckedFile = {diagnostics: [], errors: []};
      for (const target of targets) {
        if (target === MAIN_SCRIPT_TARGET) {
          checked.diagnostics.push(...intoUcf(main!, scriptDiagnostics(sourceFile), sourceFile, split, target));
          continue;
        }
        const script = program.getSourceFile(targetScriptName(fileName, target));
        const language = scripts!.languageOf(target);
        if (script && language) {
          checked.diagnostics.push(...intoUcf(language, scriptDiagnostics(script), sourceFile, split, target));
          continue;
        }
        // No script for a block it has: Svelte cannot be loaded, or cannot read the markup.
        const block = split.targets[target]!;
        if (target !== 'svelte') throw new Error(`${fileName} gives no ${target} script`);
        if (!svelteCompiler) throw svelteError(root, svelteLoadError);
        try {
          svelteCompiler.parse(block.content, {modern: true});
        } catch (err) {
          const error = svelteParseError(err, block, split);
          if (!error) throw err;
          checked.errors.push({error, target});
          continue;
        }
        throw new Error(`${fileName} gives no ${target} script, though its <${target}> block parses`);
      }
      return checked;
    },
  };
}
