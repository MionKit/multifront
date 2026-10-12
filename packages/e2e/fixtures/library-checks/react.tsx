// Built into `<outDir>/react`, copied to `<outDir>/checks`: it imports the package by relative path.
import {useRef} from 'react';
import Badge from '../react/Badge.js';
import Field from '../react/forms/Field.js';
import {Button, Card, Counter, Panel, Tooltip} from '../react/index.js';

export function Uses() {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const divRef = useRef<HTMLDivElement>(null);
  return (
    <Card title="Hello" className="extra" style={{color: 'red'}}>
      <Counter />
      <Panel heading="Panel" />
      <Tooltip text="tip">hover</Tooltip>
      <Field label="Name" />
      <Badge label="new" className="badge-extra" />
      <Button label="Press" className="extra" style={{color: 'red'}} ref={buttonRef} onClick={(event) => event.currentTarget.blur()} />
      {/* @ts-expect-error `titel` is no prop, and `title` is missing */}
      <Card titel="x" />
      {/* @ts-expect-error Button's root is a <button>, not a <div> */}
      <Button label="Press" ref={divRef} />
    </Card>
  );
}
