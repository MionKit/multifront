import First from '../../components/Card.ucf' with {framework: 'react', type: 'component'};
import Last from '../../components/Card.ucf' with { type: 'component', framework: 'vue' };
import Middle from '../../components/Card.ucf' with {mode: 'a', framework: 'svelte', type: 'b',};
import Trailing from '../../components/Card.ucf' with {framework: 'react',};
import Quoted from "../../components/Card.ucf" with {'framework': "vue"};
import '../../components/Card.ucf' with {framework: 'react'};
export * as All from '../../components/Card.ucf' with {framework: 'svelte'};
import NotUcf from './target.js' with {framework: 'react'};
import data from './data.json' with {type: 'json'};

export {data, First, Last, Middle, NotUcf, Quoted, Trailing};
