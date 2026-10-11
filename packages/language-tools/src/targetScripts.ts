// Volar's tsserver plugin serves one script per file (the main target's); every other target with a `serviceScript`
// becomes a program file of its own, `Card.ucf.<target>.ts`, and requests in its block are routed to it.
import {isTarget} from '@multifront/core';
import type {Target} from '@multifront/core';
import {
  FileMap,
  createLanguage,
  isDefinitionEnabled,
  isHighlightEnabled,
  isImplementationEnabled,
  isReferencesEnabled,
  isRenameEnabled,
  isTypeDefinitionEnabled,
} from '@volar/language-core';
import type {CodeInformation, Language, LanguagePlugin, VirtualCode} from '@volar/language-core';
import {createProxyLanguageService} from '@volar/typescript/lib/node/proxyLanguageService.js';
import {transformDocumentSpan} from '@volar/typescript/lib/node/transform.js';
import type {TypeScriptServiceScript} from '@volar/typescript';
import type * as ts from 'typescript';
import {EDITOR_BLOCK_KINDS} from './blocks/index.ts';
import type {EditorBlockKind, TargetScript, TypeScript, UcfVirtualCode} from './types.ts';

type ServedKind = EditorBlockKind & {tag: Target; serviceScript: NonNullable<EditorBlockKind['serviceScript']>};

const SERVED_KINDS = EDITOR_BLOCK_KINDS.filter((kind): kind is ServedKind => !!kind.serviceScript && isTarget(kind.tag));
const TARGET_SCRIPT_NAME = /^(.*\.ucf)\.(\w+)\.ts$/;

// Their locations in a target script name a file no editor can open: they are moved into the `.ucf` file.
const NAVIGATION_FILTERS = {
  getDefinitionAtPosition: isDefinitionEnabled,
  getDefinitionAndBoundSpan: isDefinitionEnabled,
  getTypeDefinitionAtPosition: isTypeDefinitionEnabled,
  getImplementationAtPosition: isImplementationEnabled,
  getReferencesAtPosition: isReferencesEnabled,
  findReferences: isReferencesEnabled,
  getDocumentHighlights: isHighlightEnabled,
  findRenameLocations: isRenameEnabled,
} as const satisfies Partial<Record<keyof ts.LanguageService, (info: CodeInformation) => boolean>>;
type Navigation = keyof typeof NAVIGATION_FILTERS;
const NAVIGATION = Object.keys(NAVIGATION_FILTERS) as Navigation[];
const DEFINITIONS: Navigation[] = [
  'getDefinitionAtPosition',
  'getDefinitionAndBoundSpan',
  'getTypeDefinitionAtPosition',
  'getImplementationAtPosition',
];
// Volar's proxy maps these; each takes the position right after the file name.
const BY_POSITION = [
  ...NAVIGATION,
  'getQuickInfoAtPosition',
  'getCompletionsAtPosition',
  'getCompletionEntryDetails',
  'getSignatureHelpItems',
  'getRenameInfo',
  'getLinkedEditingRangeAtPosition',
  'prepareCallHierarchy',
  'getCodeFixesAtPosition',
] as const satisfies (keyof ts.LanguageService)[];
const DIAGNOSTICS = ['getSyntacticDiagnostics', 'getSemanticDiagnostics', 'getSuggestionDiagnostics'] as const;

/** A target whose script tsserver serves as `Card.ucf.<target>.ts`; its picks resolve there, from any importer. */
export function isServedTarget(target: Target): boolean {
  return SERVED_KINDS.some(({tag}) => tag === target);
}

/** `Card.ucf.vue.ts`: the tsserver file of a target served beside the `.ucf` file's own script. */
export function targetScriptName(fileName: string, target: Target): string {
  return `${fileName}.${target}.ts`;
}

function parseTargetScriptName(fileName: string): {ucf: string; kind: ServedKind} | undefined {
  const [, ucf, tag] = TARGET_SCRIPT_NAME.exec(fileName) ?? [];
  const kind = SERVED_KINDS.find((served) => served.tag === tag);
  return ucf && kind ? {ucf, kind} : undefined;
}

function targetScript(main: Language<string>, ucf: string, kind: ServedKind): TargetScript | undefined {
  const code = main.scripts.get(ucf)?.generated?.root.embeddedCodes?.find(({id}) => id === kind.tag);
  return code && kind.serviceScript(code);
}

const ucfOf = (fileName: string): string | undefined => parseTargetScriptName(fileName)?.ucf;

type Served = ReturnType<typeof createProxyLanguageService> & {kind: ServedKind; language?: Language<string>};

