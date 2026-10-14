
  export default function StylusPlain({ label }: { label: string } & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'span'>>}) {
    return <span className="chip">{label}</span>
  }
