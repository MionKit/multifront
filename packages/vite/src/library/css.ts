import {posix} from 'node:path';
import MagicString from 'magic-string';
import {isCSSRequest} from 'vite';
import type {Plugin, Rolldown} from 'vite';
import {splitId} from '../ids.ts';
import {fileKey, fileOf, outputName, shownFile} from './names.ts';

const STYLES = 'styles.css';

function isStyleId(id: string): boolean {
  const {path, query} = splitId(id);
  return path.endsWith('.ucf') && query.get('type') === 'style';
}

// The `.ucf` file of a component's own chunk (`/abs/Card.ucf` or `/abs/Card.ucf.react.tsx`), not a sub-module's.
function componentFile(id: string | null): string | undefined {
  if (!id || splitId(id).query.size > 0) return undefined;
  const file = fileOf(id);
  return file.endsWith('.ucf') ? file : undefined;
}

function cssName(file: string, src: string): string {
  return `${outputName(file, src)}.css`;
}

/** A `Card.css` per component, imported by `Card.js`; `styles.css` joins them all, dependencies first. */
export function libraryCss(root: string, src: string): Plugin {
  // `.ucf` files with a style block Vite's CSS step compiles (not our class map, a JS module).
  const styled = new Set<string>();
  // Keyed by Vite's CSS file of one `<style>` block.
  const blocks = new Map<string, {file: string; index: number}>();
  const shown = (file: string) => shownFile(root, file);
  return {
    name: 'multifront:library-css',
    enforce: 'post',
    config: () => ({build: {cssCodeSplit: true}}),
    renderStart() {
      styled.clear();
      blocks.clear();
      for (const id of this.getModuleIds()) {
        if (!isStyleId(id) || !isCSSRequest(id)) continue;
        const file = fileOf(id);
        const name = cssName(file, src);
        if (name === STYLES) {
          this.error(`buildLibrary: ${shown(file)} would be written as ${STYLES}, the name of the combined CSS file`);
        }
        if (fileKey(name) === fileKey(STYLES)) {
          this.error(
            `buildLibrary: ${shown(file)} would be written as ${name}, which macOS and Windows see as ${STYLES}, ` +
              'the combined CSS file'
          );
        }
        styled.add(file);
      }
    },
    // After `vite:css-post`: a style block's own chunk lists the CSS file it got.
    renderChunk(code, chunk) {
      const facade = chunk.facadeModuleId;
      const css = chunk.viteMetadata?.importedCss ?? new Set<string>();
      if (facade && css.size > 0) {
        if (!isStyleId(facade)) {
          const importer = this.getModuleInfo(facade)?.importers[0];
          const by = importer === undefined ? '' : ` is imported by ${shown(fileOf(importer))}`;
          this.error(`buildLibrary: ${shown(fileOf(facade))}${by}: a library package ships CSS from .ucf <style> blocks only`);
        }
        const index = Number(splitId(facade).query.get('index') ?? 0);
        for (const name of css) blocks.set(name, {file: fileOf(facade), index});
      }
      const file = componentFile(facade);
      if (!file || !styled.has(file)) return null;
      const magic = new MagicString(code);
      magic.prepend(`import "./${posix.basename(cssName(file, src))}";\n`);
      return {code: magic.toString(), map: magic.generateMap({hires: 'boundary'})};
    },
    generateBundle(_options, bundle) {
      const byFile = new Map<string, {index: number; css: string}[]>([...styled].map((file) => [file, []]));
      for (const [name, {file, index}] of blocks) {
        const asset = bundle[name];
        if (asset?.type !== 'asset') continue;
        const css = String(asset.source).trim();
        byFile.get(file)?.push({index, css: css && `${css}\n`});
        delete bundle[name];
      }
      const sources = new Map<string, string>();
      for (const [file, parts] of byFile) {
        const source = parts
          .sort((first, second) => first.index - second.index)
          .map(({css}) => css)
          .join('');
        const fileName = cssName(file, src);
        sources.set(fileName, source);
        this.emitFile({type: 'asset', fileName, source});
      }
      const ordered: string[] = [];
      const visited = new Set<string>();
      const visit = (chunk: Rolldown.OutputChunk) => {
        if (visited.has(chunk.fileName)) return;
        visited.add(chunk.fileName);
        for (const name of chunk.imports) {
          const imported = bundle[name];
          if (imported?.type === 'chunk') visit(imported);
        }
        const file = componentFile(chunk.facadeModuleId);
        if (chunk.viteMetadata) chunk.viteMetadata.importedCss = new Set();
        if (file && styled.has(file)) {
          ordered.push(cssName(file, src));
          chunk.viteMetadata?.importedCss.add(cssName(file, src));
        }
      };
      const chunks = Object.values(bundle).filter((output): output is Rolldown.OutputChunk => output.type === 'chunk');
      for (const chunk of chunks.sort((first, second) => (first.fileName < second.fileName ? -1 : 1))) visit(chunk);
      this.emitFile({type: 'asset', fileName: STYLES, source: ordered.map((name) => sources.get(name)).join('')});
    },
  };
}
