import {styleInsideTarget} from '../diagnostics.ts';
import type {BlockKind} from '../types.ts';

// Like Vue's SFC parser: every root tag but `<template>` is raw text; a `<style>` inside `<template>` is markup.
export const vueKind: BlockKind = {
  tag: 'vue',
  role: 'target',
  grammar: {scopeName: 'text.html.vue', languageId: 'vue'}, // the official Vue extension's scope name
  check: (block, split) =>
    styleInsideTarget(
      block,
      split,
      (name) => name === 'template',
      (name) => name !== 'template'
    ),
};
