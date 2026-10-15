// The `<svelte>` markup read lexically: the server loads no Svelte compiler, and a block mid-edit rarely parses.
import type {MarkupEvent, MarkupOpen, MarkupScan, MarkupSpan, MarkupTag} from './types.ts';

/** Embedded code language of the markup; not `html`, so Vue's template services never read it. */
export const SVELTE_MARKUP_LANGUAGE = 'svelte-markup';

interface Blank extends MarkupSpan {
  quoted: boolean; // an attribute value: `"…"`, so the HTML scanner reads one value, not the next attribute
}

const VOID_ELEMENTS: ReadonlySet<string> = new Set(
  'area base br col embed hr img input link meta param source track wbr'.split(' ')
);
const isSpace = (char: string | undefined): boolean => char !== undefined && /\s/.test(char);
const isNameStart = (char: string | undefined): boolean => char !== undefined && /[A-Za-z]/.test(char);

/** A component tag (`Icon`, `ui.Button`), not an element or a `svelte:*` one. */
export const isComponent = (name: string): boolean => /^[A-Z]/.test(name) || name.includes('.');

function tagNameEnd(text: string, pos: number): number {
  while (pos < text.length && !isSpace(text[pos]) && !'/>{<'.includes(text[pos]!)) pos++;
  return pos;
}

// The closing quote of the string at `pos`, or -1.
function stringEnd(text: string, pos: number): number {
  const quote = text[pos];
  for (let index = pos + 1; index < text.length; index++) {
    const char = text[index];
    if (char === '\\') index++;
    else if (char === quote) return index;
    else if (quote === '`' && char === '$' && text[index + 1] === '{') {
      const end = expressionEnd(text, index + 1);
      if (end === -1) return -1;
      index = end - 1;
    }
  }
  return -1;
}

// Just after the `}` matching the `{` at `pos`, or -1.
function expressionEnd(text: string, pos: number): number {
  let depth = 0;
  for (let index = pos; index < text.length; index++) {
    const char = text[index];
    if (char === '"' || char === "'" || char === '`') {
      index = stringEnd(text, index);
      if (index === -1) return -1;
    } else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return index + 1;
  }
  return -1;
}

function apply(stack: MarkupOpen[], {type, kind, name, branch, clauses}: MarkupEvent): void {
  if (type === 'open') {
    stack.push({kind, name, branch: branch ?? name, clauses: clauses ?? new Set()});
    return;
  }
  const index = stack.findLastIndex((open) => open.kind === kind && (type === 'branch' || open.name === name));
  if (index === -1) return;
  if (type !== 'branch') stack.length = index;
  else {
    stack[index]!.branch = name;
    stack[index]!.clauses.add(name);
  }
}

