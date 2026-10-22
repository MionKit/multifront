# multifront for VS Code

Editor support for multifront component files (`.front`): highlighting in every block, the language server and the TypeScript plugin.

`.vue` files that import a `.front` component get its Vue type through Vue's own TypeScript plugin: install [Vue - Official](https://marketplace.visualstudio.com/items?itemName=Vue.volar) too.
`.svelte` files that import one need [Svelte for VS Code](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode)
and a `rootDirs` entry for the declarations it writes (see the editor setup docs).

Part of [multifront](https://github.com/MionKit/multifront): one component file, three frameworks.

> **Status:** early development.

## License

MIT
