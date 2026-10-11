import {createApp} from 'vue';
// A `.ts` importer has no default framework: only the attribute picks vue.
import Counter from '../../../components/Counter.ucf' with {framework: 'vue'};

createApp(Counter).mount('#vue');
