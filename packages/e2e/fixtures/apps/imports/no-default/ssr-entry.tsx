import {renderToString} from 'react-dom/server';
import Card from '../../../components/Card.ucf' with {framework: 'react'};

export function render(): string {
  return renderToString(<Card title="Hello" />);
}
