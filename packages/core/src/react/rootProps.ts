import type MagicString from 'magic-string';
import type {ArrayPattern, JSXAttribute, JSXOpeningElement, Node, ObjectPattern} from 'oxc-parser';
import {walk} from '../ast.ts';
import {keyName} from '../imports/rewrite.ts';
import {ROOT_PROPS} from './reactApis.ts';
import {MERGE_CLASS, MERGE_REF, MERGE_STYLE} from './scopeHelper.ts';

type RootProp = (typeof ROOT_PROPS)[number];

const MERGE: Record<RootProp, string> = {className: MERGE_CLASS, style: MERGE_STYLE, ref: MERGE_REF};

/** The root props the component handles itself, and the names whose spread on a root hands it every prop. */
export interface HandledProps {
  handled: Set<RootProp>;
  spreads: Set<string>;
}

function isRootProp(name: string | undefined): name is RootProp {
  return (ROOT_PROPS as readonly string[]).includes(name ?? '');
}

// Top-level keys only: `{a: {className}}` reads a nested object's prop.
function readPattern(pattern: ObjectPattern, found: HandledProps): void {
  for (const property of pattern.properties) {
    if (property.type === 'RestElement') {
      if (property.argument.type === 'Identifier') found.spreads.add(property.argument.name);
    } else if (!property.computed) {
      const name = keyName(property.key);
      if (isRootProp(name)) found.handled.add(name);
    }
  }
}

/** Spec 3.5, item 5: what the author handles is left to the author. `plain`: the first parameter's own name. */
export function handledRootProps(
  component: Node,
  options: {plain?: string; pattern?: ObjectPattern | ArrayPattern; forwardRef: boolean}
): HandledProps {
  const {plain, pattern, forwardRef} = options;
  const found: HandledProps = {handled: new Set(), spreads: new Set()};
  // React hands a `forwardRef` render function the ref as its second parameter, never as a prop.
  if (forwardRef) found.handled.add('ref');
  if (pattern?.type === 'ObjectPattern') readPattern(pattern, found);
  if (plain === undefined) return found;
  found.spreads.add(plain);
  walk(component, (node) => {
    if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === plain) {
      const {property, computed} = node;
      const name = computed
        ? property.type === 'Literal' && typeof property.value === 'string'
          ? property.value
          : undefined
        : property.type === 'Identifier'
          ? property.name
          : undefined;
      if (isRootProp(name)) found.handled.add(name);
    } else if (
      node.type === 'VariableDeclarator' &&
      node.id.type === 'ObjectPattern' &&
      node.init?.type === 'Identifier' &&
      node.init.name === plain
    )
      readPattern(node.id, found);
  });
  return found;
}

function ownAttribute(opening: JSXOpeningElement, prop: RootProp): JSXAttribute | undefined {
  return opening.attributes.findLast(
    (item): item is JSXAttribute => item.type === 'JSXAttribute' && item.name.type === 'JSXIdentifier' && item.name.name === prop
  );
}

/** Merges or adds each root prop the author leaves alone; returns the merge helpers it calls. */
export function addRootProps(
  text: MagicString,
  offset: number,
  opening: JSXOpeningElement,
  at: number,
  props: string,
  {handled, spreads}: HandledProps
): string[] {
  const spreadsProps = opening.attributes.some(
    (item) => item.type === 'JSXSpreadAttribute' && item.argument.type === 'Identifier' && spreads.has(item.argument.name)
  );
  if (spreadsProps) return [];
  const helpers: string[] = [];
  for (const prop of ROOT_PROPS) {
    if (handled.has(prop)) continue;
    const own = ownAttribute(opening, prop);
    // Before every author attribute, so an author spread that carries the prop still wins.
    if (!own) text.appendLeft(offset + at, ` ${prop}={${props}.${prop}}`);
    else if (own.value?.type === 'JSXExpressionContainer' && own.value.expression.type !== 'JSXEmptyExpression') {
      const {expression} = own.value;
      text.prependRight(offset + expression.start, `${MERGE[prop]}(`);
      text.appendLeft(offset + expression.end, `, ${props}.${prop})`);
      helpers.push(MERGE[prop]);
    } else if (own.value?.type === 'Literal' && prop === 'className') {
      const {start, end, value, raw} = own.value;
      // JSX decodes `&amp;` in a string, which a JS string does not: the author's value stays, unmerged.
      if (raw?.includes('&')) continue;
      // JSX keeps line breaks and `\` as written; a JS string needs them escaped.
      if (/[\n\r\\]/.test(raw ?? ''))
        text.overwrite(offset + start, offset + end, `{${MERGE_CLASS}(${JSON.stringify(value)}, ${props}.className)}`);
      else {
        text.prependRight(offset + start, `{${MERGE_CLASS}(`);
        text.appendLeft(offset + end, `, ${props}.className)}`);
      }
      helpers.push(MERGE_CLASS);
    }
    // No value, `{}`, or a string `style` / `ref`: left as written.
  }
  return helpers;
}
