import {propsTypeInserts, reactRootProps} from '@multifront/core';
import type {Block, ReactRootProps, RootProp} from '@multifront/core';
import {insertMapped} from '../mappings.ts';
import {declareModule, IDENTIFIER} from '../moduleTypes.ts';
import type {EditorBlockKind, EditorContext, EditorFile} from '../types.ts';

const REACT = "import('react')";
// React renders a lowercase tag as a host element; anything else is a component.
const HOST_TAG = /^[a-z][\w-]*$/;

// The props the build hands some root, as an object type; undefined when no root takes one.
function rootPropsType({roots}: ReactRootProps): string | undefined {
  const taking = (prop: RootProp) => roots.filter(({props}) => props.includes(prop));
  const members: string[] = [];
  if (taking('className').length > 0) members.push('className?: string');
  if (taking('style').length > 0) members.push(`style?: ${REACT}.CSSProperties`);
  const refs = taking('ref').map(({tag}) => (HOST_TAG.test(tag) ? `${REACT}.ComponentRef<'${tag}'>` : 'Element'));
  if (refs.length > 0) members.push(`ref?: ${REACT}.Ref<${[...new Set(refs)].join(' | ')}>`);
  return members.length > 0 ? `{${members.join('; ')}}` : undefined;
}

// The block with the root props of spec 3.5 item 5 in its props type, then `declare const $style: {…};` per module.
function types(block: Block, ctx: EditorContext): EditorFile {
  const found = reactRootProps(block, ctx.split.filename);
  const type = found && rootPropsType(found);
  const inserts = found && type ? found.sites.flatMap((site) => propsTypeInserts(site, type)) : [];
  let {code, mappings} = insertMapped(block, inserts);
  for (const module of Object.values(ctx.modules)) {
    if (IDENTIFIER.test(module.name)) code = declareModule(code, module.name, module.classes, mappings);
  }
  return {ext: '.tsx', code, map: undefined, mappings};
}

function editor(block: Block, ctx: EditorContext): EditorFile[] {
  return [types(block, ctx)];
}

export const reactEditorKind: EditorBlockKind = {tag: 'react', types, editor};
