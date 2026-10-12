import {useEffect, useRef, useState} from 'react';
import Own from '../../../components/react/root-props/Own.ucf';
import Badge from '../../../library/src/Badge.ucf';
import Button from '../../../library/src/Button.ucf';

// Every root gets the parent's className, style and ref; each ref's element tag is written into the page.
export default function App() {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const ownRef = useRef<HTMLElement>(null);
  const [tags, setTags] = useState({button: '', own: ''});
  useEffect(() => setTags({button: buttonRef.current?.tagName ?? 'none', own: ownRef.current?.tagName ?? 'none'}), []);
  return (
    <main>
      <section data-case="button">
        <Button label="Press" className="extra" style={{color: 'red'}} ref={buttonRef} />
      </section>
      <section data-case="badge">
        <Badge label="New" className="extra" />
      </section>
      <section data-case="own">
        <Own branch="a" className="extra" style={{color: 'red'}} ref={ownRef} />
      </section>
      <output data-ref="button">{tags.button}</output>
      <output data-ref="own">{tags.own}</output>
    </main>
  );
}
