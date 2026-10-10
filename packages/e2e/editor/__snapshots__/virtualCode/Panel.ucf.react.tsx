
  import type { ReactNode } from 'react'

  export default function Panel({ heading, children }: { heading: string; children?: ReactNode }) {
    return <section className="panel"><h3 className="heading">{heading}</h3>{children}</section>
  }
