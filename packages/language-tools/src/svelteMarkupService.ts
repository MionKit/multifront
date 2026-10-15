// Completions in the `<svelte>` markup: HTML plus Svelte's elements, directives and `{#…}`, `{@…}`, `{:…}` blocks.
// Each item is valid Svelte where it lands.
import {CompletionItemKind, InsertTextFormat} from '@volar/language-server';
import type {CompletionItem, LanguageServicePlugin, TextEdit} from '@volar/language-server';
import {create as createHtmlService} from 'volar-service-html';
import {ucfRoot} from './multifrontService.ts';
import {META_ELEMENTS, svelteHtmlData} from './svelteHtmlData.ts';
import {SVELTE_MARKUP_LANGUAGE, inText, isComponent, openAt, scanMarkup} from './svelteMarkup.ts';
import type {MarkupOpen, MarkupScan} from './types.ts';

interface BlockItem {
  label: string;
  snippet: string; // what follows the sigil, its closing `}` included
  fits?(open: MarkupOpen | undefined): boolean; // the innermost open element or block; default: anywhere
}

const isBlock = (open: MarkupOpen | undefined, ...names: string[]): open is MarkupOpen =>
  open?.kind === 'block' && names.includes(open.name);
// Svelte's `const_tag_invalid_placement` rule.
const CONST_BRANCHES: ReadonlySet<string> = new Set(['if', 'else if', 'else', 'each', 'snippet', 'then', 'catch']);
// A component's other attributes are props, from tsserver; Svelte rejects `class:`, `use:` and the like on it.
const COMPONENT_ATTRIBUTES: ReadonlySet<string> = new Set(['bind:', 'bind:this']);

const BLOCK_ITEMS: Record<string, BlockItem[]> = {
  '#': [
    {label: 'if', snippet: 'if ${1:condition}}\n\t$0\n{/if}'},
    {label: 'each', snippet: 'each ${1:items} as ${2:item}}\n\t$0\n{/each}'},
    {label: 'await', snippet: 'await ${1:promise}}\n\t$2\n{:then ${3:value}}\n\t$0\n{/await}'},
    {label: 'key', snippet: 'key ${1:value}}\n\t$0\n{/key}'},
    {label: 'snippet', snippet: 'snippet ${1:name}()}\n\t$0\n{/snippet}'},
  ],
  '@': [
    {label: 'render', snippet: 'render ${1:children}()}'},
    {label: 'html', snippet: 'html ${1:content}}'},
    {
      label: 'const',
      snippet: 'const ${1:name} = ${2:value}}',
      fits: (open) =>
        open?.kind === 'block'
          ? CONST_BRANCHES.has(open.branch)
          : !!open && (isComponent(open.name) || open.name === 'svelte:boundary'),
    },
    {label: 'debug', snippet: 'debug ${1:name}}'},
  ],
  ':': [
    // A clause the block already has, before or after the cursor, is Svelte's `block_duplicate_clause`.
    {label: 'else', snippet: 'else}', fits: (open) => isBlock(open, 'if', 'each') && !open.clauses.has('else')},
    {label: 'then', snippet: 'then ${1:value}}', fits: (open) => isBlock(open, 'await') && !open.clauses.has('then')},
    {label: 'catch', snippet: 'catch ${1:error}}', fits: (open) => isBlock(open, 'await') && !open.clauses.has('catch')},
  ],
};

const snippet = (item: CompletionItem, edit: TextEdit, newText: string): CompletionItem => ({
  ...item,
  insertTextFormat: InsertTextFormat.Snippet,
  textEdit: {...edit, newText},
});

// `start`: offset of the tag name in the block.
function tagItem(item: CompletionItem, edit: TextEdit, scan: MarkupScan, start: number): CompletionItem[] {
  const topLevel = openAt(scan, start - 1).length === 0;
  if (META_ELEMENTS.has(item.label) && (!topLevel || scan.metas.has(item.label))) return [];
  // Styles are root `<style>` blocks; a block takes one instance `<script>`.
  if (topLevel && (item.label === 'style' || (item.label === 'script' && scan.hasScript))) return [];
  if (item.label === 'svelte:element') return [snippet(item, edit, 'svelte:element this={$1}')];
  return [item];
}

