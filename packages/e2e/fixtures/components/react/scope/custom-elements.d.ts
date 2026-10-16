// Stamped.ucf renders a custom element, which React's JSX types do not know.
import type {HTMLAttributes} from 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'my-el': HTMLAttributes<HTMLElement> & {class?: string};
    }
  }
}
