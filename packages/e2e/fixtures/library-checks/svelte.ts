// Built into `<outDir>/svelte`, copied to `<outDir>/checks`: it imports the package by relative path.
import type {ComponentProps} from 'svelte';
import type Field from '../svelte/forms/Field.svelte';
import type {Button, Card, Counter, Panel, Tooltip} from '../svelte/index.js';

export const card: ComponentProps<typeof Card> = {title: 'Hello'};
// @ts-expect-error `titel` is no prop, and `title` is missing
export const wrongCard: ComponentProps<typeof Card> = {titel: 'x'};
export const button: ComponentProps<typeof Button> = {
  label: 'Press',
  class: ['extra', {active: true}],
  style: 'color: red',
  onclick: (event) => event.currentTarget.blur(),
};
// @ts-expect-error `label` is a string
export const wrongButton: ComponentProps<typeof Button> = {label: 1};
// @ts-expect-error the root's `style` is a string
export const wrongStyle: ComponentProps<typeof Button> = {label: 'Press', style: 1};
export const field: ComponentProps<typeof Field> = {label: 'Name'};
export const panel: ComponentProps<typeof Panel> = {heading: 'Panel'};
export const tooltip: ComponentProps<typeof Tooltip> = {text: 'tip'};
export const counter: ComponentProps<typeof Counter> = {};
