import {checkBlocks} from '@multifront/core';
import {DiagnosticSeverity} from '@volar/language-server';
import type {Diagnostic, LanguageServiceContext, LanguageServicePlugin} from '@volar/language-server';
import {URI} from 'vscode-uri';
import {TSSERVER_CODES} from './tsserverCodes.ts';
import type {FrontVirtualCode} from './types.ts';

/** From the `.front` document or any of its embedded ones. */
export function frontRoot(context: LanguageServiceContext, uri: string): FrontVirtualCode | undefined {
  const decoded = context.decodeEmbeddedDocumentUri(URI.parse(uri));
  const root = decoded && context.language.scripts.get(decoded[0])?.generated?.root;
  return root && 'split' in root ? (root as FrontVirtualCode) : undefined;
}

/** Diagnostics on the `.front` file itself, not on its embedded codes. */
export const multifrontService: LanguageServicePlugin = {
  name: 'multifront',
  capabilities: {diagnosticProvider: {interFileDependencies: false, workspaceDiagnostics: false}},
  create(context) {
    return {
      provideDiagnostics(document): Diagnostic[] | undefined {
        if (document.languageId !== 'front') return;
        const root = frontRoot(context, document.uri);
        if (!root) return;
        return checkBlocks(root.split)
          .filter(({code}) => !TSSERVER_CODES.has(code))
          .map(({start, end, severity, code, message}) => ({
            range: {start: document.positionAt(start), end: document.positionAt(end)},
            severity: severity === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
            code,
            message,
            source: 'multifront',
          }));
      },
    };
  },
};
