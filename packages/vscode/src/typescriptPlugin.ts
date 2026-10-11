import {join} from 'node:path';
import {createTypeScriptPlugin} from '@multifront/language-tools/typescript-plugin';

// Bundled to `module.exports = <factory>`: tsserver skips a module that is not a function.
// Bundled, language-core's own `types/` path is gone: `pnpm devx vsix` copies them beside the bundle.
export default createTypeScriptPlugin({vueTypesRoot: join(import.meta.dirname, 'vue-types')});
