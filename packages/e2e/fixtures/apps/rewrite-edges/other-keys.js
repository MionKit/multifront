import First from '../../components/Card.front' with {framework: 'react', type: 'component'};
import Last from '../../components/Card.front' with { type: 'component', framework: 'vue' };
import Middle from '../../components/Card.front' with {mode: 'a', framework: 'svelte', type: 'b',};
import Trailing from '../../components/Card.front' with {framework: 'react',};
import Quoted from "../../components/Card.front" with {'framework': "vue"};
import Quote from '../../components/Card.front' with {framework: "it's"};
import '../../components/Card.front' with {framework: 'react'};
export * as All from '../../components/Card.front' with {framework: 'svelte'};
import NotFront from './target.js' with {framework: 'react'};
import data from './data.json' with {type: 'json'};

export {data, First, Last, Middle, NotFront, Quote, Quoted, Trailing};
