import {createUcfLanguagePlugin} from '@multifront/language-tools';
import {startServer} from '@multifront/language-tools/server';
import type {ServerOptions} from '@multifront/language-tools/server';

// `typescript` is Volar's augmentation: it typechecks only when the built types keep it.
export const extensions: string[] = createUcfLanguagePlugin().typescript!.extraFileExtensions.map(({extension}) => extension);

// The `./server` subpath resolves to its built types too, with the options a host bundling the server sets.
export const options: ServerOptions = {svelteTypesRoot: '/svelte-types', onTypeScript: (ts) => void ts.version};
export const start: (options?: ServerOptions) => void = startServer;
