const options = {with: {framework: 'react'}};
// The inner import's options are no object literal: its error, never the outer import's.
export const Card = await import('../../components/Card.front', {
  with: {framework: 'react'},
  load: () => import('../../components/Badge.front', options),
});
