import {BLOCK_KINDS, getBlockKind} from './blocks/index.ts';
import type {Block, BlockTag, Diagnostic, DiagnosticCode, SplitResult, Target} from './types.ts';

const ROOT_TAGS: ReadonlySet<string> = new Set(BLOCK_KINDS.map((kind) => kind.tag));

function tagList(tags: string[]): string {
  const names = tags.map((tag) => `<${tag}>`);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names.join('');
}
const ROOT_TAG_LIST = tagList(BLOCK_KINDS.map((kind) => kind.tag));
const TARGET_TAG_LIST = tagList(BLOCK_KINDS.filter((kind) => kind.role === 'target').map((kind) => kind.tag));

const isSpace = (char: string | undefined): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
const isNameStart = (char: string | undefined): boolean => char !== undefined && /[A-Za-z]/.test(char);
const isRootTag = (name: string): name is BlockTag => ROOT_TAGS.has(name);

function isTargetTag(tag: BlockTag): tag is Target {
  return getBlockKind(tag).role === 'target';
}

// HTML tag name rule: `<react_old>` is one unknown tag, not `<react>` with an attribute.
function readTagName(source: string, pos: number): number {
  let end = pos + 1;
  while (end < source.length && !isSpace(source[end]) && source[end] !== '/' && source[end] !== '>') end++;
  return end;
}

// Offset of the next `<name` with a root tag name: where the scan picks up again after stray text or an unclosed block.
function nextRootTag(source: string, from: number): number {
  for (let pos = source.indexOf('<', from); pos !== -1; pos = source.indexOf('<', pos + 1)) {
    if (isNameStart(source[pos + 1]) && isRootTag(source.slice(pos + 1, readTagName(source, pos)))) return pos;
  }
  return source.length;
}

type Broken = 'eof' | 'open-quote' | 'self-closing';

interface OpeningTag {
  attrs: Block['attrs'];
  end: number; // just after its '>' or '/>'; the name end when it never ends
  broken?: Broken; // set = the tag never ends cleanly and counts as unclosed
}

// `pos` = just after the tag name.
function readOpeningTag(source: string, pos: number): OpeningTag {
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
      if (close === -1 || /[>\n]/.test(source.slice(pos + 1, close))) return {attrs, end: nameEnd, broken: 'open-quote'};
      attrs[name] = source.slice(pos + 1, close);
      pos = close + 1;
    } else {
      const start = pos;
      while (pos < source.length && !isSpace(source[pos]) && source[pos] !== '>') pos++;
      attrs[name] = source.slice(start, pos);
    }
  }
  return {attrs, end: nameEnd, broken: 'eof'};
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

// Lines break on '\n' only, like Rollup's locator; columns are 0-based UTF-16 offsets.
function lineLocator(source: string): (offset: number) => {line: number; column: number} {
  const lineStarts = [0];
  for (let pos = source.indexOf('\n'); pos !== -1; pos = source.indexOf('\n', pos + 1)) lineStarts.push(pos + 1);
  return (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return {line: low + 1, column: offset - lineStarts[low]!};
  };
}

function unclosedMessage(tag: string, broken: Broken | undefined): string {
  if (broken === 'eof') return `<${tag}> opening tag has no '>'`;
  if (broken === 'open-quote') return `<${tag}> has an attribute quote left open`;
  if (broken === 'self-closing') return `<${tag}/> cannot self-close; write <${tag}></${tag}>`;
  return `<${tag}> is never closed; add </${tag}>`;
}

/** Block content is raw text; every offset indexes into `source`. Errors never stop the scan. */
export function splitBlocks(source: string, filename: string): SplitResult {
  const blocks: Block[] = [];
  const errors: Diagnostic[] = [];
  const counts = new Map<BlockTag, number>();
  let locate: ReturnType<typeof lineLocator> | undefined;
  const report = (code: DiagnosticCode, start: number, end: number, message: string): void => {
    locate ??= lineLocator(source);
    errors.push({code, severity: 'error', message, filename, start, end, ...locate(start)});
  };
  let sawTarget = false;
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
      const nameEnd = readTagName(source, pos);
      const name = source.slice(pos + 1, nameEnd);
      const opening = readOpeningTag(source, nameEnd);
      if (!isRootTag(name)) {
        report('unknown-root-tag', pos, nameEnd, `<${name}> is not a root tag; use ${ROOT_TAG_LIST}`);
        if (opening.broken === 'self-closing') pos = opening.end;
        else if (opening.broken) pos = nextRootTag(source, opening.end);
        else pos = findClosingTag(source, name, opening.end)?.end ?? opening.end;
        continue;
      }
      if (isTargetTag(name)) sawTarget = true;
      const closing = opening.broken ? undefined : findClosingTag(source, name, opening.end);
      if (!closing) {
        report('unclosed-block', pos, opening.end, unclosedMessage(name, opening.broken));
        pos = nextRootTag(source, opening.end);
        continue;
      }
      const index = counts.get(name) ?? 0;
      counts.set(name, index + 1);
      if (index > 0 && isTargetTag(name)) report('duplicate-target', pos, opening.end, `<${name}> appears twice; keep one`);
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
    const runStart = pos;
    pos = nextRootTag(source, pos + 1);
    let runEnd = pos;
    while (isSpace(source[runEnd - 1])) runEnd--;
    report('text-outside-block', runStart, runEnd, strayTextMessage(source, runStart, runEnd, blocks.at(-1)));
  }

  // An unclosed target tag already has its own error: one error per mistake.
  if (!sawTarget) {
    const message = `No target block; add a ${TARGET_TAG_LIST} block`;
    errors.unshift({code: 'missing-target', severity: 'error', message, filename, start: 0, end: 0, line: 1, column: 0});
  }
  const targets: Partial<Record<Target, Block>> = {};
  for (const block of blocks) if (isTargetTag(block.type)) targets[block.type] ??= block;
  return {filename, source, blocks, styles: blocks.filter((block) => block.type === 'style'), targets, errors};
}

function strayTextMessage(source: string, start: number, end: number, previous: Block | undefined): string {
  if (source.startsWith('<!--', start)) return 'HTML comment is never closed; add -->';
  // Spec 10 limitation: a `</tag>` inside the block's own code closes it early and leaves the rest outside.
  const closedEarly =
    previous &&
    !source.slice(previous.end, start).trim() &&
    (findClosingTag(source, previous.type, start)?.end ?? Infinity) <= end;
  if (closedEarly) {
    return `'</${previous.type}>' in the <${previous.type}> block closed it early; write '<\\/${previous.type}>' instead`;
  }
  return 'Text outside a block; move it into a block or an HTML comment';
}
