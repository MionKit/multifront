# Errors

Every multifront error has a code and a one-line message that names the problem. The build prints the file, line and column, and ends the message with the code: `(react-no-default-export)`.

## Component File Errors

These mark a `.ucf` file that breaks a [block rule](02-component-files.md#block-rules).

| Code | Fix |
| --- | --- |
| `unknown-root-tag` | Use `<vue>`, `<react>`, `<svelte>` or `<style>`, or move the tag into a block. |
| `text-outside-block` | Move the text into a block or an HTML comment. If the message says a block closed early, write `<\/react>` for the `</react>` in its code. |
| `unclosed-block` | Add the closing tag, or the `>` or quote the message names. |
| `missing-target` | Add a `<vue>`, `<react>` or `<svelte>` block. |
| `duplicate-target` | Keep one block per framework. |
| `vue-empty-block` | Add a `<template>` or a `<script>` to the `<vue>` block. |
| `react-no-default-export` | Add `export default` to the component. A type-only export does not count. |
| `react-syntax-error` | Fix the syntax error the message names, inside the `<react>` block. |
| `style-inside-target` | Move the `<style>` block to the top level of the file. |
| `unknown-style-lang` | Use `css`, `scss`, `sass`, `less`, `styl`, `stylus` or `postcss`. |
| `duplicate-style-module` | Give each `<style module>` its own name. |
| `style-compile-error` | Fix the CSS or preprocessor error the message names, inside that `<style>` block. |

## Import Errors

These sit on the path of a `.ucf` import. [Imports](04-imports.md) says how an import picks its framework.

| Code | Fix |
| --- | --- |
| `framework-attribute-not-literal` | Write the `framework` value as a string literal: `with {framework: 'react'}`. |
| `framework-in-block` | Remove the `framework` attribute: an import in `<react>` always gets react, one in `<vue>` vue. |
| `missing-target-block` | Add the block the import picks to the imported file, or pick a framework the file has. |
| `unknown-framework` | Use `vue`, `react` or `svelte` as the `framework` value. |
| `target-not-enabled` | Pick one of the frameworks the message names, or add this one to the `frameworks` option. |
| `no-target` | Add `with {framework: 'react'}`, import from a `.tsx` file, or set the `framework` option. |
| `target-not-built` | Pick react or vue: multifront does not build `<svelte>` blocks. In the editor, TypeScript has types for react and vue picks only; the message names the rule that picked svelte. |
| `mixed-frameworks` | A warning: one file imports the same path as two frameworks. Import each from its own small file that re-exports it. |
