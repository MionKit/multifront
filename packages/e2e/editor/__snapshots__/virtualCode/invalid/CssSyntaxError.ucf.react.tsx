
  export default function Note({ text }: { text: string } & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'p'>>}) {
    return <p className="note">{text}</p>
  }
