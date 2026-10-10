import type {ResolveTargetOptions, Target, TargetErrorCode, TargetRule} from '@multifront/core';

// Reported by `rewriteImportAttributes`, before any `resolveTarget` call.
type RewriteErrorCode = 'framework-attribute-not-literal';

/** One `.ucf` import of this app and what it must resolve to, in the build and in the editor alike. */
type ExpectedImport = {
  file: string; // from this folder, '/' separators
  specifier: string;
  line: number; // 1-based, in the whole file
  options: ResolveTargetOptions; // the plugin entry of the nearest tsconfig.json
} & ({expect: Target; rule: TargetRule} | {expect: TargetErrorCode | RewriteErrorCode});

const CARD = '../../../components/Card.ucf';
const BADGE = '../../../components/Badge.ucf';
const DEFAULT_REACT: ResolveTargetOptions = {framework: 'react'};
const NO_DEFAULT: ResolveTargetOptions = {importers: {'.mts': 'vue'}};
const CUSTOM: ResolveTargetOptions = {importers: {'.ts': 'svelte', '.tsx': 'vue'}};

export const EXPECTED_IMPORTS: ExpectedImport[] = [
  {file: 'src/App.tsx', specifier: CARD, line: 1, options: DEFAULT_REACT, expect: 'react', rule: 'importer'},
  {file: 'src/main.ts', specifier: CARD, line: 1, options: DEFAULT_REACT, expect: 'react', rule: 'attribute'},
  {file: 'src/reexport.ts', specifier: CARD, line: 1, options: DEFAULT_REACT, expect: 'vue', rule: 'attribute'},
  {file: 'src/lazy.ts', specifier: CARD, line: 1, options: DEFAULT_REACT, expect: 'svelte', rule: 'attribute'},
  {file: 'src/bad.ts', specifier: CARD, line: 1, options: DEFAULT_REACT, expect: 'unknown-framework'},
  {file: 'src/Page.vue', specifier: CARD, line: 2, options: DEFAULT_REACT, expect: 'vue', rule: 'importer'},
  {file: 'src/mixed.ts', specifier: CARD, line: 2, options: DEFAULT_REACT, expect: 'vue', rule: 'attribute'},
  {file: 'src/mixed.ts', specifier: CARD, line: 3, options: DEFAULT_REACT, expect: 'react', rule: 'attribute'},
  {file: 'src/default.ts', specifier: CARD, line: 1, options: DEFAULT_REACT, expect: 'react', rule: 'default'},
  {
    file: 'src/attribute-over-importer.tsx',
    specifier: CARD,
    line: 1,
    options: DEFAULT_REACT,
    expect: 'svelte',
    rule: 'attribute',
  },
  {file: 'src/Showcase.ucf', specifier: CARD, line: 2, options: DEFAULT_REACT, expect: 'react', rule: 'block'},
  {file: 'src/BlockAttribute.ucf', specifier: BADGE, line: 2, options: DEFAULT_REACT, expect: 'framework-in-block'},
  // The block's own framework is still an attribute: an error too.
  {file: 'src/BlockAttribute.ucf', specifier: CARD, line: 3, options: DEFAULT_REACT, expect: 'framework-in-block'},
  {file: 'src/Widget.jsx', specifier: CARD, line: 1, options: DEFAULT_REACT, expect: 'react', rule: 'importer'},
  {file: 'src/Gallery.svelte', specifier: CARD, line: 2, options: DEFAULT_REACT, expect: 'svelte', rule: 'importer'},
  {file: 'no-default/bare.ts', specifier: CARD, line: 1, options: NO_DEFAULT, expect: 'no-target'},
  {file: 'no-default/attribute.ts', specifier: CARD, line: 1, options: NO_DEFAULT, expect: 'react', rule: 'attribute'},
  {
    file: 'no-default/attribute-over-importer.tsx',
    specifier: CARD,
    line: 1,
    options: NO_DEFAULT,
    expect: 'vue',
    rule: 'attribute',
  },
  {file: 'no-default/reexport.ts', specifier: CARD, line: 1, options: NO_DEFAULT, expect: 'react', rule: 'attribute'},
  {file: 'no-default/export-all.ts', specifier: CARD, line: 1, options: NO_DEFAULT, expect: 'react', rule: 'attribute'},
  {file: 'no-default/dynamic.ts', specifier: CARD, line: 1, options: NO_DEFAULT, expect: 'react', rule: 'attribute'},
  {file: 'no-default/importer.tsx', specifier: CARD, line: 1, options: NO_DEFAULT, expect: 'react', rule: 'importer'},
  {file: 'no-default/importer.jsx', specifier: CARD, line: 1, options: NO_DEFAULT, expect: 'react', rule: 'importer'},
  {file: 'no-default/non-literal.ts', specifier: CARD, line: 2, options: NO_DEFAULT, expect: 'framework-attribute-not-literal'},
  {file: 'no-default/unknown.ts', specifier: CARD, line: 1, options: NO_DEFAULT, expect: 'unknown-framework'},
  {file: 'custom-importers/widget.ts', specifier: CARD, line: 1, options: CUSTOM, expect: 'svelte', rule: 'importer'},
  {file: 'custom-importers/view.tsx', specifier: CARD, line: 1, options: CUSTOM, expect: 'vue', rule: 'importer'},
];
