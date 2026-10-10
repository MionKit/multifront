
  export default function LessModule({ label }: { label: string }) {
    return <p className={$style.note}>{label}</p>
  }
declare const $style: {readonly [name: string]: string};
