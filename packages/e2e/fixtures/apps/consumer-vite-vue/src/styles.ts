import '@mf-fixture/ui-vue/styles.css';
import {createApp, h} from 'vue';
import {Card} from '@mf-fixture/ui-vue';

createApp({render: () => h(Card, {title: 'Styles'})}).mount('#app');