export function scanMarkup(content: string): MarkupScan {
  const blanks: Blank[] = [];
  const events: MarkupEvent[] = [];
  const opaque: MarkupScan['opaque'] = [];
  const stack: MarkupOpen[] = [];
  const metas = new Set<string>();
  const tags: MarkupTag[] = [];
  let hasScript = false;
  const event = (next: MarkupEvent) => {
    events.push(next);
    apply(stack, next);
  };
  // An unclosed `{` runs to the next tag, so the markup after it still reads.
  const expression = (start: number, quoted: boolean, limit = content.length): number => {
    const close = expressionEnd(content, start);
    const next = content.indexOf('<', start);
    const end = close !== -1 && close <= limit ? close : Math.min(limit, next === -1 ? content.length : next);
    blanks.push({start, end, quoted: quoted && close !== -1 && close <= limit});
    opaque.push({start, end, expression: true});
    return end;
  };

  // `complete` false: a tag still being typed.
  const readTag = (pos: number, gaps: MarkupSpan[]): {end: number; selfClosing: boolean; complete: boolean} => {
    while (pos < content.length) {
      const char = content[pos];
      if (char === '>') return {end: pos + 1, selfClosing: false, complete: true};
      if (char === '/' && content[pos + 1] === '>') return {end: pos + 2, selfClosing: true, complete: true};
      if (char === '<') return {end: pos, selfClosing: false, complete: false};
      if (char === '{') {
        pos = expression(pos, false);
        continue;
      }
      if (char !== '=') {
        const last = gaps.at(-1);
        if (isSpace(char) && last?.end === pos) last.end++;
        else if (isSpace(char)) gaps.push({start: pos, end: pos + 1});
        pos++;
        continue;
      }
      // `name = "x"`: the space before `=` is inside the attribute.
      if (gaps.at(-1)?.end === pos) gaps.pop();
      let value = pos + 1;
      while (isSpace(content[value])) value++;
      const quote = content[value];
      if (quote === '{') {
        pos = expression(value, true);
        continue;
      }
      if (quote !== '"' && quote !== "'") {
        pos = value;
        continue;
      }
      pos = value + 1;
      while (pos < content.length && content[pos] !== quote) pos = content[pos] === '{' ? expression(pos, false) : pos + 1;
      pos++;
    }
    return {end: content.length, selfClosing: false, complete: false};
  };

  let pos = 0;
  while (pos < content.length) {
    const char = content[pos];
    if (content.startsWith('<!--', pos)) {
      const close = content.indexOf('-->', pos + 4);
      const end = close === -1 ? content.length : close + 3;
      opaque.push({start: pos, end, expression: false});
      pos = end;
    } else if (char === '<' && content[pos + 1] === '/' && isNameStart(content[pos + 2])) {
      const nameEnd = tagNameEnd(content, pos + 2);
      const close = content.indexOf('>', nameEnd);
      const end = close === -1 ? content.length : close + 1;
      event({at: end, type: 'close', kind: 'element', name: content.slice(pos + 2, nameEnd)});
      opaque.push({start: pos, end, expression: false});
      pos = end;
    } else if (char === '<' && isNameStart(content[pos + 1])) {
      const nameEnd = tagNameEnd(content, pos + 1);
      const name = content.slice(pos + 1, nameEnd);
      const gaps: MarkupSpan[] = [];
      const {end, selfClosing, complete} = readTag(nameEnd, gaps);
      tags.push({name, start: pos, end, gaps});
      opaque.push({start: pos, end, expression: false});
      const tag = content.slice(pos, end);
      pos = end;
      if (!complete) continue;
      if (stack.length === 0 && name.startsWith('svelte:')) metas.add(name);
      // `<script module>` is the other one a block may hold.
      if (stack.length === 0 && name === 'script' && !/\smodule\b|context\s*=\s*["']module/.test(tag)) hasScript = true;
      if (name === 'script' || name === 'style') {
        if (selfClosing) continue;
        const close = content.indexOf(`</${name}`, end);
        const rawEnd = close === -1 ? content.length : close;
        if (name === 'script') blanks.push({start: end, end: rawEnd, quoted: false});
        opaque.push({start: end, end: rawEnd, expression: false});
        pos = rawEnd;
      } else if (!selfClosing && !VOID_ELEMENTS.has(name)) event({at: end, type: 'open', kind: 'element', name});
    } else if (char === '{') {
      const start = pos;
      pos = expression(start, false);
      const text = content.slice(start, pos);
      const [, sigil, word, elseIf] = /^\{([#:/])([a-z]+)(\s+if\b)?/.exec(text) ?? [];
      if (!sigil || !word) continue;
      const name = elseIf ? 'else if' : word;
      if (sigil === '/') event({at: pos, type: 'close', kind: 'block', name});
      else if (sigil === ':') event({at: pos, type: 'branch', kind: 'block', name});
      else {
        // `{#await p then v}` starts in its `then` branch.
        const branch = /\s(then|catch)\b/.exec(text)?.[1];
        event({at: pos, type: 'open', kind: 'block', name, branch, clauses: new Set(branch && [branch])});
      }
    } else pos++;
  }

  // UTF-16 units, as offsets count them.
  const chars = content.split('');
  for (const {start, end, quoted} of blanks) {
    for (let index = start; index < end; index++) if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
    if (quoted) [chars[start], chars[end - 1]] = ['"', '"'];
  }
  const pieces: MarkupSpan[] = [];
  let from = 0;
  for (const {start, end} of [...blanks].sort((first, second) => first.start - second.start)) {
    if (start > from) pieces.push({start: from, end: start});
    from = Math.max(from, end);
  }
  if (content.length > from) pieces.push({start: from, end: content.length});
  return {code: chars.join(''), pieces, events, opaque, hasScript, metas, tags};
}

/** What is open just before `offset`, outermost first. */
export function openAt(scan: MarkupScan, offset: number): MarkupOpen[] {
  const stack: MarkupOpen[] = [];
  for (const event of scan.events) if (event.at <= offset) apply(stack, event);
  return stack;
}

/** The `{` at `brace` starts an expression in text: not inside a tag, a comment, raw text or another expression. */
export function inText(scan: MarkupScan, brace: number): boolean {
  return !scan.opaque.some(({start, end, expression}) => (expression ? start < brace : start <= brace) && brace < end);
}