// `X.ucf` is only a source here; `X.ucf.vue.ts` is a code mapped into it, so Volar's proxy sends `X.ucf` requests there.
function createTargetLanguage(main: Language<string>, kind: ServedKind, caseSensitive: boolean): Language<string> {
  const languageId = `ucf-${kind.tag}`;
  const scriptKinds = new WeakMap<VirtualCode, ts.ScriptKind>();
  const plugin: LanguagePlugin<string> = {
    getLanguageId: (id) => (id.endsWith('.ucf') ? 'ucf' : parseTargetScriptName(id)?.kind === kind ? languageId : undefined),
    isAssociatedFileOnly: (_id, id) => id === 'ucf',
    createVirtualCode(id, scriptLanguageId, snapshot, ctx) {
      const parsed = scriptLanguageId === languageId ? parseTargetScriptName(id) : undefined;
      const script = parsed && targetScript(main, parsed.ucf, kind);
      if (!parsed || !script || !ctx.getAssociatedScript(parsed.ucf)) return undefined;
      const {mappings, linkedCodeMappings} = script.code;
      const associatedScriptMappings = new Map([[parsed.ucf, mappings]]);
      // Linked codes take a template use to its `<script setup>` binding.
      const code: VirtualCode = {
        id: 'main',
        languageId: 'typescript',
        snapshot,
        mappings: [],
        associatedScriptMappings,
        linkedCodeMappings,
      };
      scriptKinds.set(code, script.scriptKind);
      return code;
    },
    typescript: {
      extraFileExtensions: [],
      getServiceScript: (code): TypeScriptServiceScript => ({
        code,
        extension: '.ts',
        scriptKind: scriptKinds.get(code)!,
        preventLeadingOffset: true,
      }),
    },
  };
  const language = createLanguage([plugin], new FileMap(caseSensitive), (id) => {
    const parsed = parseTargetScriptName(id);
    const snapshot = parsed
      ? targetScript(main, parsed.ucf, kind)?.code.snapshot
      : id.endsWith('.ucf')
        ? main.scripts.get(id)?.snapshot
        : undefined;
    if (snapshot) language.scripts.set(id, snapshot);
    else language.scripts.delete(id);
  });
  return language;
}

