/** `mf-tsc`: the tsconfig's whole program with `.ucf` files in it, diagnostics of the given files only (spec 5). */
import {basename, dirname, resolve} from 'node:path';
import {findingOf, loadSvelteCompiler, loadVueCompiler, rootRelativePath, runCommand} from '@multifront/core';
import type {CommandResult, CommandSpec, CommandValues, Finding, SplitResult} from '@multifront/core';
import {proxyCreateProgram} from '@volar/typescript';
import type * as ts from 'typescript';
import {filesUnder, projectTypeScript, slashed} from '../files.ts';
import {withImportErrors} from '../importErrors.ts';
import {MAIN_SCRIPT_TARGET, createUcfLanguagePlugin} from '../languagePlugin.ts';
import {entryOptions, withUcfResolution} from '../resolve.ts';
import type {TypeScript, UcfImportOptions, UcfVirtualCode} from '../types.ts';

const MF_TSC: CommandSpec = {
  name: 'mf-tsc',
  summary: ['Type-checks the <react> block of .ucf files, with the .ts and .tsx files that import them.'],
  paths: 'Paths are files or folders of the project; none checks the whole project.',
  options: {
    project: {
      type: 'string',
      short: 'p',
      value: '<file>',
      description: 'the tsconfig.json to use (default: the nearest one above each path)',
    },
  },
  example: 'mf-tsc src/Card.ucf --format json',
};

const CONFIG_NAME = 'tsconfig.json';

interface Project {
  configFile: string;
  parsed: ts.ParsedCommandLine;
  checked?: Checked;
}

interface Checked {
  program: ts.Program;
  getSplit(fileName: string): SplitResult | undefined;
}

