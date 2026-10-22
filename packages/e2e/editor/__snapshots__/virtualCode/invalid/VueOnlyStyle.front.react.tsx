
  import type {ReactNode} from 'react'

  export default function VueOnlyStyle({children}: {children?: ReactNode} & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'div'>>}) {
    return <div className="box">{children}</div>
  }
