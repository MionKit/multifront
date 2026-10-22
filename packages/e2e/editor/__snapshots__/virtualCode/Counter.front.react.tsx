
  import { useState } from 'react'

  export default function Counter({start = 0}: {start?: number} & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'div'>>}) {
    const [count, setCount] = useState(start)
    return (
      <div className="counter">
        <span className="label">Clicks</span>
        <button className={$style.button} title="Zähler 𝄞" onClick={() => setCount(count + 1)}>{count}</button>
      </div>
    )
  }
declare const $style: {readonly button: string};
