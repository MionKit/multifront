import {isAbsolute} from 'node:path';
import {importerFromId} from '@multifront/core';
import type {Finding, LibraryErrorCode, Target} from '@multifront/core';
import type {Rolldown} from 'vite';
import {findingError} from '../diagnostics.ts';
import {splitId, virtualTarget} from '../ids.ts';
import {fileOf} from './names.ts';

/** A library build that failed on its files; `findings` is what `mf-build` prints. */
export class LibraryError extends Error {
  readonly findings: Finding[];

  constructor(message: string, findings: Finding[], options?: ErrorOptions) {
    super(message, options);
    this.name = 'LibraryError';
    this.findings = findings;
  }
}

function libraryFinding(code: LibraryErrorCode, file: string, message: string): Finding {
  return {file, code, severity: 'error', message};
}

export function libraryError(code: LibraryErrorCode, file: string, message: string): LibraryError {
  return new LibraryError(`buildLibrary: ${message}`, [libraryFinding(code, file, message)]);
}

/** For a library plugin's `this.error`. */
export function libraryRollupError(code: LibraryErrorCode, file: string, message: string): Rolldown.RollupError {
  return findingError(`buildLibrary: ${message}`, libraryFinding(code, file, message));
}

// plugin-vue passes Vue's 1-based columns on; Rollup's `loc` convention is 0-based.
const ONE_BASED_COLUMNS = new Set(['vite:vue']);

/** Another plugin's error: positioned only in a real file, never in code a compiler generated. */
function foreignFinding(error: Rolldown.RollupError): Finding {
  const own = typeof error.pluginCode === 'string' ? error.pluginCode : undefined;
  const code = own ?? (error.code === 'PLUGIN_ERROR' && error.plugin ? error.plugin : error.code) ?? 'error';
  const message = (error.meta as {message?: string} | undefined)?.message ?? error.message.split('\n')[0]!;
  const source = error.loc?.file ?? error.id;
  if (source === undefined) return {code, severity: 'error', message};
  const {path, query} = splitId(source);
  const real = isAbsolute(path) && query.size === 0 && !virtualTarget(path);
  const loc = real ? error.loc : undefined;
  const column = loc && loc.column + (ONE_BASED_COLUMNS.has(error.plugin ?? '') ? 0 : 1);
  const position = loc && {line: loc.line, column};
  // The module id names the block: the bare `.ucf` path is the Vue target's, `Card.ucf.react.tsx` the React one's.
  const block = importerFromId(error.id ?? source).block;
  return {file: fileOf(source), ...position, code, severity: 'error', message, ...(block && {block})};
}

function buildFindings(err: unknown): Finding[] | undefined {
  if (err instanceof LibraryError) return err.findings;
  const errors = (err as Partial<Rolldown.BundleError> | undefined)?.errors;
  if (!Array.isArray(errors)) return undefined;
  return errors.flatMap((error: Rolldown.RollupError & {findings?: Finding[]}) => {
    const meta = error.meta as {findings?: Finding[]} | undefined;
    return error.findings ?? meta?.findings ?? [foreignFinding(error)];
  });
}

/** A failed framework build as a `LibraryError` naming the framework; anything else, a config error say, unchanged. */
export function frameworkError(err: unknown, framework: Target): unknown {
  const findings = buildFindings(err);
  if (!findings) return err;
  const message = err instanceof Error ? err.message : String(err);
  // Output with no line we can read, from a crashed tsc say: nothing to point at.
  if (findings.length === 0) return new Error(message, {cause: err});
  return new LibraryError(
    message,
    findings.map((finding) => ({...finding, framework})),
    {cause: err}
  );
}
