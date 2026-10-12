import {mount} from 'svelte';
import Counter from '../../../components/Counter.ucf' with {framework: 'svelte'};
import Panel from '../../../components/Panel.ucf' with {framework: 'svelte'};

const target = document.getElementById('app')!;
mount(Panel, {target, props: {heading: 'Svelte panel'}});
mount(Counter, {target, props: {start: 1}});
