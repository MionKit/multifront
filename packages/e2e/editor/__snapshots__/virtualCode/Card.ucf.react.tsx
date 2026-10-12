
  export default function Card({ title }: { title: string } & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'div'>>}) {
    return <div className={$style.card}><h2>{title}</h2></div>
  }
declare const $style: {readonly card: string};
