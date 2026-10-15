/** One tsconfig's program for `mf-tsc`: every `.ucf` file with each target's script, diagnostics in the `.ucf` text. */
import {dirname} from 'node:path';
import {loadSvelteCompiler, loadVueCompiler, svelteParseError} from '@multifront/core';
import type {Diagnostic, SplitResult, SvelteCompiler, Target} from '@multifront/core';
import type {Language} from '@volar/language-core';
import {proxyCreateProgram} from '@volar/typescript';
import {transformDiagnostic, transformTextSpan} from '@volar/typescript/lib/node/transform.js';
import {getServiceScript} from '@volar/typescript/lib/node/utils.js';
import type * as ts from 'typescript';
import {withImportErrors} from '../importErrors.ts';
import {MAIN_SCRIPT_TARGET, createUcfLanguagePlugin} from '../languagePlugin.ts';
import {entryOptions, withUcfResolution} from '../resolve.ts';
import {programTargetScripts, targetScriptName} from '../targetScripts.ts';
import type {TypeScript, UcfImportOptions, UcfVirtualCode} from '../types.ts';

export interface Checked {
  program: ts.Program;
  getSplit(fileName: string): SplitResult | undefined;
  files(): string[]; // the user's files: no default lib, no `node_modules`, no target script
  check(fileName: string, targets: readonly Target[]): CheckedFile;
}

/** One file's problems, already in the file the user wrote. */
export interface CheckedFile {
  diagnostics: {diagnostic: ts.Diagnostic; target?: Target}[]; // `target`: the `.ucf` script that reported it
  errors: {error: Diagnostic; target: Target}[]; // ours: `<svelte>` markup Svelte cannot parse
}

type Scripts = ReturnType<typeof programTargetScripts>;
type DiagnosticsOf = (sourceFile: ts.SourceFile) => readonly ts.Diagnostic[];

function optional<Compiler>(load: (root: string) => Compiler, root: string): Compiler | undefined {
  try {
    return load(root);
  } catch {
    return undefined;
  }
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
  host.fileExists = (fileName) => (scripts()?.parse(fileName) ? !!scripts()!.scriptOf(fileName) : fileExists(fileName));
  return host;
}

// A mapping covers it, whatever its flags: a tool hid it on purpose (Vue's `verification: false`).
function mapsAnywhere(language: Language<string>, {file, start, length = 0}: ts.Diagnostic): boolean {
  const [serviceScript] = getServiceScript(language, file!.fileName);
  return !!serviceScript && !!transformTextSpan(undefined, language, serviceScript, {start: start!, length}, true, () => true);
}

const inNodeModules = (fileName: string): boolean => fileName.split('/').includes('node_modules');

export function createChecked(ts: TypeScript, configFile: string, parsed: ts.ParsedCommandLine): Checked {
  let main: Language<string> | undefined;
  let scripts: Scripts | undefined;
  let raw: {syntactic: DiagnosticsOf; semantic: DiagnosticsOf} | undefined;
  const getSplit = (fileName: string): SplitResult | undefined =>
    (main?.scripts.get(fileName)?.generated?.root as UcfVirtualCode | undefined)?.split;
  // Never emits: the tsconfig's emit options would only add errors about files it never writes.
  const options: ts.CompilerOptions = {...parsed.options, noEmit: true, allowNonTsExtensions: true};
  const root = dirname(configFile);
  const svelteCompiler: SvelteCompiler | undefined = optional(loadSvelteCompiler, root);
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
        const ucf = fileName.endsWith('.ucf') ? fileName : scripts!.parse(fileName)?.ucf;
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
    // Volar maps a `.ucf` script's and drops what maps nowhere; ours put that on the block's opening tag.
    raw = {syntactic: program.getSyntacticDiagnostics, semantic: program.getSemanticDiagnostics};
    return program;
  }) as typeof ts.createProgram;
  const editorOptions = {ts, compilerOptions: options, compiler: optional(loadVueCompiler, root), svelteCompiler};
  const createProgram = proxyCreateProgram(ts as Parameters<typeof proxyCreateProgram>[0], inner, () => ({
    languagePlugins: [createUcfLanguagePlugin(editorOptions)],
    setup(language) {
      main = language;
      scripts = programTargetScripts(ts, language);
    },
  }));
  const host = createHost(ts, options, () => scripts);
  const program = createProgram({rootNames: parsed.fileNames, options, host});

  // `language` maps the script into the `.ucf` file; what maps nowhere lands on the block's opening tag.
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
      if (diagnostic.start === undefined || diagnostic.reportsUnnecessary || mapsAnywhere(language, diagnostic)) return [];
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
        .filter((fileName) => !inNodeModules(fileName) && !scripts!.parse(fileName)),
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
        if (!svelteCompiler) throw new Error(`svelte is not installed in ${root}; add it to devDependencies`);
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