function flatten(ts: TypeScript, text: string | ts.DiagnosticMessageChain): string {
  return ts
    .flattenDiagnosticMessageText(text, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

function configError(ts: TypeScript, diagnostics: readonly ts.Diagnostic[], cwd: string): Error {
  const [first] = diagnostics;
  let where = '';
  if (first!.file && first!.start !== undefined) {
    const {line, character} = first!.file.getLineAndCharacterOfPosition(first!.start);
    where = `${rootRelativePath(cwd, first!.file.fileName)}:${line + 1}:${character + 1}: `;
  }
  const more = diagnostics.length > 1 ? ` (and ${diagnostics.length - 1} more)` : '';
  return new Error(`${where}error TS${first!.code}: ${flatten(ts, first!.messageText)}${more}`);
}

/** Volar has mapped `diagnostic` into the user's file; suggestions are dropped, as in `tsc`. */
function tscFinding(ts: TypeScript, diagnostic: ts.Diagnostic, split?: SplitResult): Finding | undefined {
  const {category, code, file, start, length = 0} = diagnostic;
  const severity =
    category === ts.DiagnosticCategory.Error ? 'error' : category === ts.DiagnosticCategory.Warning ? 'warning' : undefined;
  if (!severity) return undefined;
  // Our import errors carry their string code where TypeScript's number goes.
  const finding: Finding = {
    code: typeof code === 'number' ? `TS${code}` : String(code),
    severity,
    message: flatten(ts, diagnostic.messageText),
  };
  if (!file) return finding;
  if (start === undefined) return {file: file.fileName, ...finding};
  // Volar's leading offset keeps a `.ucf` file's line starts in its script.
  const at = (offset: number) => {
    const {line, character} = file.getLineAndCharacterOfPosition(offset);
    return {line: line + 1, column: character + 1};
  };
  const own = split?.filename === file.fileName ? split : undefined;
  const block = own?.blocks.find((candidate) => candidate.start <= start && start < candidate.end)?.type;
  return {
    file: file.fileName,
    ...at(start),
    end: at(start + length),
    ...finding,
    ...(block && {block}),
    // The `.ucf` file's own script, the only one checked so far.
    ...(own && {framework: MAIN_SCRIPT_TARGET}),
  };
}

function optional<Compiler>(load: (root: string) => Compiler, root: string): Compiler | undefined {
  try {
    return load(root);
  } catch {
    return undefined;
  }
}

function createChecked(ts: TypeScript, project: Project): Checked {
  let getSplit: Checked['getSplit'] = () => undefined;
  // Never emits: the tsconfig's emit options would only add errors about files it never writes.
  const options: ts.CompilerOptions = {...project.parsed.options, noEmit: true, allowNonTsExtensions: true};
  const root = dirname(project.configFile);
  // Runs inside Volar's proxy, after it put its own resolver on the host.
  const inner = ((createOptions: ts.CreateProgramOptions) => {
    const host = createOptions.host!;
    const importOptions = (compilerOptions: ts.CompilerOptions): UcfImportOptions => ({
      ...entryOptions(compilerOptions),
      compilerOptions,
      host,
      getSplit: (fileName) => getSplit(fileName),
    });
    host.resolveModuleNameLiterals = withUcfResolution(ts, host.resolveModuleNameLiterals!.bind(host), importOptions);
    const program = ts.createProgram(createOptions);
    // Before Volar decorates the program, so it maps our import errors into the `.ucf` file too.
    const semantic = program.getSemanticDiagnostics;
    program.getSemanticDiagnostics = (sourceFile, token) => {
      const diagnostics = semantic(sourceFile, token);
      return sourceFile
        ? withImportErrors(ts, sourceFile, diagnostics, importOptions(program.getCompilerOptions()))
        : diagnostics;
    };
    return program;
  }) as typeof ts.createProgram;
  const editorOptions = {
    ts,
    compilerOptions: options,
    compiler: optional(loadVueCompiler, root),
    svelteCompiler: optional(loadSvelteCompiler, root),
  };
  const createProgram = proxyCreateProgram(ts as Parameters<typeof proxyCreateProgram>[0], inner, () => ({
    languagePlugins: [createUcfLanguagePlugin(editorOptions)],
    setup(language) {
      getSplit = (fileName) => (language.scripts.get(fileName)?.generated?.root as UcfVirtualCode | undefined)?.split;
    },
  }));
  const program = createProgram({rootNames: project.parsed.fileNames, options, host: ts.createCompilerHost(options)});
  return {program, getSplit: (fileName) => getSplit(fileName)};
}

async function check(values: CommandValues, paths: string[]): Promise<CommandResult> {
  const cwd = process.cwd();
  const ts = projectTypeScript(cwd, `typescript is not installed in ${cwd}; add it to devDependencies`);
  const shown = (path: string) => rootRelativePath(cwd, path) || '.';
  const extraFileExtensions = [{extension: 'ucf', isMixedContent: true, scriptKind: ts.ScriptKind.Deferred}];
  const projects = new Map<string, Project>();

  const projectAt = (configFile: string): Project => {
    const key = slashed(configFile);
    let project = projects.get(key);
    if (project) return project;
    let unrecoverable: ts.Diagnostic | undefined;
    const host: ts.ParseConfigFileHost = {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => void (unrecoverable = diagnostic),
    };
    const parsed = ts.getParsedCommandLineOfConfigFile(key, {}, host, undefined, undefined, extraFileExtensions);
    if (!parsed) throw configError(ts, [unrecoverable!], cwd);
    if (parsed.errors.length > 0) throw configError(ts, parsed.errors, cwd);
    project = {configFile: key, parsed};
    projects.set(key, project);
    return project;
  };
  const checkedOf = (project: Project): Checked => (project.checked ??= createChecked(ts, project));
  // The project, then its references depth first, as tsserver looks for the project of a file.
  const chainOf = (configFile: string, chain: Project[] = []): Project[] => {
    const project = projectAt(configFile);
    if (chain.includes(project)) return chain;
    chain.push(project);
    for (const reference of project.parsed.projectReferences ?? []) chainOf(ts.resolveProjectReferencePath(reference), chain);
    return chain;
  };
  const holds = (project: Project, file: string): string | undefined => {
    const {program} = checkedOf(project);
    const sourceFile = program.getSourceFile(file);
    return sourceFile && !program.isSourceFileDefaultLibrary(sourceFile) ? sourceFile.fileName : undefined;
  };
  const filesOf = (project: Project): string[] => {
    const {program} = checkedOf(project);
    return program
      .getSourceFiles()
      .filter(
        (sourceFile) =>
          !program.isSourceFileDefaultLibrary(sourceFile) && !sourceFile.fileName.split('/').includes('node_modules')
      )
      .map(({fileName}) => fileName);
  };
  const nearest = (dir: string): string | undefined => ts.findConfigFile(slashed(dir), ts.sys.fileExists);

  const pinned = typeof values.project === 'string' ? chainOf(resolve(cwd, values.project)) : undefined;
  const selection = new Map<Project, Set<string>>();
  const assigned = new Set<string>();
  const assign = (project: Project, fileName: string): void => {
    if (assigned.has(fileName)) return;
    assigned.add(fileName);
    if (!selection.has(project)) selection.set(project, new Set());
    selection.get(project)!.add(fileName);
  };
  const owner = (chain: Project[], file: string): [Project, string] | undefined => {
    for (const project of chain) {
      const fileName = holds(project, file);
      if (fileName) return [project, fileName];
    }
    return undefined;
  };
  const fileChain = (file: string): {config?: string; chain: Project[]} => {
    if (pinned) return {config: pinned[0]!.configFile, chain: pinned};
    const config = nearest(dirname(file));
    return {config, chain: config ? chainOf(config) : []};
  };

  for (const path of paths) {
    if (!ts.sys.directoryExists(path)) {
      const {config, chain} = fileChain(path);
      if (!config) throw new Error(`${shown(path)} has no ${CONFIG_NAME} above it; add one or pass -p`);
      const found = owner(chain, path);
      if (!found) throw new Error(`${shown(path)} is not part of ${shown(config)}; add it to "include" or pass -p`);
      assign(...found);
      continue;
    }
    // Below the folder, `node_modules` and dot folders hold none of the project's files.
    const walked = new Set(filesUnder(path, '').map(slashed));
    const below = [...walked].filter((file) => basename(file) === CONFIG_NAME);
    const above = nearest(path);
    const candidates = pinned ?? [...new Set([...(above ? chainOf(above) : []), ...below.flatMap((file) => chainOf(file))])];
    if (candidates.length === 0) throw new Error(`${shown(path)} has no ${CONFIG_NAME} above or in it; add one or pass -p`);
    const files = [...new Set(candidates.flatMap(filesOf).filter((fileName) => walked.has(fileName)))];
    if (files.length === 0) throw new Error(`${shown(path)} holds no file of ${shown(candidates[0]!.configFile)}`);
    for (const file of files) assign(...(owner(fileChain(file).chain, file) ?? owner(candidates, file)!));
  }
  if (paths.length === 0) {
    const config = pinned ? undefined : nearest(cwd);
    if (!pinned && !config) throw new Error(`no ${CONFIG_NAME} in . or above it; add one or pass -p`);
    const chain = pinned ?? chainOf(config!);
    for (const project of chain) for (const fileName of filesOf(project)) assign(project, fileName);
    if (assigned.size === 0) throw new Error(`${shown(chain[0]!.configFile)} holds no file to check`);
  }

  const findings: Finding[] = [];
  for (const [project, files] of selection) {
    const {program, getSplit} = checkedOf(project);
    const global = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
    findings.push(...global.flatMap((diagnostic) => tscFinding(ts, diagnostic) ?? []));
    for (const fileName of files) {
      const sourceFile = program.getSourceFile(fileName)!;
      const split = getSplit(fileName);
      const diagnostics = [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)];
      findings.push(...diagnostics.flatMap((diagnostic) => tscFinding(ts, diagnostic, split) ?? []));
      if (split) findings.push(...split.errors.map((error) => findingOf(error, split)));
    }
  }

  const counted = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const errors = findings.filter(({severity}) => severity === 'error').length;
  const warnings = findings.length - errors;
  const problems = [errors && counted(errors, 'error'), warnings && counted(warnings, 'warning')].filter(Boolean).join(', ');
  const used = [...selection];
  const configs = used.length === 1 ? shown(used[0]![0].configFile) : `${used.length} tsconfigs`;
  return {
    findings,
    summary: `checked ${counted(assigned.size, 'file')} with ${configs}: ${problems || 'no errors'}`,
    data: {projects: used.map(([project, files]) => ({tsconfig: shown(project.configFile), files: files.size}))},
  };
}

export function runMfTsc(args: string[]): Promise<number> {
  return runCommand(MF_TSC, args, check);
}
