import {useCallback, useEffect, useRef, useState} from 'react';
import Own from '../../../components/react/root-props/Own.ucf';
import Badge from '../../../library/src/Badge.ucf';
import Button from '../../../library/src/Button.ucf';

// Every root gets the parent's className, style and ref; each ref's element tag is written into the page.
export default function App() {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const ownTag = useRef('none');
  const ownRefs = useRef({attached: 0, cleaned: 0});
  // A callback ref with its own cleanup. It is stable, so the merged ref is too, and a re-render keeps it attached.
  const ownRef = useCallback((node: HTMLElement | null) => {
    ownTag.current = node?.tagName ?? 'none';
    ownRefs.current.attached++;
    return () => void ownRefs.current.cleaned++;
  }, []);
  const refCounts = useRef<HTMLOutputElement>(null);
  const [tags, setTags] = useState({button: '', own: ''});
  const [showOwn, setShowOwn] = useState(true);
  useEffect(() => setTags({button: buttonRef.current?.tagName ?? 'none', own: ownTag.current}), []);
  // After every commit, outside React's own output, so the server and the client render the same.
  useEffect(() => {
    refCounts.current!.dataset.counts = `${ownRefs.current.attached}/${ownRefs.current.cleaned}`;
  });
  return (
    <main>
      <section data-case="button">
        <Button label="Press" className="extra" style={{color: 'red'}} ref={buttonRef} />
      </section>
      <section data-case="badge">
        <Badge label="New" className="extra" />
      </section>
      <section data-case="own">
        {showOwn && <Own branch="a" className="extra" style={{color: 'red', padding: 8}} ref={ownRef} />}
      </section>
      <button data-action="hide-own" onClick={() => setShowOwn(false)}>
        Hide
      </button>
      <output data-ref="button">{tags.button}</output>
      <output data-ref="own">{tags.own}</output>
      <output data-ref="counts" ref={refCounts} />
    </main>
  );
}

// Never rendered: a ref typed for a <div> does not fit Button's <button> root, and the editor says so.
export function WrongRef() {
  const divRef = useRef<HTMLDivElement>(null);
  // @ts-expect-error Button's root is a <button>.
  return <Button label="Wrong" ref={divRef} />;
}