// Directives and Svelte 5 event attributes take an expression, a prefix a name; every `:` attribute is ours, not HTML's.
function attributeItem(item: CompletionItem, edit: TextEdit, block: string, scan: MarkupScan, start: number): CompletionItem[] {
  const {label} = item;
  const tag = scan.tags.findLast((candidate) => candidate.start < start);
  // An unclosed tag runs to the next `<` or the content end: an edit there is still inside it.
  const inTag = !!tag && (start < tag.end || (start === tag.end && block[tag.end - 1] !== '>'));
  if (inTag && isComponent(tag.name) && !COMPONENT_ATTRIBUTES.has(label)) return [];
  if (label.endsWith(':')) return [snippet(item, edit, `${label}\${1:name}`)];
  const directive = /^[a-z]+:/.test(label) || /^on[a-z]+$/.test(label);
  if (directive && /^[^=]+=(["']?)\$1\1$/.test(edit.newText)) return [snippet(item, edit, `${label}={$1}`)];
  return [item];
}

/** The HTML service on the `svelte-markup` code, its items made valid Svelte. */
export function svelteHtmlService(): LanguageServicePlugin {
  const html = createHtmlService({documentSelector: [SVELTE_MARKUP_LANGUAGE], getCustomData: () => [svelteHtmlData]});
  return {
    ...html,
    name: 'multifront-svelte-html',
    create(context) {
      const instance = html.create(context);
      return {
        ...instance,
        async provideCompletionItems(document, position, completionContext, token) {
          const list = await instance.provideCompletionItems?.(document, position, completionContext, token);
          const block = list && ucfRoot(context, document.uri)?.split.targets.svelte;
          if (!list || !block) return list;
          // The markup document blanks `{…}`; what is open comes from the block as written, at the same offsets.
          const scan = scanMarkup(block.content);
          const items = list.items.flatMap((item) => {
            const edit = item.textEdit && 'range' in item.textEdit ? item.textEdit : undefined;
            if (!edit) return [item];
            const start = document.offsetAt(edit.range.start);
            return block.content[start - 1] === '<'
              ? tagItem(item, edit, scan, start)
              : attributeItem(item, edit, block.content, scan, start);
          });
          return {...list, items};
        },
      };
    },
  };
}

/** `{#if}` and the others, on the `.ucf` document: the markup document has every `{…}` blanked. */
export const svelteBlocksService: LanguageServicePlugin = {
  name: 'multifront-svelte-markup',
  capabilities: {completionProvider: {triggerCharacters: ['#', '@', ':']}},
  create(context) {
    return {
      provideCompletionItems(document, position) {
        if (document.languageId !== 'ucf') return;
        const block = ucfRoot(context, document.uri)?.split.targets.svelte;
        if (!block) return;
        const {content, contentStart} = block;
        const offset = document.offsetAt(position) - contentStart;
        if (offset < 0 || offset > content.length) return;
        const typed = /\{([#@:])(\w*)$/.exec(content.slice(0, offset));
        if (!typed) return;
        // The rest of the word, and the `}` an editor auto-closed.
        let end = offset;
        while (/\w/.test(content[end] ?? '')) end++;
        if (content[end] === '}') end++;
        // Read without what is being typed: a finished `{:else` must not count as a clause the block has.
        const scan = scanMarkup(content.slice(0, typed.index) + ' '.repeat(end - typed.index) + content.slice(end));
        if (!inText(scan, typed.index)) return;
        const innermost = openAt(scan, typed.index).at(-1);
        const range = {
          start: document.positionAt(contentStart + typed.index + 2),
          end: document.positionAt(contentStart + end),
        };
        const items = BLOCK_ITEMS[typed[1]!]!.filter(({fits}) => fits?.(innermost) ?? true).map(
          ({label, snippet: newText}): CompletionItem => ({
            label,
            kind: CompletionItemKind.Keyword,
            detail: `{${typed[1]}${label}}`,
            insertTextFormat: InsertTextFormat.Snippet,
            textEdit: {range, newText},
          })
        );
        return {isIncomplete: false, items};
      },
    };
  },
};
