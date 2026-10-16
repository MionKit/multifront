/** Format Document on a `.ucf` file: what `mf-fmt` writes, from the buffer (spec 6.1). */
import {dirname} from 'node:path';
import type {LanguageServer, LanguageServicePlugin, TextEdit} from '@volar/language-server';
import {URI} from 'vscode-uri';
import {isIgnored} from '../files.ts';
import {findFormatConfig, formatUcf, MISSING_SVELTE} from '../format/index.ts';
import {workspaceRoot} from './workspace.ts';

/** The `multifront-format` plugin; every embedded code has formatting off, so no other service formats a block. */
export function formatService(server: LanguageServer): LanguageServicePlugin {
  const {console} = server.connection;
  // Per root: the reason last logged, until a format there succeeds; and whether `missing-svelte` was logged.
  const failures = new Map<string, string>();
  const missingSvelte = new Set<string>();
  return {
    name: 'multifront-format',
    capabilities: {documentFormattingProvider: true},
    create(context) {
      return {
        async provideDocumentFormattingEdits(document, range): Promise<TextEdit[] | undefined> {
          if (document.languageId !== 'ucf') return undefined;
          const source = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))?.[0];
          if (source?.scheme !== 'file') return undefined;
          // Range formatting is out of scope: a selection gets nothing.
          const text = document.getText();
          if (document.offsetAt(range.start) !== 0 || document.offsetAt(range.end) !== text.length) return undefined;
          const file = source.fsPath;
          const root = workspaceRoot(file, server.workspaceFolders.all) ?? dirname(file);
          let formatted;
          try {
            const config = findFormatConfig(file, root);
            // mf-fmt refuses a named ignored file.
            if (isIgnored(config, file)) return undefined;
            // The client's tab size and spaces are ignored: the project's configs decide, as in mf-fmt.
            formatted = await formatUcf(file, text, config);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            if (failures.get(root) !== reason) console.warn(`multifront: no formatting in ${root} (${reason})`);
            failures.set(root, reason);
            return undefined;
          }
          failures.delete(root);
          if (formatted.missingSvelte && !missingSvelte.has(root)) {
            missingSvelte.add(root);
            console.warn(`multifront: ${MISSING_SVELTE}`);
          }
          // Findings: a block that does not parse, which the diagnostics already show.
          if (formatted.findings.length > 0 || formatted.text === text) return [];
          return [{range: {start: document.positionAt(0), end: document.positionAt(text.length)}, newText: formatted.text}];
        },
      };
    },
  };
}
