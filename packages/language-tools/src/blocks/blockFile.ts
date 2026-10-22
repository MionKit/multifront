import type {Block, BlockTag, VirtualFile} from '@multifront/core';

// The ending of each kind's `build` file.
const ENDINGS: Record<BlockTag, VirtualFile['ext']> = {style: '.css', vue: '.vue', react: '.tsx', svelte: '.svelte'};

/** What oxlint and oxfmt call a block's own text: `Card.front.react.tsx`, `Card.front.style.scss`. */
export function blockFile(fileName: string, block: Pick<Block, 'type' | 'attrs'>): string {
  const {lang} = block.attrs;
  const ending = block.type === 'style' && typeof lang === 'string' ? `.${lang}` : ENDINGS[block.type];
  return `${fileName}.${block.type}${ending}`;
}
