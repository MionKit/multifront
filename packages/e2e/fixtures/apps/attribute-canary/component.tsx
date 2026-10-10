import target from './target.js' with {framework: 'react'};
export {named as renamed} from './target.js' with {framework: 'react'};
export * from './target.js' with {framework: 'react'};

export const lazy = () => import('./target.js', {with: {framework: 'react'}});

export default function Component() {
  return <p>{target}</p>;
}
