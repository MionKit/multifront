/** oxlint findings on a `.ucf` file: what `mf-lint` reports, from the buffer (spec 6.1). */
import {basename, dirname} from 'node:path';
import {DiagnosticSeverity} from '@volar/language-server';
import type {Diagnostic, LanguageServer, LanguageServicePlugin} from '@volar/language-server';
import {URI} from 'vscode-uri';
import {workspaceRoot} from '../files.ts';
import {lintUcf} from '../lint/index.ts';
import {ucfRoot} from '../multifrontService.ts';
import type {UcfLintDiagnostic} from '../types.ts';

const CONFIG_NAMES = new Set(['.oxlintrc.json', '.oxlintrc.jsonc']);

const SEVERITY: Record<UcfLintDiagnostic['severity'], DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  advice: DiagnosticSeverity.Information,
};

/** Volar caches diagnostics per document version, so a config change reloads the project and asks the client to pull. */
export function lintService(server: LanguageServer): LanguageServicePlugin {
  const {console} = server.connection;
  // Per root: the reason last logged, cleared when a lint there succeeds.
  const failures = new Map<string, string>();
  server.onInitialized(() => {
    server.fileWatcher
      .watchFiles([...CONFIG_NAMES].map((name) => `**/${name}`))
      .catch((err: unknown) => console.warn(`multifront: no .oxlintrc.json watcher (${String(err)})`));
  });
  server.fileWatcher.onDidChangeWatchedFiles(({changes}) => {
    if (!changes.some(({uri}) => CONFIG_NAMES.has(basename(URI.parse(uri).path)))) return;
    server.project.reload();
    void server.languageFeatures.requestRefresh(false);
  });
  return {
    name: 'multifront-lint',
    capabilities: {diagnosticProvider: {interFileDependencies: false, workspaceDiagnostics: false}},
    create(context) {
      return {
        async provideDiagnostics(document): Promise<Diagnostic[] | undefined> {
          if (document.languageId !== 'ucf') return undefined;
          const source = context.decodeEmbeddedDocumentUri(URI.parse(document.uri))?.[0];
          const root = ucfRoot(context, document.uri);
          if (source?.scheme !== 'file' || !root) return undefined;
          const file = source.fsPath;
          const folder = workspaceRoot(file, server.workspaceFolders.all) ?? dirname(file);
          let diagnostics;
          try {
            // The buffer's split, not the file on disk.
            diagnostics = await lintUcf([root.split], folder);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            if (failures.get(folder) !== reason) console.warn(`multifront: no linting in ${folder} (${reason})`);
            failures.set(folder, reason);
            return undefined;
          }
          failures.delete(folder);
          // As oxlint's own language server words a finding.
          return diagnostics.map(({start, end, severity, code, url, message, help}) => ({
            range: {start: document.positionAt(start), end: document.positionAt(end)},
            severity: SEVERITY[severity],
            code,
            ...(url && {codeDescription: {href: url}}),
            source: 'oxlint',
            message: help ? `${message}\nhelp: ${help}` : message,
          }));
        },
      };
    },
  };
}
