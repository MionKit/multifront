
  import { useState } from 'react'

  export default function Counter({start = 0}: {start?: number}) {
    const [count, setCount] = useState(start)
    return (
      <div className="counter">
        <span className="label">Clicks</span>
        <button className={$style.button} onClick={() => setCount(count + 1)}>{count}</button>
      </div>
    )
  }
declare const $style: {readonly button: string};
