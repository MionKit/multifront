
  import type { ReactNode } from 'react'
  import PanelItem from './PanelItem.ucf'

  export default function Panel({ heading, children }: { heading: string; children?: ReactNode }) {
    return <section className="panel"><h3 className={`heading ${$style.title}`}>{heading}</h3><PanelItem label="first item" />{children}</section>
  }
declare const $style: {readonly title: string};
