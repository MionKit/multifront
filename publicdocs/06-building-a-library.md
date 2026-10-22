# Building a Library

Build a folder of `.front` files into one npm package per framework. Apps install the packages like any other, with no multifront tools.

## Setting Up a Library

Put the components in `src/`, and name each package in `multifront.config.ts` beside the library's `package.json`.

`multifront.config.ts`

```ts
import {defineLibrary} from '@multifront/vite';

export default defineLibrary({
  packages: {react: {name: '@mf-fixture/ui-react'}, vue: {name: '@mf-fixture/ui-vue'}, svelte: {name: '@mf-fixture/ui-svelte'}},
});
```

The library installs what an app needs for each framework it builds ([Getting Started](01-getting-started.md#setting-up-vite)), plus the tools that write the types:

| Package | Version | For |
| --- | --- | --- |
| `typescript` | `^6.0.0` | every package's types |
| `@multifront/language-tools` | the same as `@multifront/vite` | React and Svelte types |
| `vue-tsc` | `^3.3.11` | Vue types |

## Running the Build

Run `mf-build` in the library folder. It reads `multifront.config.ts` (or `.js`, `.mjs`), writes one package per framework under `dist/` and prints one line.

```bash
pnpm exec mf-build
```

```
mf-build: built 3 packages in dist: vue 66 files, react 49 files (skipped VueOnly.front), svelte 31 files (skipped Badge.front, VueOnly.front)
```

A component with no block for a framework is left out of that package, and the line names it. `mf-build --help` lists every option.

### Output for Scripts and Coding Agents

`--format json` prints one JSON document instead, and nothing else on stdout:

```json
{
  "findings": [
    {
      "file": "src/Card.front",
      "code": "name-clash",
      "severity": "error",
      "message": "src/Card.front and src/card.ts would be written as Card.js and card.js, which macOS and Windows see as one file",
      "framework": "vue"
    }
  ],
  "errorCount": 1,
  "warningCount": 0,
  "packages": []
}
```

Each finding has the file, the code, the severity, the message and the `framework` whose build failed. An error at a spot in a file adds `line`, `column` and `end`, counted from 1 in the file you wrote, and `block` for the `.front` block it sits in. A clean run has no findings and lists each package's `framework`, `name`, `outDir`, file count and `skipped` components.

| Exit code | Means |
| --- | --- |
| `0` | Every package was built. |
| `1` | Errors in the library's files: each is a finding. |
| `2` | `mf-build` could not run: an unknown option, a bad config or a missing tool. One line on stderr, nothing on stdout, whatever `--format` says. |

## Build Options

Set options in `defineLibrary()`. Some also have a flag, which wins over the config.

| Option | Flag | Does | Default |
| --- | --- | --- | --- |
| `packages` | | Each package's `name`, and `peers` ranges added to or replacing the defaults | the library's name plus `-react`, `-vue` or `-svelte` |
| `frameworks` | `--framework <name>`, repeatable | Builds only these frameworks | every framework a component has a block for |
| `outDir` | `--out-dir <folder>` | Where the packages go, one folder per framework | `dist` |
| `dts` | `--no-dts` | `false` writes no `.d.ts` files and needs none of the type tools | `true` |
| `root` | `--root <folder>` | The library folder | the current folder |
| `src` | | The components folder | `src` |
| `index` | | The package's main entry, or `false` for none | `src/index.ts` when it exists |
| `vite` | | Vite config merged into every framework's build | |

## What Each Package Holds

Each component becomes its own file and keeps its folder: `src/forms/Field.front` becomes `forms/Field.js`, with its types and its CSS beside it.

![The .front files of src/ become a React, a Vue and a Svelte package, each with a code file, a .d.ts file and a CSS file per component](assets/library-packages.png)

| Package | Per component | Peer dependencies |
| --- | --- | --- |
| React | `Card.js`, `Card.d.ts`, `Card.css` | `react`, `react-dom` `^19.0.0` |
| Vue | `Card.js`, `Card.d.ts`, `Card.css` | `vue` `^3.5.0` |
| Svelte | `Card.svelte`, `Card.svelte.d.ts`, `Card.css` | `svelte` `^5.16.0` |

Each package also holds `index.js` from `src/index.ts`, the plain `.ts` files the components import as `.js`, `styles.css` with every component's CSS, and the library's `README.md` and `LICENSE`. Its `package.json` copies `version`, `description`, `license`, `author`, `repository`, `homepage` and `keywords` from the library's, and lists peer dependencies only.

> **Note:** The Svelte package ships each component uncompiled, as `svelte-package` does, so the app's own Svelte compiler builds it. Plain `.svelte` files and `.svelte.ts` modules the components import ship the same way, `.svelte.ts` as `.svelte.js` with its types stripped. Every shipped `.svelte` file goes through the preprocessors of the library's `svelte.config.js`.

## Using a Package in an App

Install the package, then import components from its main entry or each from its own path.

`App.vue`

```vue
<script setup lang="ts">
import {Button, Card, Counter} from '@mf-fixture/ui-vue';
import VueOnly from '@mf-fixture/ui-vue/VueOnly';
</script>

<template>
  <main>
    <Card title="Hello">
      <Counter />
    </Card>
    <VueOnly />
  </main>
</template>
```

| Package | Works in |
| --- | --- |
| React | Vite, Next.js App Router |
| Vue | Vite |
| Svelte | SvelteKit |

> **Tip:** One `src/index.ts` serves every package, so export from it only components with every framework's block. Import the others from their own path, as `VueOnly` here.

## Loading Every Style at Once

Each component's file imports its own CSS, so an app's bundle holds the CSS of the components it imports and no more. To load the CSS of every component, import `styles.css`.

`styles.ts`

```ts
import '@mf-fixture/ui-vue/styles.css';
import {createApp, h} from 'vue';
import {Card} from '@mf-fixture/ui-vue';

createApp({render: () => h(Card, {title: 'Styles'})}).mount('#app');
```

## Server Components in Next.js

A React component starts with `"use client"` when its `<react>` block calls a hook, has an event handler, calls `createContext` or defines a class component. So a Next.js server component can render every component of the package.

`app/page.tsx`

```tsx
import {Button, Card, Panel, Tooltip} from '@mf-fixture/ui-react';
import Field from '@mf-fixture/ui-react/forms/Field';

export default function Page() {
  return (
    <main>
      <Card title="Hello">
        <Panel heading="Inside" />
      </Card>
      <Button label="Go" className="extra" style={{color: 'red'}} />
      <Tooltip text="More">Hover me</Tooltip>
      <Field label="Name" />
    </main>
  );
}
```

> **Tip:** To mark a component that needs the browser in another way, start its `<react>` block with `'use client'`. That line is always kept.

## Fixing a Failed Build

`mf-build` stops at the first framework whose build fails. It prints each error of that build on one line, with its file, position and code, then a count:

```
src/Twice.front:7:1: error duplicate-target (react): <react> appears more than once; keep one
src/Twice.front:13:1: error duplicate-target (react): <react> appears more than once; keep one
mf-build: 2 errors in the react build
```

The codes are those of [Errors](07-errors.md) and the library errors below. A type error keeps its TypeScript code, `TS2322` say, and names a `.front` file without a line.

| Code | Message | Fix |
| --- | --- | --- |
| `not-a-peer` | `"left-pad" is imported by src/utils/cx.ts, but it is not a peer dependency of …` | Add the package to `packages.<framework>.peers`, so the app installs it, or drop the import. |
| `css-outside-style` | `src/utils/cx.css is imported by src/utils/cx.ts: a library package ships CSS from .front <style> blocks only` | Move the CSS into a `<style>` block. |
| `svelte-import` | `src/Card.front imports "~/utils/cx.js" in its <svelte> block: a shipped svelte file can import relative files and peers only`, or the same for a plain `src/Child.svelte` | Import the file by its relative path. |
| `outside-src` | `shared/tokens.ts is outside src: …` | Move the file into `src`. |
| `name-clash` | `src/Child.front and src/Child.svelte would both be written as Child.svelte`, `src/Icon.front and src/Icon.svelte.ts would both be written as Icon.svelte.d.ts`, `src/Badge.ts and src/Badge.front would both be written as Badge.js`, or the same as `Badge.d.ts` when `Badge.ts` is imported only with `import type` | Rename one of the two files. |
| `name-clash` | `src/Badge.front and src/badge.ts would be written as Badge.js and badge.js, which macOS and Windows see as one file`, or the same with names like `Child.svelte` and `child.svelte`, `Icon.svelte.d.ts` and `icon.svelte.d.ts`, or `Card.d.ts` and `card.d.ts` for a `card.ts` imported only with `import type` | Rename one of the two files, so their names differ by more than case. |
| `name-clash` | `src/Café.ts and src/Café.front would be written as Café.js and Café.js, which macOS sees as one file` | The two names have the same letters, with an accent typed two ways. Rename one of the two files. |
| `name-clash` | `src/styles.front would be written as styles.css, the name of the combined CSS file`, or `src/Styles.front would be written as Styles.css, which macOS and Windows see as styles.css, …` | Rename the component. |

These are setup errors: `mf-build` exits with code 2 and prints the message after `mf-build:`.

| Message | Fix |
| --- | --- |
| `the react types need typescript; install it, or set dts: false` | Install the package the message names in the library. |
| `src/Card.front: <style lang="less"> needs less; install it` | Install the preprocessor the message names in the library. |
| `package.json has no name; set packages.vue.name` | Name the library, or set that package's `name`. |
