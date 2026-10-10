import {BLOCK_KINDS, getBlockKind} from './blocks/index.ts';
import {createDiagnostic} from './diagnostics.ts';
import {findClosingTag, isNameStart, isSpace, readOpeningTag, tagNameEnd} from './scan.ts';
import type {Block, BlockTag, Diagnostic, DiagnosticCode, SplitResult, TagBreak, Target} from './types.ts';

const ROOT_TAGS: ReadonlySet<string> = new Set(BLOCK_KINDS.map((kind) => kind.tag));

function tagList(tags: string[]): string {
  const names = tags.map((tag) => `<${tag}>`);
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}
const ROOT_TAG_LIST = tagList(BLOCK_KINDS.map((kind) => kind.tag));
const TARGET_TAG_LIST = tagList(BLOCK_KINDS.filter((kind) => kind.role === 'target').map((kind) => kind.tag));

const isRootTag = (name: string): name is BlockTag => ROOT_TAGS.has(name);

function isTargetTag(tag: BlockTag): tag is Target {
  return getBlockKind(tag).role === 'target';
}

// Where the scan resumes after stray text or an unclosed block.
function nextRootTag(source: string, from: number): number {
  for (let pos = source.indexOf('<', from); pos !== -1; pos = source.indexOf('<', pos + 1)) {
    if (isNameStart(source[pos + 1]) && isRootTag(source.slice(pos + 1, tagNameEnd(source, pos)))) return pos;
  }
  return source.length;
}

function unclosedMessage(tag: string, broken: TagBreak | undefined): string {
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
  const report = (code: DiagnosticCode, start: number, end: number, message: string): void => {
    errors.push(createDiagnostic({filename, source}, code, start, end, message));
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
      const nameEnd = tagNameEnd(source, pos);
      const name = source.slice(pos + 1, nameEnd);
      const opening = readOpeningTag(source, nameEnd);
      if (!isRootTag(name)) {
        report('unknown-root-tag', pos, nameEnd, `<${name}> is not a root tag; use ${ROOT_TAG_LIST}`);
        if (opening.broken === 'self-closing') {
          pos = opening.end;
          continue;
        }
        // A closing tag past the next root tag is not this tag's: skipping to it would swallow that block.
        const resync = nextRootTag(source, opening.end);
        const closing = opening.broken ? undefined : findClosingTag(source, name, opening.end);
        pos = closing && closing.start < resync ? closing.end : resync;
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
      if (index > 0 && isTargetTag(name))
        report('duplicate-target', pos, opening.end, `<${name}> appears more than once; keep one`);
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
    report('missing-target', 0, 0, `No target block; add a ${TARGET_TAG_LIST} block`);
    errors.unshift(errors.pop()!); // keeps errors in `start` order
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
    !source.startsWith(`</${previous.type}`, start) &&
    (findClosingTag(source, previous.type, start)?.end ?? Infinity) <= end;
  if (closedEarly) {
    return `'</${previous.type}>' in the <${previous.type}> block closed it early; write '<\\/${previous.type}>' instead`;
  }
  return 'Text outside a block; move it into a block or an HTML comment';
}
