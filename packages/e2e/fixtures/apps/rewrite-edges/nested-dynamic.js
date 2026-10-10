const options = {with: {framework: 'react'}};
// The inner import's options are no object literal: its error, never the outer import's.
export const Card = await import('../../components/Card.ucf', {
  with: {framework: 'react'},
  load: () => import('../../components/Badge.ucf', options),
});
