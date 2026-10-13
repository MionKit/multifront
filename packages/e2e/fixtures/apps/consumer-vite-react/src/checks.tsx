// Type checked, never bundled.
import {Card} from '@mf-fixture/ui-react';

export function WrongProp() {
  // @ts-expect-error: Card takes `title`, not `titel`.
  return <Card titel="x" />;
}
