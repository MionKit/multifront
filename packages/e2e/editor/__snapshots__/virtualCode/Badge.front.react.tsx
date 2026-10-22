
  export default function Badge({ label }: { label: string } & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'span'>>}) {
    return <span className="badge">{label}</span>
  }
