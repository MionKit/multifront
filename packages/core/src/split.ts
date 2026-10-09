import {BLOCK_KINDS, getBlockKind} from './blocks/index.ts';
import type {Block, BlockTag, SplitResult, Target} from './types.ts';

const ROOT_TAGS: ReadonlySet<string> = new Set(BLOCK_KINDS.map((kind) => kind.tag));

const isSpace = (char: string | undefined): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
const isNameStart = (char: string | undefined): boolean => char !== undefined && /[A-Za-z]/.test(char);
const isNameChar = (char: string | undefined): boolean => char !== undefined && /[A-Za-z0-9-]/.test(char);

function isRootTag(name: string): name is BlockTag {
  return ROOT_TAGS.has(name);
}

function isTargetTag(tag: BlockTag): tag is Target {
  return getBlockKind(tag).role === 'target';
}

interface OpeningTag {
  attrs: Record<string, string | true>;
  end: number; // just after its '>'
}

// Reads the attributes after the tag name at `pos`; undefined when the file ends before the '>'.
function readOpeningTag(source: string, pos: number): OpeningTag | undefined {
  const attrs: Record<string, string | true> = {};
  while (pos < source.length) {
    const char = source[pos];
    if (char === '>') return {attrs, end: pos + 1};
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
      if (close === -1) return undefined;
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

// Browser `<script>` rules: the first `</tag` followed by '>' or whitespace closes the block.
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

/** Splits a `.ucf` file into its root blocks; content is raw text, offsets index into `source`. */
export function splitBlocks(source: string, filename: string): SplitResult {
  const blocks: Block[] = [];
  const counts = new Map<BlockTag, number>();
  let pos = 0;
  while (pos < source.length) {
    if (isSpace(source[pos])) {
      pos++;
      continue;
    }
    if (source.startsWith('<!--', pos)) {
      const close = source.indexOf('-->', pos + 4);
      pos = close === -1 ? source.length : close + 3;
      continue;
    }
    const start = pos;
    if (source[pos] === '<' && isNameStart(source[pos + 1])) {
      let nameEnd = pos + 1;
      while (isNameChar(source[nameEnd])) nameEnd++;
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
          start,
          end: closing.end,
          contentStart: opening.end,
          contentEnd: closing.start,
          index,
        });
        pos = closing.end;
        continue;
      }
    }
    // Stray text, an unknown tag or an unclosed block: skipped up to the next '<', not reported yet.
    const next = source.indexOf('<', pos + 1);
    pos = next === -1 ? source.length : next;
  }

  const targets: Partial<Record<Target, Block>> = {};
  for (const block of blocks) if (isTargetTag(block.type)) targets[block.type] ??= block;
  return {filename, source, blocks, styles: blocks.filter((block) => block.type === 'style'), targets, errors: []};
}
