
  export default function LessModule({ label }: { label: string } & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'p'>>}) {
    return <p className={$style.note}>{label}</p>
  }
declare const $style: {readonly [name: string]: string};
