# Errors

Every multifront error has a code and a one-line message that names the problem.

## Component File Errors

These mark a `.ucf` file that breaks a [block rule](02-component-files.md#block-rules).

| Code | Fix |
| --- | --- |
| `unknown-root-tag` | Use `<vue>`, `<react>`, `<svelte>` or `<style>`, or move the tag into a block. |
| `text-outside-block` | Move the text into a block or an HTML comment. If the message says a block closed early, write `<\/react>` for the `</react>` in its code. |
| `unclosed-block` | Add the closing tag, or the `>` or quote the message names. |
| `missing-target` | Add a `<vue>`, `<react>` or `<svelte>` block. |
| `duplicate-target` | Keep one block per framework. |
| `react-no-default-export` | Add `export default` to the component. A type-only export does not count. |
| `react-syntax-error` | Fix the syntax error the message names, inside the `<react>` block. |
| `style-inside-target` | Move the `<style>` block to the top level of the file. |
| `unknown-style-lang` | Use `css`, `scss`, `sass`, `less`, `styl`, `stylus` or `postcss`. |
| `duplicate-style-module` | Give each `<style module>` its own name. |

## Import Errors

These sit on the path of a `.ucf` import. [Imports](04-imports.md) says how an import picks its framework.

| Code | Fix |
| --- | --- |
| `framework-in-block` | Remove the `framework` attribute: an import in `<react>` always gets react. |
| `missing-target-block` | Add the block the import picks to the imported file, or pick a framework the file has. |
| `unknown-framework` | Use `vue`, `react` or `svelte` as the `framework` value. |
| `target-not-enabled` | Pick one of the frameworks the message names, or add this one to the `frameworks` option. |
| `no-target` | Add `with {framework: 'react'}`, import from a `.tsx` file, or set the `framework` option. |
| `target-not-built` | The import picks vue or svelte, and the editor has types for React components only. The message names the rule that picked it. |
| `mixed-frameworks` | A warning: one file imports the same path as two frameworks. Import each from its own small file that re-exports it. |
