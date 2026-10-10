
  export default function Tag({ label }: { label: string }) {
    return <span className={`${$style.tag} ${$style.chip}`}>{label}</span>
  }
declare const $style: {readonly accent: string; readonly tag: string; readonly chip: string};
