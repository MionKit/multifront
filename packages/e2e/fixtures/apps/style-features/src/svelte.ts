import {mount} from 'svelte';
import Parent from '../Parent.ucf' with {framework: 'svelte'};

mount(Parent, {target: document.getElementById('app')!});
