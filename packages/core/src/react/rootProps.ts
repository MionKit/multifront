import type MagicString from 'magic-string';
import type {ArrayPattern, Expression, JSXAttribute, JSXOpeningElement, Node, ObjectPattern, StringLiteral} from 'oxc-parser';
import type {HandledProps as HandledRootProps, RootProp} from '../types.ts';
import {children, scopeNames} from '../ast.ts';
import {keyName, literalValue} from '../imports/rewrite.ts';
import {ROOT_PROPS} from './reactApis.ts';
import {MERGE_CLASS, MERGE_REF, MERGE_STYLE} from './scopeHelper.ts';

const MERGE: Record<RootProp, string> = {className: MERGE_CLASS, style: MERGE_STYLE, ref: MERGE_REF};

type HandledProps = HandledRootProps<RootProp>;

function isRootProp(name: string | undefined): name is RootProp {
  return (ROOT_PROPS as readonly string[]).includes(name ?? '');
}

// `props!` and `(props as Props)` are still the props object.
function unwrap(node: Node): Node {
  while (
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'ParenthesizedExpression'
  )
    node = node.expression;
  return node;
}

function isNamed(node: Node | null | undefined, name: string): boolean {
  if (!node) return false;
  const inner = unwrap(node);
  return inner.type === 'Identifier' && inner.name === name;
}

// Top-level keys only: `{a: {className}}` reads a nested object's prop.
function readPattern(pattern: ObjectPattern, found: HandledProps): void {
  for (const property of pattern.properties) {
    if (property.type === 'RestElement') {
      if (property.argument.type === 'Identifier') found.spreads.add(property.argument.name);
      continue;
    }
    const name = property.computed ? literalValue(property.key as Expression) : keyName(property.key);
    if (isRootProp(name)) found.handled.add(name);
  }
}

/** Spec 3.5, item 5: what the author handles is left to the author. `pattern`: the destructured first parameter. */
export function handledRootProps(
  component: Node,
  props: string,
  pattern: ObjectPattern | ArrayPattern | undefined,
  forwardRef: boolean
): HandledProps {
  const found: HandledProps = {handled: new Set(), spreads: new Set([props])};
  // React hands a `forwardRef` render function the ref as its second parameter, never as a prop.
  if (forwardRef) found.handled.add('ref');
  if (pattern?.type === 'ObjectPattern') readPattern(pattern, found);
  const visit = (node: Node): void => {
    // Below a binding of the same name, `props` is another object.
    if (node !== component && scopeNames(node).includes(props)) return;
    if (node.type === 'MemberExpression' && isNamed(node.object, props)) {
      const name = node.computed ? literalValue(node.property) : keyName(node.property);
      if (isRootProp(name)) found.handled.add(name);
    } else if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && isNamed(node.init, props))
      readPattern(node.id as ObjectPattern, found);
    for (const child of children(node)) visit(child);
  };
  visit(component);
  return found;
}

type RootPropEdit =
  | {prop: RootProp; kind: 'add'}
  | {prop: RootProp; kind: 'merge'; value: Expression}
  | {prop: 'className'; kind: 'mergeString'; value: StringLiteral};

/** What the build does with each root prop the author leaves alone on this root; none when it spreads the props. */
export function rootPropEdits(opening: JSXOpeningElement, {handled, spreads}: HandledProps): RootPropEdit[] {
  const spreadsProps = opening.attributes.some(
    (item) => item.type === 'JSXSpreadAttribute' && [...spreads].some((name) => isNamed(item.argument, name))
  );
  if (spreadsProps) return [];
  const edits: RootPropEdit[] = [];
  for (const prop of ROOT_PROPS) {
    if (handled.has(prop)) continue;
    const own = opening.attributes.findLast(
      (item): item is JSXAttribute =>
        item.type === 'JSXAttribute' && item.name.type === 'JSXIdentifier' && item.name.name === prop
    );
    if (!own) edits.push({prop, kind: 'add'});
    else if (own.value?.type === 'JSXExpressionContainer' && own.value.expression.type !== 'JSXEmptyExpression') {
      const {expression} = own.value;
      // A string `style` or `ref` is no value React takes: left as written, like the attribute form.
      if (prop === 'className' || literalValue(expression) === undefined) edits.push({prop, kind: 'merge', value: expression});
    } else if (own.value?.type === 'Literal' && prop === 'className') {
      // JSX decodes `&amp;` in a string, which a JS string does not: the author's value stays, unmerged.
      if (!own.value.raw?.includes('&')) edits.push({prop, kind: 'mergeString', value: own.value});
    }
    // No value, or a string `style` / `ref`: left as written.
  }
  return edits;
}

/** Merges or adds each root prop the author leaves alone; returns the merge helpers it calls. */
export function addRootProps(
  text: MagicString,
  offset: number,
  opening: JSXOpeningElement,
  at: number,
  props: string,
  handled: HandledProps,
  local: (helper: string) => string
): string[] {
  const helpers: string[] = [];
  for (const edit of rootPropEdits(opening, handled)) {
    const {prop} = edit;
    if (edit.kind !== 'add') helpers.push(MERGE[prop]);
    // Before every author attribute, so an author spread that carries the prop still wins.
    if (edit.kind === 'add') text.appendLeft(offset + at, ` ${prop}={${props}.${prop}}`);
    else if (edit.kind === 'merge') {
      text.prependRight(offset + edit.value.start, `${local(MERGE[prop])}(`);
      text.appendLeft(offset + edit.value.end, `, ${props}.${prop})`);
    }
    // JSX keeps line breaks and `\` as written; a JS string needs them escaped.
    else if (/[\n\r\\]/.test(edit.value.raw ?? '')) {
      const {start, end, value} = edit.value;
      text.overwrite(offset + start, offset + end, `{${local(MERGE_CLASS)}(${JSON.stringify(value)}, ${props}.className)}`);
    } else {
      text.prependRight(offset + edit.value.start, `{${local(MERGE_CLASS)}(`);
      text.appendLeft(offset + edit.value.end, `, ${props}.className)}`);
    }
  }
  return helpers;
}