/** Decorates the host now, before Volar binds it; `setup` and `route` run once Volar made its own language. */
export function serveTargetScripts(ts: TypeScript, info: ts.server.PluginCreateInfo, base: ts.LanguageService) {
  const host = info.languageServiceHost;
  const project = info.project;
  let main: Language<string> | undefined;
  const served: Served[] = SERVED_KINDS.map((kind) => ({kind, ...createProxyLanguageService(base)}));

  const scriptOf = (fileName: string): TargetScript | undefined => {
    const parsed = parseTargetScriptName(fileName);
    return parsed && main && targetScript(main, parsed.ucf, parsed.kind);
  };
  // tsserver keeps every program file's parse on its ScriptInfo: the file needs one, though it is on no disk.
  const attachScriptInfo = (fileName: string, scriptKind: ts.ScriptKind): void => {
    const path = ts.server.toNormalizedPath(fileName);
    const hasMixedContent = true; // no watcher on a file that is not there
    const scriptInfo = project.projectService.getOrCreateScriptInfoForNormalizedPath(
      path,
      false,
      undefined,
      scriptKind,
      hasMixedContent,
      {
        fileExists: () => true,
      }
    );
    scriptInfo?.attachToProject(project);
  };

  const getScriptFileNames = host.getScriptFileNames.bind(host);
  const getScriptSnapshot = host.getScriptSnapshot.bind(host);
  const getScriptVersion = host.getScriptVersion.bind(host);
  const getScriptKind = host.getScriptKind?.bind(host);
  const fileExists = host.fileExists?.bind(host);
  // Script names the project itself does not list, read from the last program.
  const addedScriptNames = (names: readonly string[]): string[] => {
    if (!main) return [];
    // An imported `.ucf` file is no root: the last program brings it, and the next one its target scripts.
    const imported = project.getFileNames(true, true);
    // A target script brings its `.ucf` file too: in the program, an edit of it marks this project dirty.
    const reached = [...new Set(imported.flatMap((name) => ucfOf(name) ?? []))].filter((ucf) => !names.includes(ucf));
    const ucfs = new Set([...names, ...imported, ...reached].filter((name) => name.endsWith('.ucf')));
    const targets = [...ucfs].flatMap((ucf) =>
      SERVED_KINDS.filter((kind) => targetScript(main!, ucf, kind)).map(({tag}) => targetScriptName(ucf, tag))
    );
    return [...reached, ...targets];
  };
  host.getScriptFileNames = () => {
    const names = getScriptFileNames();
    return [...names, ...addedScriptNames(names)];
  };
  host.getScriptSnapshot = (fileName) => {
    const script = scriptOf(fileName);
    if (!script) return getScriptSnapshot(fileName);
    attachScriptInfo(fileName, script.scriptKind);
    return script.code.snapshot;
  };
  // The script changes exactly when its `.ucf` file does.
  host.getScriptVersion = (fileName) => getScriptVersion(parseTargetScriptName(fileName)?.ucf ?? fileName);
  if (getScriptKind) host.getScriptKind = (fileName) => scriptOf(fileName)?.scriptKind ?? getScriptKind(fileName);
  if (fileExists) host.fileExists = (fileName) => (parseTargetScriptName(fileName) ? !!scriptOf(fileName) : fileExists(fileName));

  // Only a script the program holds: a `.ucf` file first seen through an import gets its own on the next sync.
  const servedIn = (fileName: string): Served[] => {
    const program = base.getProgram();
    return served.filter(({kind, language}) => {
      const name = targetScriptName(fileName, kind.tag);
      return program?.getSourceFile(name) && language?.scripts.get(name)?.generated;
    });
  };
  const servedAt = (fileName: string, position: number): Served | undefined => {
    const split = (main?.scripts.get(fileName)?.generated?.root as UcfVirtualCode | undefined)?.split;
    return servedIn(fileName).find(({kind}) => {
      const block = split?.targets[kind.tag];
      return block && position >= block.contentStart && position <= block.contentEnd;
    });
  };

  // Volar's main proxy leaves a `.ts` importer's locations in a target script; a `.ucf` request's are unmapped ones.
  // `fallback`: an unmapped span becomes the `.ucf` file itself, as Volar does for a `.vue` file.
  const intoUcfSpan = <Span extends ts.DocumentSpan>(span: Span, method: Navigation, fallback: boolean): Span | undefined => {
    const parsed = parseTargetScriptName(span.fileName);
    if (!parsed) return span;
    const language = served.find(({kind}) => kind === parsed.kind)?.language;
    const anyMatch = method !== 'findRenameLocations';
    const mapped = language && transformDocumentSpan(language, span, anyMatch, NAVIGATION_FILTERS[method]);
    if (mapped && !ucfOf(mapped.fileName)) return mapped;
    return fallback ? {...span, fileName: parsed.ucf, textSpan: {start: 0, length: 0}, contextSpan: undefined} : undefined;
  };
  // An unmapped definition in the requested file's own script is generated code, dropped.
  const spansIntoUcf = <Span extends ts.DocumentSpan>(spans: readonly Span[], method: Navigation, from: string): Span[] =>
    spans.flatMap((span) => intoUcfSpan(span, method, DEFINITIONS.includes(method) && ucfOf(span.fileName) !== from) ?? []);
  const intoUcf = (result: unknown, method: Navigation, from: string): unknown => {
    if (!result) return result;
    // Only a `.ucf` request searches a target script; Volar mapped the spans and kept the group's name.
    if (method === 'getDocumentHighlights') {
      return (result as ts.DocumentHighlights[]).map((group) => ({
        ...group,
        fileName: ucfOf(group.fileName) ?? group.fileName,
        highlightSpans: group.highlightSpans.map((span) => ({
          ...span,
          fileName: span.fileName && (ucfOf(span.fileName) ?? span.fileName),
        })),
      }));
    }
    if (method === 'getDefinitionAndBoundSpan') {
      const info = result as ts.DefinitionInfoAndBoundSpan;
      return {...info, definitions: info.definitions && spansIntoUcf(info.definitions, method, from)};
    }
    if (method === 'findReferences') {
      return (result as ts.ReferencedSymbol[]).map(({definition, references}) => ({
        definition: intoUcfSpan(definition, method, true)!,
        references: spansIntoUcf(references, method, from),
      }));
    }
    return spansIntoUcf(result as ts.DocumentSpan[], method, from);
  };

  return {
    // Runs once a program is built: a file it reached first (a `.ucf` file, a target script) is a script name of the
    // next one, and tsserver builds that only when the project is dirty.
    afterUpdate(): void {
      const inProgram = new Set(project.getFileNames(true, true));
      const stale = addedScriptNames(getScriptFileNames()).some((name) => !inProgram.has(ts.server.toNormalizedPath(name)));
      if (stale) (project as ts.server.Project & {markAsDirty(): void}).markAsDirty();
    },
    setup(language: Language<string>): void {
      main = language;
      for (const target of served) {
        target.language = createTargetLanguage(language, target.kind, ts.sys.useCaseSensitiveFileNames);
        target.initialize(target.language);
      }
    },
    route(languageService: ts.LanguageService): ts.LanguageService {
      const routed: Partial<ts.LanguageService> = {};
      for (const method of BY_POSITION) {
        routed[method] = ((fileName: string, position: number, ...rest: unknown[]) => {
          const target = fileName.endsWith('.ucf') ? servedAt(fileName, position) : undefined;
          // TypeScript searches only the files the client listed: the target script must be one of them.
          if (target && method === 'getDocumentHighlights') {
            const filesToSearch = rest[0] as string[];
            rest[0] = [
              ...filesToSearch,
              ...filesToSearch.filter((name) => name.endsWith('.ucf')).map((ucf) => targetScriptName(ucf, target.kind.tag)),
            ];
          }
          const service = target?.proxy ?? languageService;
          const result = (service[method] as (...args: unknown[]) => unknown)(fileName, position, ...rest);
          return (NAVIGATION as readonly string[]).includes(method) ? intoUcf(result, method as Navigation, fileName) : result;
        }) as never;
      }
      for (const method of DIAGNOSTICS) {
        routed[method] = ((fileName: string) => {
          const own = languageService[method](fileName);
          if (!fileName.endsWith('.ucf')) return own;
          return [...own, ...servedIn(fileName).flatMap(({proxy}) => proxy[method](fileName))];
        }) as never;
      }
      return {...languageService, ...routed};
    },
  };
}
