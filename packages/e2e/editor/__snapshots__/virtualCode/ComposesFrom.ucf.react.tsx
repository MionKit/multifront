
  export default function Tag({ label }: { label: string }) {
    return <span className={`${$style.tag} ${$style.chip} ${$style.pill}`}>{label}</span>
  }
declare const $style: {readonly tag: string; readonly chip: string; readonly pill: string};
