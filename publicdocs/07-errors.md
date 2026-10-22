# Errors

Every error in a `.front` file or an import has a code and a one-line message that names the problem. The build prints the file, line and column, and ends the message with the code: `(react-no-default-export)`. The [check commands](05-editor-setup.md#installing-the-check-commands) print the same codes.

> **Note:** Library build errors have their own codes, `name-clash` say. [Fixing a Failed Build](06-building-a-library.md#fixing-a-failed-build) lists them.

## Component File Errors

These mark a `.front` file that breaks a [block rule](02-component-files.md#block-rules).

| Code | Fix |
| --- | --- |
| `unknown-root-tag` | Use `<vue>`, `<react>`, `<svelte>` or `<style>`, or move the tag into a block. |
| `text-outside-block` | Move the text into a block or an HTML comment. If the message says a block closed early, write `<\/react>` for the `</react>` in its code. |
| `unclosed-block` | Add the closing tag, or the `>` or quote the message names. |
| `missing-target` | Add a `<vue>`, `<react>` or `<svelte>` block. |
| `duplicate-target` | Keep one block per framework. |
| `block-lang` | Write the `lang` the message names: `<vue lang="vue">`, `<react lang="tsx">` or `<svelte lang="html">`. |
| `react-not-last` | Move the `<react>` block to the end of the file. |
| `vue-empty-block` | Add a `<template>` or a `<script>` to the `<vue>` block. |
| `react-no-default-export` | Add `export default` to the component. A type-only export does not count. |
| `react-syntax-error` | Fix the syntax error the message names, inside the `<react>` block. |
| `svelte-parse-error` | Fix the syntax error the message names, inside the `<svelte>` block. |
| `missing-style-module` | Add the `<style module>` (for `$style`) or `<style module="name">` (for `$name`) the message names, or declare the store `name` in the block's `<script>`. |
| `style-inside-target` | Move the `<style>` block to the top level of the file. |
| `unknown-style-lang` | Use `css`, `scss`, `sass`, `less`, `styl`, `stylus` or `postcss`. |
| `duplicate-style-module` | Give each `<style module>` its own name. |
| `style-compile-error` | Fix the CSS or preprocessor error the message names, inside that `<style>` block. |
| `missing-preprocessor` | Install the preprocessor the message names (`sass`, `less` or `stylus`) in your project. `mf-build` stops with exit code 2. |
| `vue-only-style` | `v-bind()` and `:slotted()` work in `<vue>` only. Pass a CSS variable through the `style` prop instead of `v-bind()`; use `:deep()`, or style the content from the parent, instead of `:slotted()`. |

## Import Errors

These sit on the path of a `.front` import. [Imports](04-imports.md) says how an import picks its framework.

| Code | Fix |
| --- | --- |
| `framework-attribute-not-literal` | Write the `framework` value as a string literal: `with {framework: 'react'}`. |
| `framework-in-block` | Remove the `framework` attribute: an import in `<react>` always gets react, one in `<vue>` vue, one in `<svelte>` svelte. |
| `missing-target-block` | Add the block the import picks to the imported file, or pick a framework the file has. |
| `unknown-framework` | Use `vue`, `react` or `svelte` as the `framework` value. |
| `target-not-enabled` | Pick one of the frameworks the message names, or add this one to the `frameworks` option. |
| `no-target` | Add `with {framework: 'react'}`, import from a `.tsx` file, or set the `framework` option. |
| `mixed-frameworks` | A warning: one file imports the same path as two frameworks. Import each from its own small file that re-exports it. |

## Check Command Errors

`mf-tsc` reports TypeScript's codes, `TS2322` say, and `mf-lint` oxlint's, `eslint(no-debugger)` say. These codes are multifront's own:

| Code | Fix |
| --- | --- |
| `unformatted` | Run `mf-fmt` on the file. `mf-fmt --check` marks the first character that differs. |
| `format-error` | Fix the syntax error the message names, inside that block. `mf-fmt` leaves the file as written until then. |
| `missing-svelte` | A warning: oxfmt cannot load `svelte/compiler`, so `<svelte>` blocks stay as written. Add `svelte` to the project's devDependencies. |
| `lint-parse-error` | Fix the syntax error the message names, inside that block. |

These stop a command with exit code 2, one line on stderr after the command's name:

| Message | Fix |
| --- | --- |
| `oxlint is not installed in <folder>; add it to devDependencies`, or the same for `typescript`, `svelte` or `oxfmt` | Install the package the message names in the project. |
| `notes/Loose.ts is not part of tsconfig.json; add it to "include" or pass -p` | Add the file to that tsconfig, or pass the one that holds it with `-p`. |
| `react.ts is not a .front file; lint it with oxlint` | Run oxlint or oxfmt on it. `mf-lint` and `mf-fmt` take `.front` files only. |
| `old/Lint.front is ignored by .oxlintrc.json` | Remove the file from the config's `ignorePatterns`, or do not name it. |
| `ReactBreaks.front has no <svelte> block` | Pick a framework the file has a block for with `--framework`. |
| `empty holds no .front file` | Name a folder that holds `.front` files. |
