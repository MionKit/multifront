
  import * as React from 'react'

  // No parameter: the build adds two, as React checks a forwardRef render function takes zero or two.
  export default React.memo(React.forwardRef<HTMLDivElement, {className?: string; style?: import('react').CSSProperties}>((__props: {className?: string; style?: import('react').CSSProperties}) => (
    <div className="shape"><span className="inner">memo forwardRef</span></div>
  )))
