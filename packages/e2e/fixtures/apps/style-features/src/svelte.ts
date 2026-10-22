import {mount} from 'svelte';
import Parent from '../Parent.front' with {framework: 'svelte'};

mount(Parent, {target: document.getElementById('app')!});
