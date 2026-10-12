import type {Target} from '@multifront/core';
import type {LibraryTarget} from '../types.ts';

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
