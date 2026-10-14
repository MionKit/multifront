import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {mount} from 'svelte';
import {createApp} from 'vue';
import ReactParent from '../Parent.ucf' with {framework: 'react'};
import SvelteParent from '../Parent.ucf' with {framework: 'svelte'};
import VueParent from '../Parent.ucf' with {framework: 'vue'};

// One parent per framework, each rendering the same children the same way.
createApp(VueParent).mount('#vue');
createRoot(document.getElementById('react')!).render(createElement(ReactParent));
mount(SvelteParent, {target: document.getElementById('svelte')!});
