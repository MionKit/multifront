import type {Block, FoundTag, OpeningTag} from './types.ts';

export const isSpace = (char: string | undefined): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
export const isNameStart = (char: string | undefined): boolean => char !== undefined && /[A-Za-z]/.test(char);

// HTML tag name rule: `<react_old>` is one unknown tag, not `<react>` with an attribute.
export function tagNameEnd(source: string, pos: number): number {
  let end = pos + 1;
  while (end < source.length && !isSpace(source[end]) && source[end] !== '/' && source[end] !== '>') end++;
  return end;
}

// Just after the `}` matching the `{` at `pos`, or -1.
function braceEnd(source: string, pos: number): number {
  let depth = 0;
  for (let index = pos; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return index + 1;
  }
  return -1;
}

/**
 * Reads attributes from just after the tag name. `inner` reads markup inside a block: a quoted value may hold `>` or
 * a line break (`v-if="a > b"`), and a Svelte `{…}` runs to its matching `}`.
 */
export function readOpeningTag(source: string, pos: number, inner = false): OpeningTag {
  const nameEnd = pos;
  const attrs: Block['attrs'] = {};
  while (pos < source.length) {
    const char = source[pos];
    if (char === '>') return {attrs, end: pos + 1};
    // A self-closing root tag would otherwise take the next block as its content.
    if (char === '/' && source[pos + 1] === '>') return {attrs, end: pos + 2, broken: 'self-closing'};
    if (isSpace(char) || char === '/') {
      pos++;
      continue;
    }
    const nameStart = pos;
    if (inner && char === '{') {
      pos = braceEnd(source, pos);
      if (pos === -1) return {attrs, end: nameEnd, broken: 'eof'};
      attrs[source.slice(nameStart, pos)] = true;
      continue;
    }
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
      if (close === -1 || (!inner && /[>\n]/.test(source.slice(pos + 1, close))))
        return {attrs, end: nameEnd, broken: 'open-quote'};
      attrs[name] = source.slice(pos + 1, close);
      pos = close + 1;
    } else if (inner && quote === '{') {
      const end = braceEnd(source, pos);
      if (end === -1) return {attrs, end: nameEnd, broken: 'eof'};
      attrs[name] = source.slice(pos, end);
      pos = end;
    } else {
      const start = pos;
      while (pos < source.length && !isSpace(source[pos]) && source[pos] !== '>') pos++;
      attrs[name] = source.slice(start, pos);
    }
  }
  return {attrs, end: nameEnd, broken: 'eof'};
}

// Browser `<script>` rule: the first `</tag` followed by '>' or whitespace closes the block, whatever the content.
export function findClosingTag(source: string, tag: string, from: number): {start: number; end: number} | undefined {
  const needle = `</${tag}`;
  for (let start = source.indexOf(needle, from); start !== -1; start = source.indexOf(needle, start + 1)) {
    const after = source[start + needle.length];
    if (after !== '>' && !isSpace(after)) continue;
    const close = source.indexOf('>', start + needle.length);
    return close === -1 ? undefined : {start, end: close + 1};
  }
  return undefined;
}

/**
 * The opening tags at depth 0 of the markup in `text`. Only tags whose name `nests` open a level; comments and the
 * raw text of `<script>` and `<style>` are skipped.
 */
export function topLevelTags(text: string, nests: (name: string) => boolean): FoundTag[] {
  const found: FoundTag[] = [];
  let depth = 0;
  for (let pos = text.indexOf('<'); pos !== -1; pos = text.indexOf('<', pos)) {
    if (text.startsWith('<!--', pos)) {
      const commentEnd = text.indexOf('-->', pos + 4);
      if (commentEnd === -1) break;
      pos = commentEnd + 3;
      continue;
    }
    if (text[pos + 1] === '/' && isNameStart(text[pos + 2])) {
      const nameEnd = tagNameEnd(text, pos + 1);
      if (depth > 0 && nests(text.slice(pos + 2, nameEnd))) depth--;
      pos = nameEnd;
      continue;
    }
    if (!isNameStart(text[pos + 1])) {
      pos++;
      continue;
    }
    const nameEnd = tagNameEnd(text, pos);
    const name = text.slice(pos + 1, nameEnd);
    const opening = readOpeningTag(text, nameEnd, true);
    if (opening.broken && opening.broken !== 'self-closing') break;
    if (depth === 0) found.push({name, start: pos, end: opening.end});
    pos = opening.end;
    if (opening.broken) continue;
    if (name === 'script' || name === 'style') pos = findClosingTag(text, name, pos)?.end ?? text.length;
    else if (nests(name)) depth++;
  }
  return found;
}
