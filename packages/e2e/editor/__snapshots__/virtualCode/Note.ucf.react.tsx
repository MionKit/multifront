
  export default function Note({ tone = 'calm' }: { tone?: string } & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'p'>>}) {
    return <p className={`note ${tone}`} style={{ margin: 2, padding: 1 }}>note</p>
  }
