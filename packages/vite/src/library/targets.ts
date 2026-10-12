import type {Target} from '@multifront/core';
import type {PluginOption} from 'vite';

/** What differs per framework in a library build. */
export interface LibraryTarget {
  plugin(): Promise<PluginOption>; // the framework's Vite plugin
  peers: Record<string, string>; // default peer ranges; also the build's externals
}

// Imported on use: the framework plugins are optional peers of this package.
export const libraryTargets = {
  react: {
    plugin: async () => (await import('@vitejs/plugin-react')).default(),
    peers: {react: '^19.0.0', 'react-dom': '^19.0.0'},
  },
  vue: {
    plugin: async () => (await import('@vitejs/plugin-vue')).default(),
    peers: {vue: '^3.5.0'},
  },
} satisfies Partial<Record<Target, LibraryTarget>>;
