const options = {with: {framework: 'react'}};
const attributes = {framework: 'vue'};
const key = 'framework';
export const fromVariable = await import('../../components/Card.front', options);
export const withVariable = await import('../../components/Card.front', {with: attributes});
export const spread = await import('../../components/Card.front', {with: {...attributes}});
export const computed = await import('../../components/Card.front', {with: {[key]: 'svelte'}});
