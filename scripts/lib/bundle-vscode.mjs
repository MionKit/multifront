// The bundles use oxc-parser's wasm binding, which core parses <react> with, so one .vsix serves every platform.
import {copyFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {basename, dirname, join, resolve} from 'node:path';
import {build} from 'vite';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const EXTENSION_DIR = join(REPO_ROOT, 'packages', 'vscode');
const DIST = join(EXTENSION_DIR, 'dist');
// tsserver finds a plugin only as `<extension>/node_modules/<name>`.
const PACK = join(EXTENSION_DIR, 'node_modules', 'multifront-typescript-plugin-pack');
const WASM = 'parser.wasm32-wasi.wasm';

const fromExtension = createRequire(join(EXTENSION_DIR, 'package.json'));
const linked = (name) => realpathSync(join(EXTENSION_DIR, 'node_modules', '@multifront', name));
const fromCore = createRequire(join(linked('core'), 'package.json'));
const fromLanguageTools = createRequire(join(linked('language-tools'), 'package.json'));
const binding = fromExtension.resolve('@oxc-parser/binding-wasm32-wasi');
const oxcDir = dirname(fromCore.resolve('oxc-parser/package.json'));

function version(path) {
  return JSON.parse(readFileSync(path, 'utf8')).version;
}

// The wasm binding must match the oxc-parser core resolves.
const parserVersion = version(join(oxcDir, 'package.json'));
const bindingVersion = version(join(dirname(binding), 'package.json'));
if (parserVersion !== bindingVersion) {
  throw new Error(`oxc-parser ${parserVersion} needs @oxc-parser/binding-wasm32-wasi ${parserVersion}, found ${bindingVersion}`);
}

// svelte2tsx imports TypeScript and Svelte's compiler at load: neither ships in the .vsix.
const SVELTE2TSX_IMPORTS = {
  typescript: join(EXTENSION_DIR, 'src', 'bundle', 'hostTypeScript.ts'),
  'svelte/compiler': join(EXTENSION_DIR, 'src', 'bundle', 'noSvelteCompiler.ts'),
};
const fromSvelte2tsx = (importer) => importer?.split(/[\\/]/).includes('svelte2tsx') ?? false;
const svelte2tsxImports = {
  name: 'multifront:svelte2tsx-imports',
  enforce: 'pre',
  resolveId: (source, importer) => (fromSvelte2tsx(importer) ? SVELTE2TSX_IMPORTS[source] : undefined),
};

const ENTRIES = {
  extension: {entry: 'src/extension.ts', external: ['vscode']},
  // The bin other editors start, so the extension runs the same server.
  server: {entry: join(linked('language-tools'), 'bin', 'multifront-language-server.js'), external: []},
  'typescript-plugin': {entry: 'src/typescriptPlugin.ts', external: []},
};

for (const [name, {entry, external}] of Object.entries(ENTRIES)) {
  await build({
    root: EXTENSION_DIR,
    configFile: false,
    logLevel: 'warn',
    plugins: [svelte2tsxImports],
    resolve: {
      conditions: ['source'],
      alias: [
        {find: /^oxc-parser$/, replacement: join(oxcDir, 'src-js', 'wasm.js')},
        {find: /^@oxc-parser\/binding-wasm32-wasi$/, replacement: binding},
      ],
    },
    // Node built-ins stay imports.
    ssr: {noExternal: true, resolve: {conditions: ['source'], externalConditions: ['source']}},
    build: {
      outDir: DIST,
      emptyOutDir: false,
      minify: false,
      ssr: true,
      lib: {entry: resolve(EXTENSION_DIR, entry), formats: ['cjs']},
      rolldownOptions: {
        // Host provides `vscode`; tsserver hands the plugin TypeScript; only @volar/vscode's web path requires it.
        external: (id, importer) =>
          external.includes(id) || ((id === 'typescript' || id.startsWith('typescript/')) && !fromSvelte2tsx(importer)),
        // Volar's server loads a tsdk with `eval('require')`.
        checks: {eval: false},
        output: {entryFileNames: `${name}.cjs`, exports: name === 'typescript-plugin' ? 'default' : 'auto'},
      },
    },
  });
}

// parser.wasi.cjs reads the wasm next to the bundle that holds it.
copyFileSync(join(dirname(binding), WASM), join(DIST, WASM));

// Every Vue script references language-core's global types; the plugin's `vueTypesRoot` points here.
const vueTypes = join(dirname(fromLanguageTools.resolve('@vue/language-core/package.json')), 'types');
const VUE_TYPES = join(DIST, 'vue-types');
rmSync(VUE_TYPES, {recursive: true, force: true});
mkdirSync(VUE_TYPES, {recursive: true});
for (const name of readdirSync(vueTypes).filter((file) => file.endsWith('.d.ts'))) {
  copyFileSync(join(vueTypes, name), join(VUE_TYPES, name));
}

// Every Svelte script references svelte2tsx's shims; the plugin's `svelteTypesRoot` points here.
const svelte2tsxDir = dirname(fromLanguageTools.resolve('svelte2tsx/package.json'));
const SVELTE_TYPES = join(DIST, 'svelte-types');
rmSync(SVELTE_TYPES, {recursive: true, force: true});
mkdirSync(SVELTE_TYPES, {recursive: true});
for (const name of ['svelte-shims-v4.d.ts', 'svelte-jsx-v4.d.ts']) copyFileSync(join(svelte2tsxDir, name), join(SVELTE_TYPES, name));

rmSync(PACK, {recursive: true, force: true});
mkdirSync(PACK, {recursive: true});
const manifest = {name: basename(PACK), version: version(join(REPO_ROOT, 'version.json')), private: true, main: 'index.js'};
writeFileSync(join(PACK, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(PACK, 'index.js'), "module.exports = require('../../dist/typescript-plugin.cjs');\n");
