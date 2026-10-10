export const kept = await import('../../components/Card.ucf', {with: {framework: 'react', type: 'x'}});
export const options = await import('../../components/Card.ucf', {with: {framework: 'vue'}, note: 'kept'});
export const after = await import('../../components/Card.ucf', {note: 'kept', with: {framework: 'svelte'}});
export const trailing = await import('../../components/Card.ucf', {with: {framework: 'svelte'},},);
export const multiline = await import(
  '../../components/Card.ucf',
  {
    with: {framework: 'react'}, // the only option
  }
);
export const template = await import(`../../components/Card.ucf`, {with: {framework: `react`}});
export const quoted = await import('../../components/Card.ucf', {'with': {'framework': 'vue'}});
export const noFramework = await import('../../components/Card.ucf', {with: {type: 'x'}});
export const noOptions = await import('../../components/Card.ucf');
export const notUcf = await import('./target.js', {with: {framework: 'react'}});
