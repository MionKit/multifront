import {BLOCK_KINDS, getBlockKind} from './blocks/index.ts';
import type {Block, BlockTag, SplitResult, Target} from './types.ts';

const ROOT_TAGS: ReadonlySet<string> = new Set(BLOCK_KINDS.map((kind) => kind.tag));

const isSpace = (char: string | undefined): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
const isNameStart = (char: string | undefined): boolean => char !== undefined && /[A-Za-z]/.test(char);
const isRootTag = (name: string): name is BlockTag => ROOT_TAGS.has(name);

function isTargetTag(tag: BlockTag): tag is Target {
  return getBlockKind(tag).role === 'target';
}

interface OpeningTag {
  attrs: Block['attrs'];
  end: number; // just after its '>'
}

// `pos` = just after the tag name; undefined = the tag never ends cleanly (counts as unclosed).
function readOpeningTag(source: string, pos: number): OpeningTag | undefined {
  const attrs: Block['attrs'] = {};
  while (pos < source.length) {
    const char = source[pos];
    if (char === '>') return {attrs, end: pos + 1};
    // A self-closing root tag would otherwise take the next block as its content.
    if (char === '/' && source[pos + 1] === '>') return undefined;
    if (isSpace(char) || char === '/') {
      pos++;
      continue;
    }
    const nameStart = pos;
    while (pos < source.length && !isSpace(source[pos]) && !'=>/'.includes(source[pos]!)) pos++;
    const name = source.slice(nameStart, pos);
    let valueStart = pos;
    while (isSpace(source[valueStart])) valueStart++;
    if (source[valueStart] !== '=') {
      attrs[name] = true;
      continue;
    }
    pos = valueStart + 1;
    while (isSpace(source[pos])) pos++;
    const quote = source[pos];
    if (quote === '"' || quote === "'") {
      const close = source.indexOf(quote, pos + 1);
      // A quote left open would run on into the next block.
      if (close === -1 || /[>\n]/.test(source.slice(pos + 1, close))) return undefined;
      attrs[name] = source.slice(pos + 1, close);
      pos = close + 1;
    } else {
      const start = pos;
      while (pos < source.length && !isSpace(source[pos]) && source[pos] !== '>') pos++;
      attrs[name] = source.slice(start, pos);
    }
  }
  return undefined;
}

// Browser `<script>` rule: the first `</tag` followed by '>' or whitespace closes the block, whatever the content.
function findClosingTag(source: string, tag: string, from: number): {start: number; end: number} | undefined {
  const needle = `</${tag}`;
  for (let start = source.indexOf(needle, from); start !== -1; start = source.indexOf(needle, start + 1)) {
    const after = source[start + needle.length];
    if (after !== '>' && !isSpace(after)) continue;
    const close = source.indexOf('>', start + needle.length);
    return close === -1 ? undefined : {start, end: close + 1};
  }
  return undefined;
}

/** Block content is raw text; every offset indexes into `source`. */
export function splitBlocks(source: string, filename: string): SplitResult {
  const blocks: Block[] = [];
  const counts = new Map<BlockTag, number>();
  let pos = 0;
  while (pos < source.length) {
    if (isSpace(source[pos])) {
      pos++;
      continue;
    }
    const commentEnd = source.startsWith('<!--', pos) ? source.indexOf('-->', pos + 4) : -1;
    if (commentEnd !== -1) {
      pos = commentEnd + 3;
      continue;
    }
    if (source[pos] === '<' && isNameStart(source[pos + 1])) {
      // HTML tag name rule: `<react_old>` is one unknown tag, not `<react>` with an attribute.
      let nameEnd = pos + 1;
      while (nameEnd < source.length && !isSpace(source[nameEnd]) && source[nameEnd] !== '/' && source[nameEnd] !== '>')
        nameEnd++;
      const name = source.slice(pos + 1, nameEnd);
      const opening = isRootTag(name) ? readOpeningTag(source, nameEnd) : undefined;
      const closing = opening && findClosingTag(source, name, opening.end);
      if (isRootTag(name) && opening && closing) {
        const index = counts.get(name) ?? 0;
        counts.set(name, index + 1);
        blocks.push({
          type: name,
          attrs: opening.attrs,
          content: source.slice(opening.end, closing.start),
          start: pos,
          end: closing.end,
          contentStart: opening.end,
          contentEnd: closing.start,
          index,
        });
        pos = closing.end;
        continue;
      }
    }
    // Stray text, unknown tags, unclosed blocks or comments: skipped, not reported yet.
    const next = source.indexOf('<', pos + 1);
    pos = next === -1 ? source.length : next;
  }

  const targets: Partial<Record<Target, Block>> = {};
  for (const block of blocks) if (isTargetTag(block.type)) targets[block.type] ??= block;
  return {filename, source, blocks, styles: blocks.filter((block) => block.type === 'style'), targets, errors: []};
}
