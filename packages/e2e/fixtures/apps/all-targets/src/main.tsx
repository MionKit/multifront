import {createRoot} from 'react-dom/client';
import {mount} from 'svelte';
import {createApp} from 'vue';
import Counter from '../../../components/Counter.front' with {framework: 'react'};
import ReactPanel from '../../../components/Panel.front' with {framework: 'react'};
import SveltePanel from '../../../components/Panel.front' with {framework: 'svelte'};
import VuePanel from '../../../components/Panel.front' with {framework: 'vue'};
// No <vue> block: a Svelte edit must never build the Vue target.
import NoStyle from '../../../components/svelte/NoStyle.front' with {framework: 'svelte'};
import Roots from '../Roots.front' with {framework: 'svelte'};
import Plain from './Plain.svelte';

// The root shapes page warns on purpose: kept off the page the HMR tests read the console of.
if (new URLSearchParams(location.search).get('page') === 'roots') mount(Roots, {target: document.getElementById('svelte')!});
else {
  createApp(VuePanel, {heading: 'Vue panel'}).mount('#vue');
  createRoot(document.getElementById('react')!).render(
    <>
      <ReactPanel heading="React panel" />
      <Counter start={2} />
    </>
  );
  mount(SveltePanel, {target: document.getElementById('svelte')!, props: {heading: 'Svelte panel'}});
  mount(NoStyle, {target: document.getElementById('no-style')!});
  mount(Plain, {target: document.getElementById('plain')!});
}
