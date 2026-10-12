
  export default function Tag({ label }: { label: string } & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'span'>>}) {
    return <span className={$style.tag}>{label}</span>
  }
declare const $style: {readonly tag: string};
