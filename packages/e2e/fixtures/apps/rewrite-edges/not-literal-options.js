const options = {with: {framework: 'react'}};
const attributes = {framework: 'vue'};
const key = 'framework';
export const fromVariable = await import('../../components/Card.ucf', options);
export const withVariable = await import('../../components/Card.ucf', {with: attributes});
export const spread = await import('../../components/Card.ucf', {with: {...attributes}});
export const computed = await import('../../components/Card.ucf', {with: {[key]: 'svelte'}});
