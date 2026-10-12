
  export default function Tag({ label }: { label: string } & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'span'>>}) {
    return <span className={`${$style.tag} ${$style.chip}`}>{label}</span>
  }
declare const $style: {readonly accent: string; readonly tag: string; readonly chip: string};
