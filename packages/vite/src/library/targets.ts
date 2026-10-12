import type {Target} from '@multifront/core';
import type {LibraryTarget} from '../types.ts';

// Imported on use: the framework plugins and the type tools are optional peers of this package.
export const libraryTargets = {
  react: {
    plugin: async () => (await import('@vitejs/plugin-react')).default(),
    peers: {react: '^19.0.0', 'react-dom': '^19.0.0'},
    useClient: true,
    emitTypes: async (job) => (await import('./types.ts')).emitReactTypes(job),
  },
  vue: {
    plugin: async () => (await import('@vitejs/plugin-vue')).default(),
    peers: {vue: '^3.5.0'},
    emitTypes: async (job) => (await import('./types.ts')).emitVueTypes(job),
  },
} satisfies Partial<Record<Target, LibraryTarget>>;
