// Vue's template services ask tsserver for components, elements, attributes, props and directives. Vue's own `_vue:*`
// handlers need a `VueVirtualCode` root; ours run the same request functions on the code nested in a `.ucf` file.
import type {Language, SourceScript, VirtualCode} from '@volar/language-core';
import type {TypeScriptServiceScript} from '@volar/typescript';
import type {VueVirtualCode} from '@vue/language-core';
import {getComponentDirectives} from '@vue/typescript-plugin/lib/requests/getComponentDirectives.js';
import {getComponentNames} from '@vue/typescript-plugin/lib/requests/getComponentNames.js';
import {getComponentProps} from '@vue/typescript-plugin/lib/requests/getComponentProps.js';
import {getElementAttrs} from '@vue/typescript-plugin/lib/requests/getElementAttrs.js';
import {getElementNames} from '@vue/typescript-plugin/lib/requests/getElementNames.js';
import type * as ts from 'typescript';
import {VUE_REQUESTS, vueEditorKind, vueRequestCommand} from './blocks/vue.ts';
import {targetScriptName} from './targetScripts.ts';
import type {TypeScript} from './types.ts';

type VueRequest = (typeof VUE_REQUESTS)[number];

type Answer = (name: VueRequest, fileName: string, args: unknown[]) => object | undefined;

// Symbol.for: the plugin copy that registered the handlers may not be the one serving the project.
const ANSWER = Symbol.for('multifront.vue-requests');

type AnsweringProject = ts.server.Project & {[ANSWER]?: Answer};

function createAnswer(typescript: TypeScript, language: Language<string>, base: ts.LanguageService): Answer {
  const tsModule = typescript as typeof ts;
  return (name, fileName, args) => {
    const sourceScript = language.scripts.get(fileName);
    const vue = sourceScript?.generated?.root.embeddedCodes?.find(({id}) => id === 'vue') as VueVirtualCode | undefined;
    const script = vue && vueEditorKind.serviceScript?.(vue);
    const scriptName = targetScriptName(fileName, 'vue');
    const program = base.getProgram();
    if (!sourceScript?.generated || !vue || !script || !program?.getSourceFile(scriptName)) return undefined;
    // The request functions read the `.ucf` file's program file; its Vue script is `Card.ucf.vue.ts`.
    const vueProgram = new Proxy(program, {
      get: (target, key, receiver) =>
        key === 'getSourceFile'
          ? (requested: string) => target.getSourceFile(requested === fileName ? scriptName : requested)
          : Reflect.get(target, key, receiver),
    });
    switch (name) {
      case 'getComponentNames':
        return getComponentNames(tsModule, vueProgram, vue);
      case 'getElementNames':
        return getElementNames(tsModule, vueProgram, fileName);
      case 'getElementAttrs':
        return getElementAttrs(tsModule, vueProgram, fileName, args[0] as string);
      case 'getComponentDirectives':
        return getComponentDirectives(tsModule, vueProgram, fileName);
      case 'getComponentProps':
        return getComponentProps(
          tsModule,
          base,
          program,
          language,
          withServiceScript(sourceScript, script.code, script.scriptKind),
          {fileName: scriptName, ir: vue.ir} as VueVirtualCode,
          args[0] as number
        );
    }
  };
}

// `getComponentProps` maps a template offset through the script's service script: the Vue script, in its own file.
function withServiceScript(
  sourceScript: SourceScript<string>,
  code: VirtualCode,
  scriptKind: ts.ScriptKind
): SourceScript<string> {
  const generated = sourceScript.generated!;
  const serviceScript: TypeScriptServiceScript = {code, extension: '.ts', scriptKind, preventLeadingOffset: true};
  const typescript = {...generated.languagePlugin.typescript!, getServiceScript: () => serviceScript};
  return {...sourceScript, generated: {...generated, languagePlugin: {...generated.languagePlugin, typescript}}};
}

/** Our tsserver protocol handlers for `VUE_REQUESTS`, answered from this project's Volar language. */
export function serveVueRequests(
  typescript: TypeScript,
  info: ts.server.PluginCreateInfo,
  language: Language<string>,
  base: ts.LanguageService
): void {
  (info.project as AnsweringProject)[ANSWER] = createAnswer(typescript, language, base);
  const {session} = info;
  const projectService = info.project.projectService;
  for (const name of VUE_REQUESTS) {
    const command = vueRequestCommand(name);
    try {
      session?.addProtocolHandler(command, (request) => {
        const [fileName, ...args] = (request.arguments ?? []) as [string, ...unknown[]];
        const path = typescript.server.toNormalizedPath(fileName);
        const project = projectService.getDefaultProjectForFile(path, false) as AnsweringProject | undefined;
        return {response: project?.[ANSWER]?.(name, path, args), responseRequired: true};
      });
    } catch {
      // Registered already, per session: by another project, a tsconfig reload or another plugin copy.
    }
  }
}
