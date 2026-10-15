/** oxfmt's config, read as its CLI reads it: oxfmt's `format()` takes resolved options only. */
import {readFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {rootRelativePath} from '@multifront/core';
import ignore from 'ignore';
import {minimatch} from 'minimatch';
import {nearestFile, parseJsonc} from '../files.ts';
import type {EditorConfigFile, FormatOptions, FormatOverride, UcfFormatConfig} from '../types.ts';

const CONFIG_NAMES = ['.oxfmtrc.json', '.oxfmtrc.jsonc'];

function readEditorConfig(root: string): EditorConfigFile | undefined {
  const file = nearestFile(root, ['.editorconfig']);
  if (!file) return undefined;
  const sections: EditorConfigFile['sections'] = [];
  for (const line of readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((text) => text.trim())) {
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[(.*)\]$/.exec(line);
    if (section) sections.push({glob: section[1]!, properties: {}});
    // Lines before the first section (`root = true`) set nothing oxfmt reads.
    else if (line.includes('=') && sections.length > 0) {
      const at = line.indexOf('=');
      sections.at(-1)!.properties[line.slice(0, at).trim().toLowerCase()] = line
        .slice(at + 1)
        .trim()
        .toLowerCase();
    }
  }
  return {file, sections};
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

function isOverride(value: unknown): value is FormatOverride {
  if (!isObject(value) || !isStrings(value.files)) return false;
  return (
    (value.excludeFiles === undefined || isStrings(value.excludeFiles)) &&
    (value.options === undefined || isObject(value.options))
  );
}

/** The config the oxfmt CLI would use for `fileName` run from `root`: the nearest `.oxfmtrc.json`, nothing inherited. */
export function findFormatConfig(fileName: string, root: string): UcfFormatConfig {
  const file = nearestFile(dirname(fileName), CONFIG_NAMES);
  const raw = file ? parseJsonc(file, root) : {};
  const fail = (why: string) => new Error(`${rootRelativePath(root, file!)}: ${why}`);
  if (!isObject(raw)) throw fail('not a JSON object');
  const {overrides = [], ignorePatterns = [], $schema: _schema, ...options} = raw;
  if (!Array.isArray(overrides) || !overrides.every(isOverride))
    throw fail('overrides must be an array of {files, excludeFiles, options}');
  if (!isStrings(ignorePatterns)) throw fail('ignorePatterns must be an array of strings');
  const editorconfig = readEditorConfig(root);
  return {root, ...(file && {file}), options, overrides, ignorePatterns, ...(editorconfig && {editorconfig})};
}

// oxfmt's rule: a leading `./` anchors a pattern at the config's folder, as a `/` inside it does;
// any other pattern matches at any depth.
function overrideGlob(pattern: string): string {
  if (pattern.startsWith('./')) return pattern.slice(2);
  return pattern.includes('/') ? pattern : `**/${pattern}`;
}

const matches = (path: string, glob: string) => minimatch(path, glob, {dot: true});

// oxfmt's `.editorconfig` reader matches a section against the whole relative path, its `*` crossing `/`: `[*.tsx]`
// matches `src/Card.ucf.react.tsx` but `[Card.tsx]` only `Card.tsx`, and `[/Card.tsx]` nothing.
function sectionMatches(path: string, glob: string): boolean {
  const pattern = glob.replace(/\*+|\?|\{([^}]*)\}|\[!?|[.+^$()|\\]/g, (token, choices?: string) => {
    if (token.startsWith('*')) return '.*';
    if (token === '?') return '[^/]';
    if (choices !== undefined)
      return `(?:${choices
        .split(',')
        .map((choice) => choice.replace(/[.+^$()|\\]/g, '\\$&'))
        .join('|')})`;
    if (token.startsWith('[')) return token === '[!' ? '[^' : '[';
    return `\\${token}`;
  });
  return new RegExp(`^${pattern}$`).test(path);
}

function editorProperties(editorconfig: EditorConfigFile | undefined, path: string): Record<string, string> {
  if (!editorconfig) return {};
  const relative = rootRelativePath(dirname(editorconfig.file), path);
  const matching = editorconfig.sections.filter(({glob}) => sectionMatches(relative, glob));
  return Object.assign({}, ...matching.map(({properties}) => properties));
}

const numberOf = (value: string | undefined) => (value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined);
const choice = (value: string | undefined, values: Record<string, unknown>) =>
  value !== undefined && Object.hasOwn(values, value) ? values[value] : undefined;

/** `own`: the `.oxfmtrc.json` options alone; `options`: with the `.editorconfig` filling the fields still unset. */
export function formatOptions(config: UcfFormatConfig, blockPath: string): {own: FormatOptions; options: FormatOptions} {
  const own: FormatOptions = {...config.options};
  const relative = config.file ? rootRelativePath(dirname(config.file), blockPath) : blockPath;
  const any = (patterns: string[] = []) => patterns.some((pattern) => matches(relative, overrideGlob(pattern)));
  for (const override of config.overrides) {
    if (any(override.files) && !any(override.excludeFiles)) Object.assign(own, override.options);
  }
  const options: FormatOptions = {...own};
  const props = editorProperties(config.editorconfig, blockPath);
  const fill = (key: string, value: unknown) => {
    if (options[key] === undefined && value !== undefined) options[key] = value;
  };
  fill('printWidth', numberOf(props.max_line_length));
  fill('endOfLine', choice(props.end_of_line, {lf: 'lf', cr: 'cr', crlf: 'crlf'}));
  fill('useTabs', choice(props.indent_style, {tab: true, space: false}));
  // Prettier's rule: `indent_size` only with spaces.
  const indentSize = options.useTabs === false ? numberOf(props.indent_size) : undefined;
  fill('tabWidth', indentSize ?? numberOf(props.tab_width));
  fill('insertFinalNewline', choice(props.insert_final_newline, {true: true, false: false}));
  fill('singleQuote', choice(props.quote_type, {single: true, double: false}));
  return {own, options};
}

/** `ignorePatterns` are gitignore lines rooted at the config's folder. */
export function isIgnored(config: UcfFormatConfig, fileName: string): boolean {
  if (!config.file || config.ignorePatterns.length === 0) return false;
  const path = rootRelativePath(dirname(config.file), fileName);
  return !path.startsWith('../') && ignore().add(config.ignorePatterns).ignores(path);
}
