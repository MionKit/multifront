import {renderToString} from 'react-dom/server';
import App from './App.tsx';

export function render(): string {
  return renderToString(<App />);
}
