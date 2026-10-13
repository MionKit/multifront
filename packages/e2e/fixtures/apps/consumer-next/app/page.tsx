// A server component (no directive): Counter, Button and Tooltip ship "use client", so they hydrate on their own.
import {Button, Card, Panel, Tooltip} from '@mf-fixture/ui-react';
import Field from '@mf-fixture/ui-react/forms/Field';

export default function Page() {
  return (
    <main>
      <Card title="Hello">
        <Panel heading="Inside" />
      </Card>
      <Button label="Go" className="extra" style={{color: 'red'}} />
      <Tooltip text="More">Hover me</Tooltip>
      <Field label="Name" />
    </main>
  );
}
