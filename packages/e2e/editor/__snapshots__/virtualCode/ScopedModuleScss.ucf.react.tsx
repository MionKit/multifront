
  export default function Meter({ value }: { value: number }) {
    return <div className={$style.meter}><span className={$style.bar}>{value}</span></div>
  }
declare const $style: {readonly meter: string; readonly bar: string};
