
  export default function Meter({ value }: { value: number } & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'div'>>}) {
    return <div className={$style.meter}><span className={$style.bar}>{value}</span></div>
  }
declare const $style: {readonly meter: string; readonly bar: string};
