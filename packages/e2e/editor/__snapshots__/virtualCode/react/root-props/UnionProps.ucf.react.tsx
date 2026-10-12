
  // A union props type: the root props join every member, not only the last.
  export default function UnionProps(props: ({ kind: 'a' } | { kind: 'b'; note: string }) & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'div'>>}) {
    return <div className="union">{props.kind === 'b' ? props.note : props.kind}</div>
  }
