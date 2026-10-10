
  export default function StyleModuleEdges({ label }: { label: string }) {
    return (
      <section className={`${$style.card} ${$style.card__body} ${$style['card-title']}`}>
        <p className={`${theme['fade-in']} ${$style.wide}`}>{label}</p>
      </section>
    )
  }
declare const $style: {readonly card__body: string; readonly card: string; readonly "card-title": string; readonly inner: string; readonly muted: string; readonly wide: string; readonly "dot.ted": string; readonly dot: string; readonly ted: string};
declare const theme: {readonly accent: string; readonly gap: string; readonly x: string; readonly z: string; readonly fade: string; readonly slide: string; readonly pop: string; readonly "fade-in": string; readonly primary: string};
declare const rows: {readonly row: string; readonly row__cell: string; readonly "row-end": string};
