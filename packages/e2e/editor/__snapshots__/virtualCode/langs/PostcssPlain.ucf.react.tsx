
  export default function PostcssPlain({ label }: { label: string } & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'em'>>}) {
    return <em className="note">{label}</em>
  }
