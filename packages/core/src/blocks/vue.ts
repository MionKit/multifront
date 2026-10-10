import {styleInsideTarget} from '../diagnostics.ts';
import type {BlockKind} from '../types.ts';

// Like Vue's SFC parser: every root tag but `<template>` is raw text, and a `<style>` inside `<template>` is markup.
export const vueKind: BlockKind = {
  tag: 'vue',
  role: 'target',
  check: (block, split) =>
    styleInsideTarget(
      block,
      split,
      (name) => name === 'template',
      (name) => name !== 'template'
    ),
};
