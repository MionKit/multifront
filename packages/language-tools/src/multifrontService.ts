import {checkBlocks} from '@multifront/core';
import {DiagnosticSeverity} from '@volar/language-server';
import type {Diagnostic, LanguageServicePlugin} from '@volar/language-server';
import {URI} from 'vscode-uri';
import type {UcfVirtualCode} from './types.ts';

/** Diagnostics on the `.ucf` file itself, not on its embedded codes. */
export const multifrontService: LanguageServicePlugin = {
  name: 'multifront',
  capabilities: {diagnosticProvider: {interFileDependencies: false, workspaceDiagnostics: false}},
  create(context) {
    return {
      provideDiagnostics(document): Diagnostic[] | undefined {
        if (document.languageId !== 'ucf') return;
        const decoded = context.decodeEmbeddedDocumentUri(URI.parse(document.uri));
        const root = decoded && context.language.scripts.get(decoded[0])?.generated?.root;
        if (!root || !('split' in root)) return;
        return checkBlocks((root as UcfVirtualCode).split).map(({start, end, severity, code, message}) => ({
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
