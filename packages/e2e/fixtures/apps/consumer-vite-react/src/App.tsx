import {useEffect, useRef, useState} from 'react';
import {Button, Card, Counter} from '@mf-fixture/ui-react';

export default function App() {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [refTag, setRefTag] = useState('');
  useEffect(() => setRefTag(buttonRef.current?.tagName ?? 'none'), []);
  return (
    <main>
      <Card title="Hello">
        <Counter />
      </Card>
      <Button label="Go" className="extra" style={{color: 'red'}} ref={buttonRef} />
      <output id="button-ref">{refTag}</output>
    </main>
  );
}
