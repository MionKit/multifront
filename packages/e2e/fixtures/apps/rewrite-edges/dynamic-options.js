export const kept = await import('../../components/Card.front', {with: {framework: 'react', type: 'x'}});
export const options = await import('../../components/Card.front', {with: {framework: 'vue'}, note: 'kept'});
export const after = await import('../../components/Card.front', {note: 'kept', with: {framework: 'svelte'}});
export const trailing = await import('../../components/Card.front', {with: {framework: 'svelte'},},);
export const multiline = await import(
  '../../components/Card.front',
  {
    with: {framework: 'react'}, // the only option
  }
);
export const template = await import(`../../components/Card.front`, {with: {framework: `react`}});
export const quoted = await import('../../components/Card.front', {'with': {'framework': 'vue'}});
export const noFramework = await import('../../components/Card.front', {with: {type: 'x'}});
export const noOptions = await import('../../components/Card.front');
export const notFront = await import('./target.js', {with: {framework: 'react'}});
// oxlint-disable-next-line no-dupe-keys
export const repeated = await import('../../components/Card.front', {with: {framework: 'react', type: 'x', framework: 'vue'}});
export const quote = await import('../../components/Card.front', {with: {framework: "it's"}});
export const loneSurrogate = await import('../../components/Card.front', {with: {framework: '\uD800'}});
