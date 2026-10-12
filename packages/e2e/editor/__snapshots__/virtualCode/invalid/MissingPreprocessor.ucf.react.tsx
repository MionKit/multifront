
  export default function Pill({ label }: { label: string } & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'span'>>}) {
    return <span className="pill">{label}</span>
  }
