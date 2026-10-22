
  import type { ReactNode } from 'react'
  import PanelItem from './PanelItem.front'

  export default function Panel({ heading, children }: { heading: string; children?: ReactNode } & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'section'>>}) {
    return <section className="panel"><h3 className={`heading ${$style.title}`}>{heading}</h3><PanelItem label="first item" />{children}</section>
  }
declare const $style: {readonly title: string};
