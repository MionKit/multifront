
  import type { ReactNode } from 'react'

  function ReactTypeOnlyDefaultForms(__props: {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'p'>>}) {
    return <p>Type-only default exports</p>
  }

  export { type ReactTypeOnlyDefaultForms as default }

  export default interface Props {
    label: string
  }

  type Label = string

  export { Label as default, ReactNode as default }
