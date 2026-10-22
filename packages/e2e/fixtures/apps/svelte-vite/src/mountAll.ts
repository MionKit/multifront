import {mount} from 'svelte';
import Panel from '../../../components/Panel.front' with {framework: 'svelte'};
import App from './App.svelte';

const target = document.getElementById('app')!;
mount(App, {target});
mount(Panel, {target, props: {heading: 'Svelte panel'}});
