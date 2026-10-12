import {render as renderSvelte} from 'svelte/server';
import App from './App.svelte';

export function render(): string {
  return renderSvelte(App).body;
}
