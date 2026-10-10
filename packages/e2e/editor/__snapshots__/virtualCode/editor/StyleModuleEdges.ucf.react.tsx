
  export default function StyleModuleEdges({ label }: { label: string }) {
    return (
      <section className={`${$style.card} ${$style.card__body} ${$style['card-title']}`}>
        <p className={`${theme['fade-in']} ${$style.wide}`}>{label}</p>
      </section>
    )
  }
declare const $style: {readonly card__body: string; readonly "card-title": string; readonly card: string; readonly inner: string; readonly muted: string; readonly wide: string};
declare const theme: {readonly accent: string; readonly fade: string; readonly "fade-in": string};
