
  import { memo } from 'react'

  // An explicit `memo` type argument decides the export's props: the root props go there.
  export default memo<{ branch?: string } & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'div'>>}>(function MemoTyped(props) {
    return <div className="memo-typed">{props.branch}</div>
  })
