import {createRoot} from 'react-dom/client';
import {mount} from 'svelte';
import {createApp} from 'vue';
import Counter from '../../../components/Counter.ucf' with {framework: 'react'};
import ReactPanel from '../../../components/Panel.ucf' with {framework: 'react'};
import SveltePanel from '../../../components/Panel.ucf' with {framework: 'svelte'};
import VuePanel from '../../../components/Panel.ucf' with {framework: 'vue'};

createApp(VuePanel, {heading: 'Vue panel'}).mount('#vue');
createRoot(document.getElementById('react')!).render(
  <>
    <ReactPanel heading="React panel" />
    <Counter start={2} />
  </>
);
mount(SveltePanel, {target: document.getElementById('svelte')!, props: {heading: 'Svelte panel'}});
