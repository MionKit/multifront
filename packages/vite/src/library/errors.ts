import {isAbsolute} from 'node:path';
import {stripVTControlCharacters} from 'node:util';
import {importerFromId} from '@multifront/core';
import type {Finding, LibraryErrorCode, Target} from '@multifront/core';
import type {Rolldown} from 'vite';
import {findingError, importFinding} from '../diagnostics.ts';
import {splitId, virtualTarget} from '../ids.ts';
import {fileOf, shownFile} from './names.ts';

/** A library build that failed on its files; `findings` is what `mf-build` prints. */
export class LibraryError extends Error {
  readonly findings: Finding[];

  constructor(message: string, findings: Finding[], options?: ErrorOptions) {
    super(message, options);
    this.name = 'LibraryError';
    this.findings = findings;
  }
}

export function libraryError(code: LibraryErrorCode, file: string, message: string): LibraryError {
  return new LibraryError(`buildLibrary: ${message}`, [importFinding({fileName: file}, code, message)]);
}

/** For a library plugin's `this.error`. */
export function libraryRollupError(code: LibraryErrorCode, file: string, message: string): Rolldown.RollupError {
  return findingError(`buildLibrary: ${message}`, importFinding({fileName: file}, code, message));
}

// plugin-vue passes Vue's 1-based columns on; Rollup's `loc` convention is 0-based.
const ONE_BASED_COLUMNS = new Set(['vite:vue']);

// Rolldown's own plugins name themselves in the message only: `[builtin:vite-transform] Only string literals ...`.
const TAGGED = /^\[([^\]\s]+)\] (.*)$/;

// Vite's CSS plugin, on a `<vue>` component's style.
const VITE_MISSING_PREPROCESSOR = /^Preprocessor dependency "([^"]+)" not found\./;

/** Vite's error for a missing preprocessor on a `<style>` block, as core reports it for the other frameworks. */
function missingPreprocessor(error: Rolldown.RollupError, firstLine: string): Finding | undefined {
  const name = error.plugin === 'vite:css' ? VITE_MISSING_PREPROCESSOR.exec(firstLine)?.[1] : undefined;
  if (name === undefined || error.id === undefined) return undefined;
  const {path, query} = splitId(error.id);
  // Only a `.front` block's id carries its lang; a plain `.less` file is no `<style>` block.
  const lang = [...query.keys()].find((key) => key.startsWith('lang.'))?.slice('lang.'.length);
  if (!lang) return undefined;
  return {
    file: path,
    code: 'missing-preprocessor',
    severity: 'error',
    message: `<style lang="${lang}"> needs ${name}; install it`,
    block: 'style',
  };
}

/** Another plugin's error: positioned only where its `loc` names a real file, never in code a compiler generated. */
function foreignFinding(error: Rolldown.RollupError): Finding {
  // Vite sets `pluginCode` to the module's source: our own code and message come in `meta`.
  const meta = error.meta as {code?: string; message?: string} | undefined;
  const firstLine = stripVTControlCharacters(error.message).split('\n')[0]!;
  const missing = missingPreprocessor(error, firstLine);
  if (missing) return missing;
  const tagged = error.plugin === undefined ? TAGGED.exec(firstLine) : null;
  const code = meta?.code ?? error.plugin ?? tagged?.[1] ?? error.code ?? 'error';
  const message = meta?.message ?? tagged?.[2] ?? firstLine;
  const source = error.loc?.file ?? error.id;
  if (source === undefined) return {code, severity: 'error', message};
  const {path, query} = splitId(source);
  // A `loc` with no file is relative to whatever the plugin parsed: a Vue `<script>` alone, say.
  const loc = error.loc?.file && isAbsolute(path) && query.size === 0 && !virtualTarget(path) ? error.loc : undefined;
  const position = loc && {line: loc.line, column: loc.column + (ONE_BASED_COLUMNS.has(error.plugin ?? '') ? 0 : 1)};
  // The module id names the block: a style query, the bare `.front` path (the Vue target) or `Card.front.react.tsx`.
  const id = error.id ?? source;
  const block = splitId(id).query.get('type') === 'style' ? 'style' : importerFromId(id).block;
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
export function frameworkError(err: unknown, framework: Target, root: string): unknown {
  const findings = buildFindings(err);
  if (!findings) return err;
  // A missing tool is no error in the library's files: `mf-build` exits 2.
  const missing = findings.find((finding) => finding.code === 'missing-preprocessor');
  if (missing) {
    // Core's finding and Vite's both name the `.front` file.
    return new Error(`buildLibrary: ${shownFile(root, missing.file!)}: ${missing.message}`, {cause: err});
  }
  const message = err instanceof Error ? err.message : String(err);
  // Output with no line we can read, from a crashed tsc say: nothing to point at.
  if (findings.length === 0) return new Error(message, {cause: err});
  return new LibraryError(
    message,
    findings.map((finding) => ({...finding, framework})),
    {cause: err}
  );
}
